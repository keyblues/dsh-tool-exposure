/**
 * Live end-to-end check for MCP prompt suppression.
 *
 * Boots the real `dsh headless` one-shot profile with this plugin installed,
 * two real stdio MCP fixture servers (both sending instructions), and a local
 * mock model endpoint that records the exact request DSH sends.
 *
 * Headless sessions compose no agent preset (the runner creates a bare agent),
 * so the two runs cover the unbound-role paths:
 *   - control run: the default open fallback reproduces the upstream pollution
 *     (server listing plus per-server instructions in the system prompt);
 *   - closed run: `unlisted: closed` hides every managed tool and every MCP
 *     prompt section, and the actual model request carries none of them.
 *
 * Role-bound group policies over the real SystemPrompt assembly are covered by
 * test/registry-integration.mjs instead.
 *
 * Run: node test/prompt-live.mjs
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire, registerHooks } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { copyPluginToProfile, removeTestHome } from './isolated-profile.mjs';

const ownFile = fileURLToPath(import.meta.url);
const project = dirname(dirname(ownFile));

/* Windows: re-exec under the bundled Electron as an asar-aware Node. */
const desktopExe = process.env.DSH_NODE_EXECUTABLE
  || join(process.env.LOCALAPPDATA || '', 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe');
const useDesktopRuntime = process.env.DSH_NODE_EXECUTABLE || !process.env.DSH_TEST_INSTALL_DIR;
if (process.platform === 'win32' && !process.versions.electron && useDesktopRuntime && existsSync(desktopExe)) {
  const result = spawnSync(desktopExe, [ownFile], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', windowsHide: true, timeout: 240000,
  });
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

const anchor = process.env.DSH_TEST_INSTALL_DIR
  || (process.versions.electron ? join(dirname(process.execPath), 'resources', 'app.asar', 'dsh') : '');
const installed = createRequire(join(anchor || process.cwd(), 'package.json'));
let cliManifestPath;
try {
  cliManifestPath = installed.resolve('@deepseek-ai/dsh/package.json');
} catch {
  console.log('SKIP prompt live: the DSH CLI is not installed with the runtime dependencies.');
  process.exit(0);
}
const cliManifest = JSON.parse(readFileSync(cliManifestPath, 'utf8'));
assert.equal(cliManifest.name, '@deepseek-ai/dsh');
const cliBin = join(dirname(cliManifestPath), cliManifest.bin.dsh);
const packageName = 'dsh-tool-exposure';
const taskPrompt = 'Reply with exactly: done';
const profilePrefix = 'dsh-tool-exposure-live-';

/* Resolve the plugin's own imports the same way the other integration checks do. */
let toolsEntry;
try { toolsEntry = installed.resolve('@deepseek-ai/dsh-tools'); }
catch {
  console.log('SKIP prompt live: dsh-tools is unavailable.');
  process.exit(0);
}
const peers = new Map([['@deepseek-ai/dsh-tools', pathToFileURL(toolsEntry).href]]);
registerHooks({
  resolve(specifier, context, next) {
    if (peers.has(specifier)) return { url: peers.get(specifier), shortCircuit: true };
    return next(specifier, context);
  },
});

const taskHome = mkdtempSync(join(tmpdir(), profilePrefix));
const profile = join(taskHome, 'profiles', 'prompt-live');
const fixtureDir = join(taskHome, 'mcp');
const workDir = join(taskHome, 'work');
mkdirSync(fixtureDir);
mkdirSync(workDir);

/* ------------------------- mock model endpoint ------------------------- */

const requests = [];
const mock = createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    let body = null;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { /* keep going: every request still gets a valid answer */ }
    requests.push({ url: req.url, body });
    if (body?.stream === true) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (delta, finish) =>
        `data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', created: 0, model: 'mock-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      res.write(chunk({ role: 'assistant', content: 'done' }, null));
      res.write(chunk({}, 'stop'));
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'mock', object: 'chat.completion', created: 0, model: 'mock-model',
      choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
  });
});
await new Promise((ready) => mock.listen(0, '127.0.0.1', ready));
const mockPort = mock.address().port;

/* --------------------------- profile assembly --------------------------- */

function mcpFixtureSource(label, instructions) {
  return `const readline = require('node:readline');
const inputSchema = { type: 'object', properties: {} };
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return;
  const results = {
    initialize: {
      protocolVersion: params?.protocolVersion,
      capabilities: { tools: {} },
      instructions: ${JSON.stringify(instructions)},
      serverInfo: { name: ${JSON.stringify(label)}, version: '1.0.0' },
    },
    ping: {},
    'tools/list': { tools: [{ name: 'lookup', inputSchema }, { name: 'status', inputSchema }] },
  };
  const reply = Object.hasOwn(results, method)
    ? { result: results[method] }
    : { error: { code: -32601, message: 'Method not found' } };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, ...reply }) + '\\n');
});
`;
}

const docsFixture = join(fixtureDir, 'docs-server.cjs');
const archiveFixture = join(fixtureDir, 'archive-server.cjs');
writeFileSync(docsFixture, mcpFixtureSource('fixture__docs', 'Fixture Docs instructions: search the documentation index.'));
writeFileSync(archiveFixture, mcpFixtureSource('fixture-archive', 'Fixture Archive instructions: read archived records.'));

const { initProfile } = await import(pathToFileURL(installed.resolve('@deepseek-ai/dsh-app-boot')).href);
mkdirSync(join(profile, 'node_modules'), { recursive: true });
initProfile(profile, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless', packageName]);
const manifestPath = join(profile, 'package.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const pluginVersion = copyPluginToProfile(project, profile);
writeFileSync(manifestPath, JSON.stringify({
  ...manifest,
  dependencies: { ...(manifest.dependencies ?? {}), [packageName]: pluginVersion },
}));

const transportFor = (file) => ({
  transport: 'stdio',
  command: process.execPath,
  args: [file],
  cwd: fixtureDir,
  env: { ELECTRON_RUN_AS_NODE: '1' },
  startupTimeoutMs: 20000,
  reconnect: { enabled: false },
});

writeFileSync(join(profile, 'cordis.patch.yml'), JSON.stringify([
  {
    insert: [
      {
        id: 'live-mcp-docs',
        name: '@deepseek-ai/dsh-mcp-client',
        config: { ...transportFor(docsFixture), serverName: 'fixture__docs', failOnStartupError: true },
      },
      {
        id: 'live-mcp-archive',
        name: '@deepseek-ai/dsh-mcp-client',
        config: { ...transportFor(archiveFixture), serverName: 'fixture-archive', failOnStartupError: true },
      },
    ],
  },
  {
    id: 'llm-pi-ai',
    config: {
      providers: {
        mock: {
          displayName: 'Mock',
          apiKeyEnv: 'MOCK_API_KEY',
          api: 'openai-completions',
          baseURL: `http://127.0.0.1:${mockPort}/v1`,
          models: [{ id: 'mock-model', name: 'Mock Model', contextWindow: 131072, maxTokens: 4096, input: ['text'] }],
        },
      },
    },
  },
  { id: 'agent-default-model', config: { provider: 'mock', model: 'mock-model' } },
]));

