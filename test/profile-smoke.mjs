/** Boot the installed DSH in an owned temporary profile, without model tasks or user data. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'node:net';
import { execFile, spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);
const packageName = 'dsh-tool-exposure';
const routePath = `/plugins/${packageName}`;
const guardHeaders = { 'x-dsh-tool-exposure-plugin': '1' };

function responseCookies(response) {
  return response.headers.getSetCookie().map((cookie) => cookie.split(';', 1)[0]).join('; ');
}

async function verifyRouteAuthentication({ origin, launchUrl, headers }) {
  for (const [method, path] of [['GET', '/inventory'], ['POST', '/save'], ['POST', '/reset'], ['POST', '/debug/apply']]) {
    const response = await fetch(`${origin}${routePath}${path}`, { method, headers: guardHeaders });
    assert.equal(response.status, 401, `${method} ${path} requires DSH authentication`);
  }
  const crossOrigin = await fetch(`${origin}${routePath}/reset`, {
    method: 'POST', headers: { ...headers, origin: 'https://other.example' },
  });
  assert.equal(crossOrigin.status, 403, 'DSH rejects cross-origin changes even with a browser cookie');

  const connectUrl = new URL('/connect', launchUrl);
  connectUrl.search = new URL(launchUrl).search;
  const connection = await fetch(connectUrl, { redirect: 'manual' });
  const cookie = responseCookies(connection);
  assert.ok(cookie, 'DSH issued an API peer cookie');
  const api = await fetch(`${origin}${routePath}/ping`, { headers: { ...guardHeaders, cookie } });
  assert.equal(api.status, 200, 'authenticated API peers can read diagnostics');
  for (const path of ['/save', '/reset', '/debug/apply']) {
    const response = await fetch(`${origin}${routePath}${path}`, { method: 'POST', headers: { ...guardHeaders, cookie } });
    assert.equal(response.status, 403, `only the authenticated browser peer can call ${path}`);
  }
  console.log('PASS profile: DSH authentication protects tool policy reads and browser-only changes');
}

async function verifyInstalledArchive(profile, archive) {
  for (const file of ['package.json', 'index.js', 'registry.js']) {
    const { stdout } = await run('tar', ['-xOf', archive, `package/${file}`], { encoding: 'buffer' });
    assert.deepEqual(readFileSync(join(profile, 'node_modules', packageName, file)), stdout, `installed ${file} matches the candidate archive`);
  }
}

/** Validate real bundle composition, peer resolution, and Loader-sourced tool catalogs. */
export async function runProfileSmoke(installed, options = {}) {
  let cliManifest;
  try { cliManifest = installed.resolve('@deepseek-ai/dsh/package.json'); }
  catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND' || options.packageSpec) throw error;
    console.log('SKIP profile smoke: the DSH CLI is not installed with the runtime dependencies.');
    return;
  }
  const cli = JSON.parse(readFileSync(cliManifest, 'utf8'));
  assert.equal(cli.name, '@deepseek-ai/dsh');
  const cliBin = join(dirname(cliManifest), cli.bin.dsh);
  const taskHome = mkdtempSync(join(tmpdir(), 'dsh-tool-exposure-profile-'));
  const project = dirname(dirname(fileURLToPath(import.meta.url)));
  const profile = join(taskHome, 'profiles', 'web');
  const fixture = join(taskHome, 'fixture-provider');
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: taskHome };
  let child;
  let closed;
  let logs = '';

  async function install(specifier) {
    await run(process.execPath, [cliBin, 'plugin', '--profile', 'web', 'add', specifier, '--ignore-scripts'], {
      cwd: project, env: { ...env, CI: 'true' }, windowsHide: true, timeout: 120000,
    });
    const manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'));
    assert.ok(manifest.dsh.profile.bundles.includes(packageName), 'DSH activated the installed bundle');
  }

  async function startHost() {
    const probe = createServer();
    await new Promise((ready, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', ready); });
    const port = probe.address().port;
    await new Promise((close) => probe.close(close));
    const origin = `http://127.0.0.1:${port}`;
    logs = '';
    child = spawn(process.execPath, [cliBin, 'web', '--no-open', '--port', String(port)], {
      cwd: project, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env,
    });
    const collect = (chunk) => { logs = (logs + chunk.toString()).slice(-65536); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    closed = new Promise((resolveClose) => {
      child.once('error', (error) => { logs += String(error); resolveClose(); });
      child.once('close', resolveClose);
    });
    const deadline = Date.now() + 20000;
    let launchUrl;
    let headers;
    while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
      try {
        launchUrl ??= logs.match(/dsh web: (https?:\/\/\S+)/)?.[1];
        if (launchUrl && new URL(launchUrl).origin === origin) {
          if (!headers) {
            const exchange = await fetch(launchUrl, { redirect: 'manual', signal: AbortSignal.timeout(700) });
            const cookie = responseCookies(exchange);
            if (cookie) headers = { ...guardHeaders, cookie };
          }
          if (headers) {
            const response = await fetch(`${origin}${routePath}/inventory`, { headers, signal: AbortSignal.timeout(700) });
            if (response.ok) {
              const inventory = await response.json();
              if (['mcp__fixture__docs__lookup', 'mcp__fixture-archive__lookup'].every((name) =>
                inventory.globalTools?.some((tool) => tool.name === name))) return { origin, launchUrl, headers, inventory };
            }
          }
        }
      } catch { /* The owned server is still starting. */ }
      await delay(200);
    }
    assert.fail('isolated DSH startup did not expose authenticated inventory:\n' + logs.slice(-10000).replace(/([?&]token=)[^\s&]+/g, '$1[redacted]'));
  }

  async function stopHost() {
    if (!child) return;
    if (child.exitCode === null && child.signalCode === null) child.kill();
    const stopped = await Promise.race([closed.then(() => true), delay(5000, false)]);
    assert.ok(stopped, 'isolated DSH did not stop');
    child = undefined;
  }

  try {
    mkdirSync(join(profile, 'node_modules'), { recursive: true });
    mkdirSync(fixture);
    mkdirSync(join(fixture, 'locale'));
    writeFileSync(join(fixture, 'package.json'), JSON.stringify({
      name: 'dsh-fixture-provider', version: '1.0.0', type: 'module',
      exports: { '.': './index.js', './icon': './icon.svg', './locale/*.json': './locale/*.json' },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }));
    writeFileSync(join(fixture, 'locale', 'en.json'), JSON.stringify({ meta: { title: 'Fixture tools' } }));
    writeFileSync(join(fixture, 'locale', 'zh.json'), JSON.stringify({ meta: { title: '示例工具插件' } }));
    writeFileSync(join(fixture, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#3656ce"/></svg>');
    writeFileSync(join(fixture, 'cordis.patch.yml'), `- insert:
    - id: fixture-provider
      name: dsh-fixture-provider
    - id: fixture-reviewer
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: review-assistant
        name: 评审助手
        description: 阅读资料、检查细节，并整理关键结论。
        order: 5
        plugins: []
`);
    writeFileSync(join(fixture, 'index.js'), `export const inject = ['tools'];
export function apply(ctx) {
  ctx.tools.register({
    name: 'profile_probe_custom', description: 'Isolated registration fixture',
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute() { return 'ok'; },
  });
}
`);
    const { initProfile, readPluginMeta } = await import(pathToFileURL(installed.resolve('@deepseek-ai/dsh-app-boot')).href);
    const bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-fixture-provider'];
    const dependencies = { 'dsh-fixture-provider': `link:${fixture}` };
    if (!options.packageSpec) {
      bundles.push(packageName);
      dependencies[packageName] = `link:${project}`;
    }
    initProfile(profile, bundles);
    const manifestPath = join(profile, 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, dependencies }));
    const mcpFixture = join(fixture, 'mcp-server.cjs');
    writeFileSync(mcpFixture, `const readline = require('node:readline');
const inputSchema = { type: 'object', properties: {} };
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return;
  const results = {
    initialize: { protocolVersion: params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1.0.0' } },
    ping: {},
    'tools/list': { tools: [{ name: 'lookup', inputSchema }, { name: 'status', inputSchema }] },
  };
  const reply = Object.hasOwn(results, method)
    ? { result: results[method] }
    : { error: { code: -32601, message: 'Method not found' } };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, ...reply }) + '\\n');
});
`);
    const transport = {
      transport: 'stdio',
      command: process.execPath,
      args: [mcpFixture],
      cwd: fixture,
      env: { ELECTRON_RUN_AS_NODE: '1' },
      startupTimeoutMs: 5000,
      reconnect: { enabled: false },
    };
    writeFileSync(join(profile, 'cordis.patch.yml'), JSON.stringify([
      {
        insert: [{
          id: 'fixture-mcp-direct',
          name: '@deepseek-ai/dsh-mcp-client',
          config: { ...transport, serverName: 'fixture__docs', failOnStartupError: true },
        }],
      },
      { id: 'mcp-manager', config: { servers: { 'fixture-archive': transport } } },
    ]));
    if (options.packageSpec) {
      await install(options.packageSpec);
      if (!options.upgradeArchive) await verifyInstalledArchive(profile, options.packageSpec);
    } else {
      const linkType = process.platform === 'win32' ? 'junction' : 'dir';
      symlinkSync(project, join(profile, 'node_modules', packageName), linkType);
      symlinkSync(fixture, join(profile, 'node_modules', 'dsh-fixture-provider'), linkType);
    }

    const metadataBase = pathToFileURL(join(profile, 'package.json')).href;
    for (const [specifier, title] of [['dsh-tool-exposure', '工具暴露'], ['dsh-tool-exposure/registry', '工具来源记录']]) {
      const metadata = readPluginMeta(specifier, metadataBase);
      assert.equal(metadata?.error, undefined, 'real DSH plugin metadata: ' + specifier);
      assert.equal(metadata?.title?.zh, title);
    }
    console.log('PASS metadata: real DSH reads root and registry locales without package warnings');

    const running = await startHost();
    const { origin, launchUrl, headers, inventory } = running;
    if (!options.upgradeArchive) await verifyRouteAuthentication(running);
    assert.equal(inventory.discovery, true);
    assert.equal(inventory.roles.find((role) => role.id === 'standard').name, undefined);
    assert.equal(inventory.roles.find((role) => role.id === 'review-assistant').name, '评审助手');
    assert.deepEqual(inventory.sources, []);
    const standard = inventory.roleTools.standard;
    assert.ok(standard?.length > 1, 'real standard preset tools are present');
    assert.ok(standard.some((tool) => tool.source === '@official' && tool.provider?.official));
    const custom = standard.find((tool) => tool.name === 'profile_probe_custom');
    assert.equal(custom?.provider?.plugin, 'dsh-fixture-provider');
    assert.equal(custom.source, '@plugin/dsh-fixture-provider');
    const providerMeta = inventory.providerMetadata[custom.provider.packageMeta];
    assert.equal(providerMeta?.title?.zh, '示例工具插件');
    assert.match(providerMeta?.icon ?? '', /^data:image\/svg\+xml;base64,/);
    assert.equal(inventory.roleTools.ptc.find((tool) => tool.name === custom.name)?.provider?.packageMeta, custom.provider.packageMeta);
    assert.equal('baseUrl' in custom.provider, false);
    console.log('PASS profile: real plugin titles and icons are shared across role inventories');
    for (const server of ['fixture__docs', 'fixture-archive']) {
      const tools = standard.filter((tool) => tool.provider?.mcpServer === server);
      assert.deepEqual(tools.map((tool) => tool.name), [`mcp__${server}__lookup`, `mcp__${server}__status`]);
      assert.ok(tools.every((tool) => tool.source === `@mcp/${server}`));
      assert.ok(tools.every((tool) => tool.provider.plugin === '@deepseek-ai/dsh-mcp-client'));
    }
    console.log('PASS profile: direct and manager-mounted global MCPs form independent server groups');
    assert.ok(standard.every((tool) => tool.name !== 'run_code'));
    assert.ok(standard.every((tool) => tool.provider !== null), 'real Loader registrations retain module identity');
    assert.deepEqual(inventory.diagnostics, []);
    const effectiveResponse = await fetch(`${origin}${routePath}/effective?role=standard`, { headers });
    const effective = await effectiveResponse.json();
    assert.deepEqual(effective.hidden, []);
    assert.equal(effective.visible.length, standard.length);
    console.log('PASS profile: real DSH boot, peer sharing, official preset tools, and third-party source detection');
    if (options.onReady) {
      await options.onReady({ origin, launchUrl, taskHome, profile });
      return;
    }

    const save = async (draft) => {
      const response = await fetch(`${origin}${routePath}/save`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(draft),
      });
      return { status: response.status, body: await response.json() };
    };
    assert.equal(inventory.editable, true);
    assert.match(inventory.configVersion, /^[a-f0-9]{64}$/);
    const originalDraft = { sources: {}, discovery: true, unlisted: 'open', roles: {} };
    const drafts = [
      { ...originalDraft, roles: { standard: { mode: 'open', groups: { '@mcp/fixture__docs': 'off' }, tools: {} } } },
      { ...originalDraft, unlisted: 'closed' },
    ];
    const saves = await Promise.all(drafts.map((draft) => save({ ...draft, configVersion: inventory.configVersion })));
    assert.deepEqual(saves.map(({ status }) => status).sort(), [200, 409], JSON.stringify(saves));
    const acceptedIndex = saves.findIndex(({ status }) => status === 200);
    const accepted = saves[acceptedIndex].body;
    const rejected = saves[1 - acceptedIndex].body;
    assert.equal(accepted.saved, true);
    assert.equal(rejected.code, 'config_conflict');
    const latest = await (await fetch(`${origin}${routePath}/inventory`, { headers })).json();
    const winner = drafts[acceptedIndex];
    assert.equal(latest.configVersion, accepted.configVersion);
    assert.equal(latest.unlisted, winner.unlisted);
    assert.deepEqual(latest.roles.find((role) => role.id === 'standard').groups, winner.roles.standard?.groups ?? {});
    console.log('PASS profile: concurrent saves preserve the winning configuration across a Host reload');

    const restored = await save({ ...originalDraft, configVersion: latest.configVersion });
    assert.equal(restored.status, 200, JSON.stringify(restored));
    assert.equal(restored.body.configVersion, inventory.configVersion);
    console.log('PASS profile: a rescan provides the revision needed to save again');

    const mcpSave = await save({ ...drafts[0], configVersion: restored.body.configVersion });
    assert.equal(mcpSave.status, 200, JSON.stringify(mcpSave));
    const filtered = await (await fetch(`${origin}${routePath}/effective?role=standard`, { headers })).json();
    assert.deepEqual(filtered.hidden, ['mcp__fixture__docs__lookup', 'mcp__fixture__docs__status']);
    assert.ok(filtered.visible.includes('mcp__fixture-archive__lookup'));
    console.log('PASS profile: the saved server policy only hides tools from that server');

    if (options.upgradeArchive) {
      await stopHost();
      await install(options.upgradeArchive);
      await verifyInstalledArchive(profile, options.upgradeArchive);
      const upgraded = await startHost();
      await verifyRouteAuthentication(upgraded);
      assert.equal(upgraded.inventory.configVersion, mcpSave.body.configVersion);
      const response = await fetch(`${upgraded.origin}${routePath}/effective?role=standard`, { headers: upgraded.headers });
      assert.equal(response.status, 200);
      const effective = await response.json();
      assert.deepEqual(effective.hidden, filtered.hidden);
      assert.deepEqual(effective.visible, filtered.visible);
      console.log('PASS package upgrade: DSH boots the candidate archive and retains the saved policy');
    } else if (options.packageSpec) {
      console.log('PASS package install: a fresh DSH profile boots the candidate archive');
    }
  } finally {
    await stopHost();
    const target = resolve(taskHome);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('dsh-tool-exposure-profile-')) {
      throw new Error('Refusing to remove an unowned test directory: ' + target);
    }
    rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
