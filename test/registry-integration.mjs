/** Exercise provider tracking against the actual installed Cordis and DSH ToolsService. */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { runProfileSmoke } from './profile-smoke.mjs';

const ownFile = fileURLToPath(import.meta.url);
const desktopExe = process.env.DSH_NODE_EXECUTABLE || join(process.env.LOCALAPPDATA || '', 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe');
if (process.platform === 'win32' && !process.versions.electron && existsSync(desktopExe)) {
  const result = spawnSync(desktopExe, [ownFile], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', windowsHide: true, timeout: 45000,
  });
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

const anchor = process.env.DSH_TEST_INSTALL_DIR || (process.versions.electron
  ? join(dirname(process.execPath), 'resources', 'app.asar', 'dsh') : dirname(ownFile));
const installed = createRequire(join(anchor, 'package.json'));
let toolsEntry;
try { toolsEntry = installed.resolve('@deepseek-ai/dsh-tools'); }
catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
  console.log('SKIP registry integration: install the declared devDependencies or set DSH_TEST_INSTALL_DIR.');
  process.exit(0);
}
const peers = new Map([
  ['@deepseek-ai/dsh-tools', pathToFileURL(toolsEntry).href],
  ['@deepseek-ai/dsh-scope', pathToFileURL(installed.resolve('@deepseek-ai/dsh-scope')).href],
]);
const hook = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@deepseek-ai/dsh-tools' || specifier === '@deepseek-ai/dsh-scope') {
      return { url: peers.get(specifier), shortCircuit: true };
    }
    return next(specifier, context);
  },
});
const { Context } = await import(pathToFileURL(installed.resolve('@deepseek-ai/cordis')).href);
const { ToolsService } = await import(pathToFileURL(toolsEntry).href);
const { createScope, scopeOf, bindScopeParent } = await import(pathToFileURL(installed.resolve('@deepseek-ai/dsh-scope')).href);
const { default: Registry } = await import('../registry.js');
const { __test: Host } = await import('../index.js');

const root = new Context();
root.provide('systemPrompt', { tools() { return () => {}; } });
const registryFiber = root.plugin(Registry);
for (let attempt = 0; attempt < 30 && !root.get('tools'); attempt += 1) await new Promise(setImmediate);
const tools = root.get('tools');
assert.ok(tools instanceof ToolsService, 'tracking service retains the official ToolsService');
console.log('PASS registry: starts as the official ToolsService with source tracking');
let ownerContext;
const ownerFiber = root.plugin({ inject: ['tools'], apply(ctx) { ownerContext = ctx; } });
await ownerFiber.inertia;
assert.ok(ownerContext, 'test scope owner activated with tools injection');

function definition(name) {
  return {
    name, description: name, parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute() { return 'ok'; },
  };
}
const entryKey = Symbol.for('cordis.entry');
const scopes = [];
function newScope(parent) {
  const key = {};
  const scope = createScope(ownerContext, key, parent === undefined ? undefined : { parent });
  scopes.push(scope);
  return { ...scope, key };
}
function register(context, plugin, name) {
  const ctx = context.extend({ [entryKey]: { options: { name: plugin } } });
  const dispose = ctx.tools.register(definition(name));
  return { ctx, dispose };
}