// The closed run flips the unbound-role fallback: every managed tool and every
// MCP prompt contribution is hidden for sessions no role entry claims.
const closeAllOverlay = join(taskHome, 'close-all.yml');
writeFileSync(closeAllOverlay, JSON.stringify([
  { id: 'tool-exposure', config: { unlisted: 'closed' } },
]));

/* ------------------------------ one-shot run --------------------------- */

/* Diagnostics mode: print the composed rows relevant to this check and exit. */
if (process.env.DSH_PROMPT_LIVE_DUMP) {
  const child = spawn(process.execPath, [cliBin, '--profile', 'prompt-live', '--dump-config'], {
    cwd: workDir, windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: taskHome },
  });
  let dump = '';
  child.stdout.on('data', (chunk) => { dump += chunk; });
  child.stderr.on('data', (chunk) => { process.stderr.write(chunk); });
  await new Promise((done) => child.on('close', done));
  const lines = dump.split('\n');
  const printBlocks = ['- id: tool-exposure\n', '- id: agent-preset\n', '- id: agent-default-model\n', '- id: headless-runner\n'];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/preset/i.test(line) && !line.startsWith(' ')) {
      console.log('>>> ' + line.slice(0, 300));
      continue;
    }
    if (printBlocks.some((block) => line.trim() === block.trim())) {
      console.log('>>> ' + line);
      let depth = 0;
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j];
        if (next.startsWith('- id:') || next.startsWith('# ==') || (next.startsWith(' ') === false && next.trim() !== '')) break;
        console.log(next.slice(0, 300));
        depth += 1;
        if (depth > 40) break;
      }
    }
  }
  process.exit(0);
}

/* Diagnostics mode: also run one task and surface loader/plugin warnings. */
if (process.env.DSH_PROMPT_LIVE_TRACE) {
  const child = spawn(process.execPath, [cliBin, '--profile', 'prompt-live', taskPrompt], {
    cwd: workDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: taskHome,
      MOCK_API_KEY: 'mock-key', DSH_TELEMETRY_DISABLED: '1',
    },
  });
  child.stdout.on('data', (chunk) => process.stdout.write('[out] ' + chunk));
  child.stderr.on('data', (chunk) => {
    for (const line of chunk.toString().split('\n')) {
      if (line.trim() === '') continue;
      if (/preset|tool-exposure|mcp|agent|error|warn/i.test(line)) console.log('[err] ' + line.slice(0, 240));
    }
  });
  await new Promise((done) => child.on('close', done));
  process.exit(0);
}