try {
  register(root, 'dsh-example-notes/tools', 'read');
  register(root, '@vendor/calendar', 'same_prefix_calendar');
  register(root, '@deepseek-ai/dsh-tool-example', 'same_prefix_official');
  const catalog = tools.toolCatalog();
  assert.equal(catalog.find((tool) => tool.name === 'read').provider.plugin, 'dsh-example-notes');
  assert.equal(catalog.find((tool) => tool.name === 'read').provider.module, 'dsh-example-notes/tools');
  assert.equal(catalog.find((tool) => tool.name === 'read').provider.official, false);
  assert.equal(catalog.find((tool) => tool.name === 'same_prefix_official').provider.official, true);
  const index = Host.buildToolIndex(Host.normalizeConfig({}), catalog.map((tool) => tool.name), catalog);
  assert.equal(index.owner.get('read'), '@plugin/dsh-example-notes');
  assert.equal(index.owner.get('same_prefix_calendar'), '@plugin/@vendor/calendar');
  assert.equal(index.owner.get('same_prefix_official'), '@official');
  console.log('PASS registry: uses actual registrar identity regardless of tool name prefixes');

  const presetA = newScope();
  const presetB = newScope();
  register(presetA.ctx, '@deepseek-ai/dsh-tool-files', 'read');
  register(presetA.ctx, 'dsh-example-notes', 'notes_find');
  register(presetB.ctx, '@vendor/other', 'read');
  const agentScope = newScope(presetA.key);
  register(agentScope.ctx, 'dsh-agent-local', 'local_only');
  const agent = { ctx: agentScope.ctx };
  const inherited = tools.agentToolCatalog(agent);
  assert.equal(inherited.find((tool) => tool.name === 'read').provider.plugin, '@deepseek-ai/dsh-tool-files');
  assert.ok(!inherited.some((tool) => tool.name === 'local_only'));
  assert.equal(tools.toolCatalog().find((tool) => tool.name === 'read').provider.plugin, 'dsh-example-notes');
  console.log('PASS registry: distinguishes global, inherited, shadowed, and agent-owned tools');

  const currentPresets = new Map([['reviewer', presetA.key], ['other', presetB.key]]);
  let activeProbes = 0;
  let probeCalls = 0;
  const presets = {
    composedPreset: () => 'reviewer',
    list: async () => [{ id: 'reviewer', name: 'Reviewer' }, { id: 'other', name: 'Other' }],
    async mount(ctx, id) {
      activeProbes += 1;
      probeCalls += 1;
      ctx.effect(() => () => { activeProbes -= 1; });
      if (!currentPresets.has(id)) throw new Error('Unknown preset');
      bindScopeParent(scopeOf(ctx), currentPresets.get(id));
      return { id };
    },
  };
  root.provide('agentPresets', presets);
  const policyConfig = Host.normalizeConfig({
    roles: { reviewer: { mode: 'open', groups: { '@official': 'off' } } },
  });
  assert.equal(Host.applyAgentPolicy(root, agent, policyConfig), true);
  assert.equal(tools.get('read', agentScope.key), undefined);
  assert.ok(tools.get('notes_find', agentScope.key));
  assert.ok(tools.get('local_only', agentScope.key));
  assert.ok(tools.agentToolCatalog(agent).some((tool) => tool.name === 'read'));
  register(presetA.ctx, '@deepseek-ai/dsh-tool-other', 'late_official');
  assert.equal(Host.applyAgentPolicy(root, agent, policyConfig), true);
  assert.equal(tools.get('read', agentScope.key), undefined);
  assert.equal(tools.get('late_official', agentScope.key), undefined);
  console.log('PASS registry: official group restrictions cover preset ancestors and survive recomputation');

  const before = probeCalls;
  const [first, concurrent] = await Promise.all([
    tools.presetToolCatalog(presets, 'reviewer'), tools.presetToolCatalog(presets, 'reviewer'),
  ]);
  assert.equal(probeCalls, before + 1);
  assert.equal(activeProbes, 0);
  assert.deepEqual(first, concurrent);
  assert.equal(first.find((tool) => tool.name === 'read').provider.official, true);
  currentPresets.set('reviewer', presetB.key);
  const changed = await tools.presetToolCatalog(presets, 'reviewer');
  assert.equal(changed.find((tool) => tool.name === 'read').provider.plugin, '@vendor/other');
  currentPresets.set('reviewer', presetA.key);
  await assert.rejects(tools.presetToolCatalog(presets, 'missing'), /Unknown preset/);
  assert.equal(activeProbes, 0);
  assert.equal(tools.presetCatalogs.size, 0);
  console.log('PASS registry: preset reads coalesce, release their scopes, and follow current revisions');

  const inventory = await Host.buildInventory(root, Host.normalizeConfig({}));
  assert.equal(activeProbes, 0);
  assert.equal(inventory.sources.length, 0);
  assert.equal(inventory.discovery, true);
  assert.equal(inventory.roleTools.reviewer.find((tool) => tool.name === 'read').source, '@official');
  assert.equal(inventory.roleTools.other.find((tool) => tool.name === 'read').source, '@plugin/@vendor/other');
  assert.ok(inventory.roleTools.reviewer.some((tool) => tool.name === 'notes_find'));
  assert.ok(!inventory.roleTools.other.some((tool) => tool.name === 'notes_find'));
  const effective = await Host.buildEffective(root, policyConfig, 'reviewer');
  assert.ok(effective.hidden.includes('read'));
  assert.ok(effective.hidden.includes('late_official'));
  assert.ok(effective.visible.includes('notes_find'));
  console.log('PASS registry: inventory and effective policies use each preset’s actual tool sources');

  const transient = register(root, '@vendor/transient', 'transient_tool');
  assert.ok(tools.toolCatalog().some((tool) => tool.name === 'transient_tool'));
  await transient.dispose();
  assert.equal(tools.get('transient_tool'), undefined);
  assert.ok(!tools.toolCatalog().some((tool) => tool.name === 'transient_tool'));
  register(root, '@vendor/replacement', 'transient_tool');
  assert.equal(tools.toolCatalog().find((tool) => tool.name === 'transient_tool').provider.plugin, '@vendor/replacement');
  assert.throws(() => register(root, '@vendor/collision', 'transient_tool'), /already registered/);
  assert.equal(tools.toolCatalog().find((tool) => tool.name === 'transient_tool').provider.plugin, '@vendor/replacement');
  console.log('PASS registry: disposal, replacement, and failed registration preserve correct ownership');

  const unowned = register(root, '', 'unattributed');
  const unknown = tools.toolCatalog().find((tool) => tool.name === 'unattributed');
  assert.equal(unknown.provider, null);
  const fallback = Host.buildToolIndex(Host.normalizeConfig({}), ['unattributed'], [unknown]);
  assert.equal(fallback.owner.get('unattributed'), '@unknown');
  await unowned.dispose();
  console.log('PASS registry: missing Loader identity is reported as unknown');

  let notifications = 0;
  const off = root.on('tools/change', () => { notifications += 1; });
  try {
    const observed = register(root, '@vendor/observed', 'observed_tool');
    assert.equal(notifications, 1);
    await observed.dispose();
    assert.equal(notifications, 2);
  } finally { off(); }
  assert.equal(tools.get('observed_tool'), undefined);
  assert.ok(!tools.toolCatalog().some((tool) => tool.name === 'observed_tool'));
  console.log('PASS registry: preserves official registration and removal notifications');
} finally {
  for (const scope of scopes.reverse()) await scope.dispose();
  await ownerFiber.dispose();
  await registryFiber.dispose();
  await root.fiber.dispose();
  hook.deregister();
}

const toolsVersion = JSON.parse(readFileSync(installed.resolve('@deepseek-ai/dsh-tools/package.json'), 'utf8')).version;
console.log('REAL DSH REGISTRY CHECKS PASSED against', toolsVersion);
await runProfileSmoke(installed);