async function runHeadless(label, extraArgs) {
  const before = requests.length;
  const child = spawn(process.execPath, [
    cliBin, '--profile', 'prompt-live', ...extraArgs, taskPrompt,
  ], {
    cwd: workDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      DSH_HOME: taskHome,
      MOCK_API_KEY: 'mock-key',
      DSH_TELEMETRY_DISABLED: '1',
    },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const deadline = Date.now() + 120000;
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await delay(200);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill();
    assert.fail(`${label}: the headless run did not finish in time\n${stdout}\n${stderr}`);
  }
  // The host may also send a session-title request to this endpoint.
  const captured = requests.slice(before).filter(({ body }) => Array.isArray(body?.messages) && body.messages.some((message) => {
    if (message.role !== 'user') return false;
    if (typeof message.content === 'string') return message.content.trim() === taskPrompt;
    return Array.isArray(message.content) && message.content.some((part) => part.type === 'text' && part.text?.trim() === taskPrompt);
  }));
  const failure = `${label}: headless exit ${child.exitCode}\n${stdout.slice(0, 2000)}\n${stderr.slice(0, 4000)}`;
  assert.equal(child.exitCode, 0, failure);
  assert.ok(captured.length > 0, `${label}: no model request reached the mock endpoint\n${failure}`);
  return captured[0].body;
}

/* ------------------------------ assertions ----------------------------- */

/** OpenAI-style tool entries carry the name under `function`. */
function toolNamesOf(request) {
  return new Set((request.tools ?? []).map((tool) => tool.name ?? tool.function?.name).filter(Boolean));
}

function systemPromptOf(request) {
  const system = request.messages.find((message) => message.role === 'system');
  assert.ok(typeof system?.content === 'string' && system.content !== '', 'the request carries a system prompt');
  return system.content;
}

function assertUpstreamPolicy(request) {
  const prompt = systemPromptOf(request);
  const tools = toolNamesOf(request);
  // The unbound role keeps the host default: the exact pollution this plugin removes.
  assert.ok(prompt.includes('## MCP resource servers'), 'server listing present by default');
  assert.ok(prompt.includes('["fixture-archive","fixture__docs"]'), 'both servers listed by default');
  assert.ok(prompt.includes('### MCP server: fixture__docs'), 'per-server instructions present by default');
  assert.ok(prompt.includes('Fixture Docs instructions'), 'instructions text present by default');
  assert.ok(tools.has('mcp__fixture__docs__lookup'), 'fixture tools present by default');
  assert.ok(tools.has('list_mcp_resources'), 'shared resource tools present by default');
}

function assertClosedPolicy(request) {
  const prompt = systemPromptOf(request);
  const tools = toolNamesOf(request);
  assert.ok(!prompt.includes('## MCP resource servers'), 'the whole server listing is gone');
  assert.ok(!prompt.includes('### MCP server:'), 'no per-server instructions remain');
  assert.ok(!prompt.includes('fixture'), 'no fixture server is mentioned at all');
  assert.ok(!tools.has('mcp__fixture-archive__lookup'), 'no fixture tools remain');
  assert.ok(!tools.has('mcp__fixture__docs__status'), 'no hidden-server tools remain');
  assert.ok(prompt.includes('DeepSeek Harness'), 'the rest of the system prompt is intact');
}

try {
  const upstream = await runHeadless('open fallback', []);
  try {
    assertUpstreamPolicy(upstream);
  } catch (error) {
    try {
      writeFileSync(join(tmpdir(), 'dsh-prompt-live-upstream.json'), JSON.stringify(upstream, null, 2));
    } catch { /* diagnostics only */ }
    throw error;
  }
  console.log('PASS prompt live: the open fallback keeps the upstream MCP prompt pollution');

  const closed = await runHeadless('closed fallback', ['--patch', closeAllOverlay]);
  try {
    assertClosedPolicy(closed);
  } catch (error) {
    try {
      writeFileSync(join(tmpdir(), 'dsh-prompt-live-closed.json'), JSON.stringify(closed, null, 2));
    } catch { /* diagnostics only */ }
    throw error;
  }
  console.log('PASS prompt live: the closed fallback removes every MCP prompt section');
} finally {
  await new Promise((closed) => mock.close(closed));
  // Windows can hold child-process handles for a while after exit.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      removeTestHome(taskHome, profilePrefix);
      break;
    } catch {
      if (attempt === 19) console.log(`WARN prompt live: leftover temp directory ${taskHome}`);
      await delay(750);
    }
  }
}
console.log('ALL PROMPT LIVE CHECKS PASSED');
