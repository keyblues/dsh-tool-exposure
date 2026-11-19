/**
 * Host-half unit tests for tool-exposure/index.js.
 *
 * Covers config normalization, tool indexing, policy resolution, draft validation,
 * inventory shape (including orphan-role preservation), and the per-agent
 * apply / snapshot / lift state machine — all against fake Cordis contexts.
 *
 * Run: node test/host-policy.mjs
 */
import assert from 'node:assert/strict';
import { __test as T } from '../index.js';

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log('PASS', name);
  } catch (error) {
    failures += 1;
    console.log('FAIL', name, '->', error && error.message ? error.message : error);
  }
}
function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label || 'value'}: got ${a}, want ${b}`);
}
function ok(condition, label) {
  if (!condition) throw new Error(label || 'assertion failed');
}

/* ------------------------- config normalization ------------------------- */

check('normalizeConfig: fresh installation discovers providers with no preset tools or groups', () => {
  const config = T.normalizeConfig({});
  eq(config.sources, {}, 'no hardcoded groups');
  eq(config.discovery, true, 'automatic discovery enabled');
  eq(config.unlisted, 'open', 'unlisted');
  eq(config.roles, {}, 'roles');
});

check('default policy: discovers arbitrary tools and presets without installation-specific names', () => {
  const config = T.normalizeConfig({});
  for (const names of [[], ['weatherForecast'], ['mcp__calendar__events', 'notes_find', 'vendor.custom-tool']]) {
    const index = T.buildToolIndex(config, names);
    eq(index.managed, names, 'all registered tools managed');
    eq(index.ungrouped, [], 'no setup needed');
    const policy = T.resolveRolePolicy(config, 'Research.Team v2', index);
    eq([...policy.visible], names, 'new roles keep all tools visible');
    eq([...policy.hidden], [], 'installing applies no restrictions');
  }
});

check('default policy: allow-list works per tool without custom groups', () => {
  const config = T.normalizeConfig({
    roles: { reviewer: { mode: 'allow', tools: { notes_find: 'on' } } },
  });
  const names = T.globalToolNames({ schemas: () => ['mcp__calendar__events', 'notes_find', 'run_code'].map((name) => ({ name })) });
  const policy = T.resolveRolePolicy(config, 'reviewer', T.buildToolIndex(config, names));
  eq([...policy.visible], ['notes_find'], 'per-tool allow-list');
  eq([...policy.hidden], ['mcp__calendar__events'], 'other shared tools hidden');
  ok(!names.includes('run_code'), 'reserved transport stays outside the policy');
});

check('custom groups take priority over the automatic unknown-provider fallback', () => {
  const config = T.normalizeConfig({
    discovery: true,
    sources: { notes: { match: ['notes_*'] } },
    roles: { reviewer: { mode: 'open', groups: { notes: 'off' } } },
  });
  const index = T.buildToolIndex(config, ['notes_find', 'weatherForecast']);
  eq(index.owner.get('notes_find'), 'notes', 'custom ownership');
  eq(index.owner.get('weatherForecast'), '@unknown', 'fallback ownership');
  eq([...T.resolveRolePolicy(config, 'reviewer', index).hidden], ['notes_find'], 'group-specific policy');
});

check('normalizeConfig: explicit empty sources stays empty (no default resurrection)', () => {
  const config = T.normalizeConfig({ sources: {}, roles: {} });
  eq(Object.keys(config.sources), [], 'sources');
  eq(config.discovery, false, 'existing manual scope is preserved');
});

check('automatic groups: real providers determine identity and official tools stay together', () => {
  const catalog = [
    { name: 'official_looking', provider: { plugin: '@vendor/a', official: false } },
    { name: 'same_prefix_a', provider: { plugin: '@deepseek-ai/dsh-tool-a', official: true } },
    { name: 'same_prefix_b', provider: { plugin: '@deepseek-ai/dsh-tool-b', official: true } },
    { name: 'same_prefix_c', provider: { plugin: '@vendor/b', official: false } },
  ];
  const config = T.normalizeConfig({ discovery: true, sources: { all: { match: ['*'] } } });
  const index = T.buildToolIndex(config, catalog.map((tool) => tool.name), catalog);
  eq(index.groups[0].id, '@official', 'official group first');
  eq(index.groups[0].tools, ['same_prefix_a', 'same_prefix_b'], 'official providers share a group');
  eq(index.owner.get('official_looking'), 'all', 'custom grouping');
  eq(index.providers.get('official_looking').plugin, '@vendor/a', 'real provider retained');
  eq(index.owner.get('same_prefix_a'), '@official', 'wildcard cannot swallow official tools');
});

check('automatic groups: each global MCP server has its own policy', () => {
  const bridge = { plugin: '@deepseek-ai/dsh-mcp-client', official: true };
  const catalog = [
    { name: 'read', provider: { plugin: '@deepseek-ai/dsh-tool-files', official: true } },
    { name: 'mcp__ida__lookup', provider: { ...bridge, mcpServer: 'ida' } },
    { name: 'mcp__notes__lookup', provider: { ...bridge, mcpServer: 'notes' } },
    { name: 'mcp__scoped__lookup', provider: bridge },
    { name: 'mcp__fake__lookup', provider: { plugin: 'some-other-plugin', official: false } },
  ];
  const config = T.normalizeConfig({
    discovery: true,
    sources: { all: { match: ['*'] } },
    roles: { standard: { groups: { '@official': 'off', '@mcp/ida': 'off' } } },
  });
  const index = T.buildToolIndex(config, catalog.map((tool) => tool.name), catalog);
  eq(index.groups.map((group) => group.id), ['@official', '@mcp/ida', '@mcp/notes', 'all'], 'group order');
  eq(index.owner.get('mcp__scoped__lookup'), '@official', 'scoped bridge keeps its provider group');
  eq(index.owner.get('mcp__fake__lookup'), 'all', 'a tool name alone cannot identify an MCP server');
  eq([...T.resolveRolePolicy(config, 'standard', index).hidden], ['read', 'mcp__ida__lookup', 'mcp__scoped__lookup'], 'independent overrides');
  const manual = T.buildToolIndex({ ...config, discovery: false }, catalog.map((tool) => tool.name), catalog);
  eq(manual.groups.map((group) => group.id), ['all'], 'manual rules');
});

check('normalizeConfig: __proto__ keys cannot hijack the config maps', () => {
  const raw = JSON.parse('{"sources":{"__proto__":{"match":["x_*"]},"ok":{"match":["ok_*"]}},"roles":{"__proto__":{"mode":"allow"}}}');
  const config = T.normalizeConfig(raw);
  eq(Object.keys(config.sources), ['ok'], 'sources keys');
  eq(Object.keys(config.roles), [], 'roles keys');
  ok(Object.getPrototypeOf(config.sources) === Object.prototype, 'sources prototype unchanged');
});

check('normalizeConfig: drops empty match and normalizes roles', () => {
  const config = T.normalizeConfig({
    unlisted: 'closed',
    sources: {
      a: { label: 'A', match: ['a_*', '  ', ''] },
      b: { match: [] },
      c: 'not-an-object',
    },
    roles: {
      expert: { mode: 'allow', groups: { a: 'on', b: 'bogus' }, tools: { x: 'off', y: 'nope' } },
      other: { mode: 'bogus' },
    },
  });
  eq(Object.keys(config.sources), ['a', 'b'], 'a survives, empty-match b is kept for visibility');
  eq(config.sources.a.match, ['a_*'], 'match filtered');
  eq(config.sources.b.match, [], 'empty match kept as []');
  eq(config.unlisted, 'closed', 'unlisted');
  eq(config.roles.expert, { mode: 'allow', groups: { a: 'on' }, tools: { x: 'off' } }, 'expert');
  eq(config.roles.other, { mode: 'open', groups: {}, tools: {} }, 'other defaults to open');
});

/* ----------------------------- tool indexing ---------------------------- */

const CONFIG = T.normalizeConfig({
  unlisted: 'open',
  sources: {
    fofa: { label: 'FOFA', match: ['fofa_*'] },
    device: { label: 'Device', match: ['hdc_*', 'hms_*'] },
  },
  roles: {
    expert: { mode: 'allow', groups: { fofa: 'on' }, tools: { hdc_shell: 'on', fofa_search: 'off' } },
    standard: { mode: 'open', groups: { device: 'off' }, tools: {} },
  },
});
const NAMES = ['everything_status', 'fofa_account', 'fofa_export', 'fofa_search', 'hdc_shell', 'hms_build', 'read'];

check('buildToolIndex: first matching group wins, non-matching tools stay ungrouped', () => {
  const index = T.buildToolIndex(CONFIG, NAMES);
  eq(index.managed, ['fofa_account', 'fofa_export', 'fofa_search', 'hdc_shell', 'hms_build'], 'managed');
  eq(index.ungrouped, ['everything_status', 'read'], 'ungrouped');
  eq(index.owner.get('hms_build'), 'device', 'owner');
});

check('resolveRolePolicy: allow-list + group + tool overrides', () => {
  const index = T.buildToolIndex(CONFIG, NAMES);
  const policy = T.resolveRolePolicy(CONFIG, 'expert', index);
  eq(policy.mode, 'allow', 'mode');
  eq([...policy.visible].sort(), ['fofa_account', 'fofa_export', 'hdc_shell'], 'visible');
  eq([...policy.hidden].sort(), ['fofa_search', 'hms_build'], 'hidden');
});

check('resolveRolePolicy: open baseline minus group override', () => {
  const index = T.buildToolIndex(CONFIG, NAMES);
  const policy = T.resolveRolePolicy(CONFIG, 'standard', index);
  eq([...policy.visible].sort(), ['fofa_account', 'fofa_export', 'fofa_search'], 'visible');
  eq([...policy.hidden].sort(), ['hdc_shell', 'hms_build'], 'hidden');
});

check('resolveRolePolicy: unknown role follows unlisted (open)', () => {
  const index = T.buildToolIndex(CONFIG, NAMES);
  const policy = T.resolveRolePolicy(CONFIG, 'ghost', index);
  eq(policy.configured, false, 'configured');
  eq(policy.visible.size, 5, 'all managed visible');
});

check('resolveRolePolicy: unknown role follows unlisted (closed)', () => {
  const closed = T.normalizeConfig({ ...CONFIG, unlisted: 'closed' });
  const index = T.buildToolIndex(closed, NAMES);
  const policy = T.resolveRolePolicy(closed, 'ghost', index);
  eq(policy.mode, 'allow', 'mode');
  eq(policy.visible.size, 0, 'nothing visible');
});

check('resolveRolePolicy: tool override beats group override', () => {
  const config = T.normalizeConfig({
    sources: { a: { match: ['a_*'] } },
    roles: { r: { mode: 'open', groups: { a: 'off' }, tools: { a_one: 'on' } } },
  });
  const index = T.buildToolIndex(config, ['a_one', 'a_two']);
  eq([...T.resolveRolePolicy(config, 'r', index).visible], ['a_one'], 'visible');
});

/* --------------------------- draft validation --------------------------- */

check('normalizeDraft: missing sources is rejected (no accidental wipe)', () => {
  const result = T.normalizeDraft({ unlisted: 'open', roles: {} });
  ok(result.errors.some((message) => message.includes('sources')), 'missing-sources error');
});

check('normalizeDraft: valid draft round-trips through normalizeConfig', () => {
  const result = T.normalizeDraft({
    unlisted: 'closed',
    sources: { fofa: { label: ' FOFA ', match: ['fofa_*', ''] } },
    roles: { expert: { mode: 'allow', groups: { fofa: 'on' }, tools: { a: 'off' } } },
  });
  eq(result.errors, [], 'errors');
  eq(result.config, {
    discovery: false,
    unlisted: 'closed',
    sources: { fofa: { label: 'FOFA', match: ['fofa_*'] } },
    roles: { expert: { mode: 'allow', groups: { fofa: 'on' }, tools: { a: 'off' } } },
  }, 'config');
  eq(T.normalizeConfig(result.config).sources.fofa.match, ['fofa_*'], 're-normalizes');
});

check('normalizeDraft: invalid ids / empty match / bad mode are rejected or normalized', () => {
  const bad = T.normalizeDraft({
    sources: { 'Bad Id': { match: ['x_*'] }, empty: { match: [] } },
    roles: JSON.parse('{"__proto__":{"mode":"nonsense"}}'),
  });
  ok(bad.errors.some((message) => message.includes('工具组 id')), 'bad source id');
  ok(bad.errors.some((message) => message.includes('match')), 'empty match');
  ok(bad.errors.some((message) => message.includes('角色 id')), 'bad role id');
});

/* ------------------------------ inventory ------------------------------- */

const SCHEMAS = [
  { name: 'fofa_search', description: 'search' },
  { name: 'hdc_shell', description: 'shell' },
  { name: 'read', description: 'read file' },
];
function fakeHostTools() {
  return {
    schemas: () => SCHEMAS,
    get: (name) => SCHEMAS.find((schema) => schema.name === name),
    restrict: () => () => {},
  };
}

async function inventoryFixture() {
  const tools = fakeHostTools();
  const ctx = {
    tools,
    get(name) {
      if (name === 'agentPresets') return { list: async () => [{ id: 'known', name: 'Known' }] };
      if (name === 'configEditor') return { edit() {}, entries: () => [] };
      return undefined;
    },
  };
  const config = T.normalizeConfig({
    sources: { fofa: { label: 'FOFA', match: ['fofa_*'] }, device: { label: 'Device', match: ['hdc_*'] } },
    roles: {
      known: { mode: 'allow', groups: { fofa: 'on' }, tools: {} },
      ghost: { mode: 'open', groups: { device: 'off' }, tools: { 'dead_tool': 'on' } },
      'bad\u0007id': { mode: 'open', groups: {}, tools: {} },
    },
  });
  const inventory = await T.buildInventory(ctx, config);
  return { inventory, config };
}

let inventoryCase = null;

/* --------------------- per-agent apply state machine -------------------- */

function makeAgent(roleId) {
  const agentCtx = {
    __role: roleId,
    restrictions: [],
    tools: {
      schemas: () => SCHEMAS,
      get: (name) => SCHEMAS.find((schema) => schema.name === name),
      restrict: (filter) => {
        const record = Object.fromEntries(Object.entries(filter).map(([key, names]) => [key, [...names]]));
        agentCtx.restrictions.push(record);
        return () => {
          const at = agentCtx.restrictions.indexOf(record);
          if (at >= 0) agentCtx.restrictions.splice(at, 1);
        };
      },
    },
    effect: (fn, label) => {
      const dispose = fn();
      return () => {
        if (typeof dispose === 'function') dispose();
      };
    },
  };
  return { ctx: agentCtx };
}

const browserPeer = { id: 'browser', principal: { kind: 'owner' } };
const fakeConnection = {
  browserPeer,
  admit({ headers }) {
    if (headers.host !== '127.0.0.1:1130') return { rejection: 403 };
    if (headers.cookie === 'fixture=browser') return { peer: browserPeer };
    if (headers.cookie === 'fixture=api') return { peer: { ...browserPeer, id: 'api' } };
    return { rejection: 401 };
  },
};

function makePluginCtx(agents) {
  const presets = {
    composedPreset: (agentCtx) => (agentCtx && typeof agentCtx.__role === 'string' ? agentCtx.__role : undefined),
  };
  return {
    tools: fakeHostTools(),
    effect: (fn) => fn(),
    get(name) {
      if (name === 'agentPresets') return presets;
      if (name === 'agents') return { list: () => agents };
      if (name === 'connection') return fakeConnection;
      return undefined;
    },
  };
}

const APPLY_CONFIG = T.normalizeConfig({
  sources: { fofa: { match: ['fofa_*'] }, device: { match: ['hdc_*'] } },
  roles: {
    expert: { mode: 'allow', groups: { fofa: 'on' }, tools: {} },
    standard: { mode: 'open', groups: { device: 'off' }, tools: {} },
  },
});

check('applyAgentPolicy: unresolved role immediately uses the open fallback', () => {
  const agent = makeAgent(undefined);
  const ctx = makePluginCtx([agent]);
  const applied = T.applyAgentPolicy(ctx, agent, APPLY_CONFIG);
  eq(applied, true, 'applied');
  eq(agent.ctx.restrictions.length, 0, 'restrictions');
});

check('applyAgentPolicy: a newly bound role replaces the fallback', () => {
  const agent = makeAgent(undefined);
  const ctx = makePluginCtx([agent]);
  T.applyAgentPolicy(ctx, agent, APPLY_CONFIG);
  agent.ctx.__role = 'expert';
  const applied = T.applyAgentPolicy(ctx, agent, APPLY_CONFIG);
  eq(applied, true, 'applied');
  eq(agent.ctx.restrictions.length, 1, 'one restriction');
  eq(agent.ctx.restrictions[0].deny, ['hdc_shell'], 'deny list');
});

check('applyAgentPolicy: idempotent for an unchanged policy signature', () => {
  const agent = makeAgent('expert');
  const ctx = makePluginCtx([agent]);
  T.applyAgentPolicy(ctx, agent, APPLY_CONFIG);
  T.applyAgentPolicy(ctx, agent, APPLY_CONFIG);
  eq(agent.ctx.restrictions.length, 1, 'still one restriction');
});

check('applyAgentPolicy: legacy agents are never touched', () => {
  const agent = makeAgent('expert');
  const ctx = makePluginCtx([agent]);
  T.markLiveAgentsLegacy(ctx);
  eq(T.readAgentState(agent, T.LEGACY), true, 'legacy');
  const applied = T.applyAgentPolicy(ctx, agent, APPLY_CONFIG);
  eq(applied, false, 'skipped');
  eq(agent.ctx.restrictions.length, 0, 'no restriction');
});

check('applyAgentPolicy: unlisted=closed hides every managed tool', () => {
  const agent = makeAgent('nobody');
  const ctx = makePluginCtx([agent]);
  const config = T.normalizeConfig({ unlisted: 'closed', sources: { fofa: { match: ['fofa_*'] } }, roles: {} });
  T.applyAgentPolicy(ctx, agent, config);
  eq(agent.ctx.restrictions.length, 1, 'one restriction');
  eq(agent.ctx.restrictions[0].deny, ['fofa_search'], 'all managed tools denied');
  eq(T.readAgentState(agent, T.APPLIED).signature, 'nobody|fofa_search', 'signature recorded');
});

check('applyAgentPolicy: a role with no managed tools gets no restriction', () => {
  const agent = makeAgent('empty');
  const ctx = makePluginCtx([agent]);
  const config = T.normalizeConfig({ unlisted: 'open', sources: {}, roles: { empty: { mode: 'allow', groups: {}, tools: {} } } });
  T.applyAgentPolicy(ctx, agent, config);
  eq(agent.ctx.restrictions.length, 0, 'no restriction for empty deny');
  eq(T.readAgentState(agent, T.APPLIED).signature, 'empty|', 'signature recorded');
});

check('liftAllRestrictions: disposes, freezes the agent, and reports the count', () => {
  const agent = makeAgent('expert');
  const ctx = makePluginCtx([agent]);
  T.applyAgentPolicy(ctx, agent, APPLY_CONFIG);
  eq(agent.ctx.restrictions.length, 1, 'restricted first');
  const lifted = T.liftAllRestrictions(ctx);
  eq(lifted, 1, 'lifted');
  eq(agent.ctx.restrictions.length, 0, 'restriction gone');
  eq(T.readAgentState(agent, T.LEGACY), true, 'frozen as legacy');
  eq(T.readAgentState(agent, T.APPLIED), undefined, 'cleared applied state');
});

check('catalog refresh keeps the original rule for started agents across a config reload', () => {
  const started = makeAgent('standard');
  const legacy = makeAgent('standard');
  const allowed = { name: 'catalog_lookup', provider: { plugin: '@deepseek-ai/dsh-mcp-client', mcpServer: 'catalog' } };
  const registered = [];
  started.ctx.tools.agentToolCatalog = () => registered;
  const config = T.normalizeConfig({ roles: { standard: { mode: 'allow', groups: { '@mcp/catalog': 'on' } } } });
  const ctx = makePluginCtx([started, legacy]);
  T.applyAgentPolicy(ctx, started, config);
  eq(started.ctx.restrictions, [{ allow: [] }], 'empty catalog still establishes an allow-list');
  T.setAgentState(started, T.STARTED, true);
  T.markLiveAgentsLegacy(ctx);
  registered.push(allowed, { name: 'archive_lookup', provider: { plugin: '@deepseek-ai/dsh-mcp-client', mcpServer: 'archive' } });
  T.refreshAgentPolicies(ctx);
  eq(started.ctx.restrictions, [{ allow: ['catalog_lookup'] }], 'only the approved server is visible');
  eq(legacy.ctx.restrictions, [], 'pre-existing session keeps its host state');
  T.liftAllRestrictions(ctx);
  T.refreshAgentPolicies(ctx);
  eq(started.ctx.restrictions, [], 'manual reset survives catalog changes');
});

check('applyAgentPolicy: a failed replacement preserves the previous mask', () => {
  const agent = makeAgent('standard');
  const ctx = makePluginCtx([agent]);
  const originalRestrict = agent.ctx.tools.restrict;
  agent.ctx.tools.restrict = (filter) => {
    if (Array.isArray(filter.deny) && filter.deny.includes('fofa_search')) throw new Error('boom');
    return originalRestrict(filter);
  };
  eq(T.applyAgentPolicy(ctx, agent, APPLY_CONFIG), true, 'initial apply');
  eq(agent.ctx.restrictions.length, 1, 'initial restriction');
  eq(agent.ctx.restrictions[0].deny, ['hdc_shell'], 'initial deny');
  const changed = T.normalizeConfig({
    sources: { fofa: { match: ['fofa_*'] }, device: { match: ['hdc_*'] } },
    roles: { standard: { mode: 'open', groups: { device: 'off' }, tools: { fofa_search: 'off' } } },
  });
  assert.throws(() => T.applyAgentPolicy(ctx, agent, changed, { force: true }), /boom/);
  eq(agent.ctx.restrictions.length, 1, 'previous restriction retained');
  eq(agent.ctx.restrictions[0].deny, ['hdc_shell'], 'retained deny');
  eq(T.readAgentState(agent, T.APPLIED).signature, 'standard|hdc_shell', 'signature retained');
});

/* --------------------- new regression checks (audit) ------------------- */

check('globToRegExp: linear matcher (no ReDoS) and wildcard semantics', () => {
  const pathological = T.globToRegExp('*a'.repeat(8) + 'b');
  const startedAt = Date.now();
  eq(pathological.test('c'.repeat(60)), false, 'pathological non-match');
  ok(Date.now() - startedAt < 200, 'pathological match must stay fast');
  eq(T.globToRegExp('fofa_*').test('fofa_search'), true, 'suffix wildcard');
  eq(T.globToRegExp('fofa_?').test('fofa_x'), true, 'single char');
  eq(T.globToRegExp('fofa_*').test('xfofa_x'), false, 'anchored');
  eq(T.globToRegExp('*').test('anything'), true, 'star matches all');
  eq(T.globToRegExp('a*b*c').test('aXXbYYc'), true, 'multiple stars');
  eq(T.globToRegExp('a*b*c').test('aXXbYY'), false, 'multiple stars miss');
});

check('normalizeConfig: non-object sources means no groups; string match accepted; sizes capped', () => {
  eq(Object.keys(T.normalizeConfig({ sources: null }).sources), [], 'null sources');
  eq(Object.keys(T.normalizeConfig({ sources: [] }).sources), [], 'array sources');
  const config = T.normalizeConfig({
    sources: { a: { match: 'fofa_*' }, b: { match: [] }, c: { match: ['ok_*', 'a'.repeat(300)] } },
  });
  eq(config.sources.a.match, ['fofa_*'], 'string match');
  eq(config.sources.b.match, [], 'empty match kept');
  eq(config.sources.c.match, ['ok_*'], 'oversized item dropped');
  eq(T.buildToolIndex(config, ['fofa_search']).owner.get('fofa_search'), 'a', 'group still owns');
});

check('normalizeDraft: roles required, roster-style ids accepted, unsafe ids rejected', () => {
  const missingRoles = T.normalizeDraft({ sources: { a: { match: ['a_*'] } } });
  ok(missingRoles.errors.some((message) => message.includes('roles')), 'roles required');
  const roster = T.normalizeDraft({
    sources: { a: { match: ['a_*'] } },
    roles: { asset_expert: { mode: 'allow', groups: {}, tools: {} } },
  });
  eq(roster.errors, [], 'roster id accepted');
  eq(Object.keys(roster.config.roles), ['asset_expert'], 'roster id kept');
  const unsafe = T.normalizeDraft({
    sources: { a: { match: ['a_*'] } },
    roles: JSON.parse('{"__proto__":{"mode":"open"}}'),
  });
  ok(unsafe.errors.some((message) => message.includes('角色 id')), 'dangerous role id rejected');
  const numericSource = T.normalizeDraft({ sources: { '1fofa': { match: ['a_*'] } }, roles: {} });
  ok(numericSource.errors.some((message) => message.includes('工具组 id')), 'numeric-first source id rejected');
  const oversized = T.normalizeDraft({ sources: { a: { match: ['a'.repeat(300)] } }, roles: {} });
  ok(oversized.errors.some((message) => message.includes('过长')), 'oversized match rejected');
});

check('normalizeDraft: comma-separated parts are validated after splitting (load/save symmetry)', () => {
  const split = T.normalizeDraft({
    sources: { a: { match: ['a'.repeat(200) + ',' + 'b'.repeat(200)] } },
    roles: {},
  });
  eq(split.errors, [], 'two 200-char parts accepted');
  eq(split.config.sources.a.match.length, 2, 'split into two patterns');
  const tooLong = T.normalizeDraft({ sources: { a: { match: ['a'.repeat(300)] } }, roles: {} });
  ok(tooLong.errors.some((message) => message.includes('过长')), 'single oversized part rejected');
});

check('applyAgentPolicy: frozen agent state is tracked via WeakMap (no repeated layers)', () => {
  const agent = makeAgent('expert');
  const ctx = makePluginCtx([agent]);
  Object.freeze(agent);
  T.applyAgentPolicy(ctx, agent, APPLY_CONFIG);
  T.applyAgentPolicy(ctx, agent, APPLY_CONFIG);
  eq(agent.ctx.restrictions.length, 1, 'one restriction');
  eq(T.readAgentState(agent, T.APPLIED).signature, 'expert|hdc_shell', 'signature stored');
  eq(T.setAgentState(agent, T.LEGACY, true), true, 'state write works on frozen agent');
  eq(T.readAgentState(agent, T.LEGACY), true, 'state read back');
});

check('applyAgentPolicy: unresolved role immediately uses the closed fallback', () => {
  const closed = T.normalizeConfig({
    unlisted: 'closed',
    sources: { fofa: { match: ['fofa_*'] } },
    roles: { expert: { mode: 'allow', groups: { fofa: 'on' }, tools: {} } },
  });
  const agent = makeAgent(undefined);
  const ctx = makePluginCtx([agent]);
  T.applyAgentPolicy(ctx, agent, closed);
  eq(agent.ctx.restrictions.length, 1, 'unlisted applied');
  eq(agent.ctx.restrictions[0].deny, ['fofa_search'], 'unlisted deny');
});

check('mountRoutes: re-registers when the webServer instance changes', () => {
  const makeServer = (name) => ({
    name,
    routes: [],
    register(route) {
      this.routes.push(route);
      return () => {
        this.routes = this.routes.filter((item) => item !== route);
      };
    },
  });
  const first = makeServer('first');
  const second = makeServer('second');
  let current = first;
  let injectCb = null;
  const ctx = {
    get: (name) => (name === 'webServer' ? current : undefined),
    effect: (fn) => fn(),
    inject: (services, cb) => {
      injectCb = cb;
      return () => {};
    },
  };
  T.mountRoutes(ctx, T.normalizeConfig({ sources: {}, roles: {} }));
  eq(first.routes.length, 1, 'first server registered');
  current = second;
  injectCb(ctx);
  eq(second.routes.length, 1, 'second server registered after replacement');
  injectCb(ctx);
  eq(second.routes.length, 1, 'no duplicate registration');
});

check('globalToolNames: reserved PTC transport run_code is never managed', () => {
  const tools = {
    schemas: () => [{ name: 'run_code' }, { name: 'fofa_search' }],
    get: () => undefined,
    restrict: () => () => {},
  };
  eq(T.globalToolNames(tools), ['fofa_search'], 'run_code excluded');
  const config = T.normalizeConfig({ sources: { all: { match: ['*'] } }, roles: {} });
  const index = T.buildToolIndex(config, T.globalToolNames(tools));
  ok(!index.managed.includes('run_code'), 'not in managed');
  eq(index.owner.has('run_code'), false, 'no owner');
  const closed = T.normalizeConfig({ unlisted: 'closed', sources: { all: { match: ['*'] } }, roles: {} });
  const records = [];
  const recordingTools = {
    schemas: () => [{ name: 'run_code' }, { name: 'fofa_search' }],
    get: () => undefined,
    restrict: (filter) => {
      records.push(filter);
      return () => {};
    },
  };
  const agent = makeAgent('nobody');
  agent.ctx.tools = recordingTools;
  T.applyAgentPolicy(makePluginCtx([agent]), agent, closed);
  eq(records[0].deny, ['fofa_search'], 'deny never contains run_code');
});

check('normalizeConfig: comma-separated match strings split like the page does', () => {
  const config = T.normalizeConfig({
    sources: { a: { match: ['fofa_*, hdc_*'] }, b: { match: 'fofa_*, hms_*' } },
  });
  eq(config.sources.a.match, ['fofa_*', 'hdc_*'], 'array item split');
  eq(config.sources.b.match, ['fofa_*', 'hms_*'], 'string split');
  const index = T.buildToolIndex(config, ['fofa_search', 'hdc_shell', 'hms_build']);
  eq(index.owner.get('fofa_search'), 'a', 'first group wins');
  eq(index.owner.get('hdc_shell'), 'a', 'second pattern of first group');
  eq(index.owner.get('hms_build'), 'b', 'second group');
});

/* --------------------------- async inventory --------------------------- */

inventoryCase = await inventoryFixture();
check('buildInventory: roles, orphanRoles, diagnostics, managed/ungrouped', () => {
  const { inventory } = inventoryCase;
  eq(inventory.roles.map((role) => role.id), ['known'], 'rendered roles');
  ok(inventory.orphanRoles && inventory.orphanRoles.ghost, 'ghost preserved');
  eq(inventory.orphanRoles.ghost.mode, 'open', 'ghost mode');
  eq(inventory.orphanRoles.ghost.groups, { device: 'off' }, 'ghost groups');
  eq(inventory.orphanRoles.ghost.tools, { dead_tool: 'on' }, 'ghost tools');
  ok(inventory.orphanRoles['bad\u0007id'] === undefined, 'invalid orphan id must not round-trip');
  ok(inventory.diagnostics.some((item) => item.text.includes('ghost')), 'orphan diagnostic');
  ok(
    inventory.diagnostics.some((item) => item.text.includes('bad') && item.text.includes('丢弃')),
    'invalid orphan diagnostic mentions the drop',
  );
  ok(inventory.diagnostics.some((item) => item.text.includes('dead_tool')), 'unmanaged tool diagnostic');
  eq(inventory.managed, 2, 'managed count');
  eq(inventory.ungrouped, ['read'], 'ungrouped');
  eq(inventory.editable, true, 'editable');
  eq(inventory.tools.find((tool) => tool.name === 'fofa_search').source, 'fofa', 'tool source');
});

/* --------------------- async regression checks (audit) ------------------ */

const brokenTools = {
  schemas: () => {
    throw new Error('bad schema');
  },
  get: () => undefined,
  restrict: () => () => {},
};
const brokenAgent = makeAgent('expert');
brokenAgent.ctx.tools = brokenTools;
const brokenCtx = makePluginCtx([brokenAgent]);
check('registry read failure: surfaces an error before marking the policy applied', () => {
  assert.throws(() => T.applyAgentPolicy(brokenCtx, brokenAgent, APPLY_CONFIG), /Unable to read the agent tool catalog/);
  eq(T.readAgentState(brokenAgent, T.APPLIED), undefined, 'no APPLIED signature');
  eq(brokenAgent.ctx.restrictions.length, 0, 'no restriction registered');
});

const brokenInventoryCtx = {
  tools: brokenTools,
  get(name) {
    if (name === 'agentPresets') return { list: async () => [] };
    if (name === 'configEditor') return { edit() {}, entries: () => [] };
    return undefined;
  },
};
const brokenInventory = await T.buildInventory(brokenInventoryCtx, T.normalizeConfig({ sources: {}, roles: {} }));
check('buildInventory: registry read failure surfaces an error diagnostic', () => {
  ok(
    brokenInventory.diagnostics.some((item) => item.level === 'error' && item.text.includes('工具注册表读取失败')),
    'error diagnostic',
  );
  eq(brokenInventory.managed, 0, 'managed empty');
});

const secondModule = await import(new URL('../index.js', import.meta.url).href + `?instance=${Date.now()}`);
check('agent state is shared across module instances (lift works after reload)', () => {
  const agent = makeAgent('expert');
  const ctx = makePluginCtx([agent]);
  T.applyAgentPolicy(ctx, agent, APPLY_CONFIG);
  eq(agent.ctx.restrictions.length, 1, 'instance A applied');
  eq(secondModule.__test.liftAllRestrictions(ctx), 1, 'instance B can lift');
  eq(agent.ctx.restrictions.length, 0, 'restriction lifted');
});

const orderedPresets = {
  list: async () => [
    { id: 'b', order: 2 },
    { id: 'a', order: 0, name: 'A' },
  ],
  remoteExportList: async () => ({ presets: [{ id: 'a', isDefault: true }] }),
};
const orderedInventory = await T.buildInventory(
  {
    tools: fakeHostTools(),
    get(name) {
      if (name === 'agentPresets') return orderedPresets;
      if (name === 'configEditor') return { edit() {}, entries: () => [] };
      return undefined;
    },
  },
  T.normalizeConfig({ sources: { fofa: { match: ['fofa_*'] } }, roles: {} }),
);
check('buildInventory: roster order kept and isDefault read from remoteExportList', () => {
  eq(orderedInventory.roles.map((role) => role.id), ['a', 'b'], 'order');
  eq(orderedInventory.roles[0].isDefault, true, 'default flag');
  eq(orderedInventory.roles[1].isDefault, false, 'non-default flag');
  eq(orderedInventory.roles[0].name, 'A', 'name');
});
check('buildInventory: preserve missing preset metadata for Client localization', () => {
  eq(orderedInventory.roles[1].name, undefined, 'missing name is not replaced with the preset id');
  eq(orderedInventory.roles[1].description, undefined, 'missing description stays missing');
  const wire = JSON.parse(JSON.stringify(orderedInventory.roles[1]));
  eq(Object.hasOwn(wire, 'name'), false, 'wire retains the distinction between built-in and authored names');
  eq(wire.id, 'b', 'stable preset identity is unchanged');
});

const perRoleCatalogs = {
  a: [{ name: 'read', provider: { plugin: '@deepseek-ai/dsh-tool-files', official: true } }],
  b: [{ name: 'read', provider: { plugin: '@vendor/documents', official: false } }],
};
const scopedCatalogCtx = {
  tools: {
    toolCatalog: () => [],
    presetToolCatalog: async (_presets, id) => perRoleCatalogs[id],
  },
  get(name) {
    return name === 'agentPresets' ? { list: async () => [{ id: 'a' }, { id: 'b' }] } : undefined;
  },
};
const perRoleInventory = await T.buildInventory(scopedCatalogCtx, T.normalizeConfig({
  discovery: true,
  sources: { documents: { match: ['read'] } },
  roles: { a: { mode: 'open', groups: { '@official': 'off' } } },
}));
check('buildInventory: same-named tools in different presets do not corrupt source diagnostics', () => {
  eq(perRoleInventory.diagnostics, [], 'no false missing-group or empty-match warning');
  eq(perRoleInventory.roleTools.a[0].source, '@official', 'official role source');
  eq(perRoleInventory.roleTools.b[0].source, 'documents', 'third-party custom group');
  eq(perRoleInventory.sources[0].toolCount, 1, 'custom group matches another preset');
  eq(perRoleInventory.roles.find((role) => role.id === 'a').hidden, 1, 'official policy applied');
});

const manualCatalogInventory = await T.buildInventory(scopedCatalogCtx, T.normalizeConfig({
  discovery: false, sources: { documents: { match: ['read'] } },
}));
check('buildInventory: full role catalogs remain available when saved discovery is off', () => {
  eq(manualCatalogInventory.roleTools.a.map((tool) => tool.name), ['read'], 'full role catalog for draft preview');
  eq(manualCatalogInventory.globalTools, [], 'separate global scope');
  eq(manualCatalogInventory.roles[0].managed, 0, 'saved manual policy stays global-only');
});

/* ----------------------- route handler integration --------------------- */

function fakeResponse() {
  return {
    statusCode: 0,
    headers: {},
    writableEnded: false,
    headersSent: false,
    setHeader(key, value) {
      this.headers[key.toLowerCase()] = value;
    },
    end(text) {
      this.body = text;
      this.writableEnded = true;
      this.headersSent = true;
    },
  };
}
function fakeRequest(method, url, headers, body) {
  return {
    method,
    url,
    headers,
    on(event, cb) {
      if (event === 'data' && body !== undefined) cb(Buffer.from(body));
      if (event === 'end') cb();
    },
  };
}
async function callRoute(handler, req) {
  const res = fakeResponse();
  await handler(req, res);
  return { status: res.statusCode, payload: JSON.parse(res.body || '{}') };
}
function routeCtx(editor, agents) {
  const tools = {
    schemas: () => [{ name: 'fofa_search', description: 'search' }],
    get: () => undefined,
    restrict: () => () => {},
  };
  return {
    tools,
    effect: (fn) => fn(),
    get(name) {
      if (name === 'tools') return tools;
      if (name === 'agentPresets') {
        return {
          list: async () => [{ id: 'expert', order: 0 }],
          remoteExportList: async () => ({ presets: [{ id: 'expert', isDefault: true }] }),
        };
      }
      if (name === 'configEditor') return editor === null ? undefined : editor || { edit() {}, entries: () => [] };
      if (name === 'agents') return { list: () => agents || [] };
      if (name === 'connection') return fakeConnection;
      return undefined;
    },
  };
}
const ROUTE_CONFIG = T.normalizeConfig({ sources: { fofa: { match: ['fofa_*'] } }, roles: {} });
const written = [];
const routeEditor = {
  entries: () => [{ options: { id: 'tool-exposure' } }],
  edit: async (entry, produce) => {
    written.push(produce());
  },
};
const routeHandler = T.createRouteHandler(routeCtx(routeEditor), ROUTE_CONFIG);
const guard = { 'x-dsh-tool-exposure-plugin': '1', host: '127.0.0.1:1130', cookie: 'fixture=browser' };
const noGuard = await callRoute(routeHandler, fakeRequest('GET', '/plugins/dsh-tool-exposure/ping', { host: '127.0.0.1:1130' }));
const spoofed = await callRoute(
  routeHandler,
  fakeRequest('GET', '/plugins/dsh-tool-exposure/ping', { ...guard, host: 'evil.example:1130', origin: 'http://evil.example:1130' }),
);
const pinged = await callRoute(routeHandler, fakeRequest('GET', '/plugins/dsh-tool-exposure/ping', guard));
const notFound = await callRoute(routeHandler, fakeRequest('GET', '/plugins/dsh-tool-exposure/nope', guard));
const missingRoles = await callRoute(
  routeHandler,
  fakeRequest('POST', '/plugins/dsh-tool-exposure/save', { ...guard, origin: 'http://127.0.0.1:1130' }, '{"unlisted":"open","sources":{}}'),
);
const validBody = JSON.stringify({
  unlisted: 'open',
  sources: { fofa: { match: ['fofa_*'] } },
  roles: { expert: { mode: 'allow', groups: {}, tools: {} } },
});
const saved = await callRoute(
  routeHandler,
  fakeRequest('POST', '/plugins/dsh-tool-exposure/save', { ...guard, origin: 'http://127.0.0.1:1130' }, validBody),
);
const inventory = await callRoute(routeHandler, fakeRequest('GET', '/plugins/dsh-tool-exposure/inventory', guard));

check('route: guard header and Host/Origin validation', () => {
  eq(noGuard.status, 403, 'missing guard');
  eq(spoofed.status, 403, 'spoofed host');
  eq(pinged.status, 200, 'same-origin ping');
  eq(pinged.payload.ok, true, 'ping ok');
  eq(notFound.status, 404, 'unknown route');
});

const missingConnection = T.createRouteHandler({ get: () => undefined }, ROUTE_CONFIG);
const missingConnectionResult = await callRoute(missingConnection, fakeRequest('POST', `${T.ROUTE_PREFIX}/reset`, guard));
const apiPeerResult = await callRoute(routeHandler, fakeRequest('POST', `${T.ROUTE_PREFIX}/reset`, { ...guard, cookie: 'fixture=api' }));
check('route: state changes require the authenticated browser peer', () => {
  eq(missingConnectionResult.status, 503, 'no authentication service');
  eq(apiPeerResult.status, 403, 'API peer cannot reset rules');
});

check('route: /save validates roles and writes through configEditor', () => {
  eq(missingRoles.status, 400, 'missing roles rejected');
  ok(missingRoles.payload.error.includes('roles'), 'roles error');
  eq(saved.status, 200, 'valid save');
  eq(saved.payload.saved, true, 'saved flag');
  eq(written.length, 1, 'configEditor.edit called once');
  eq(written[0].sources.fofa.match, ['fofa_*'], 'sources written');
  eq(written[0].roles.expert.mode, 'allow', 'roles written');
});

check('route: /inventory renders roles and sources', () => {
  eq(inventory.status, 200, 'inventory status');
  eq(inventory.payload.roles.map((role) => role.id), ['expert'], 'roles');
  eq(inventory.payload.roles[0].isDefault, true, 'default flag');
  eq(inventory.payload.sources[0].id, 'fofa', 'sources');
  eq(inventory.payload.managed, 1, 'managed');
});

let currentConfig = ROUTE_CONFIG;
const editingHandler = T.createRouteHandler(routeCtx({
  entries: routeEditor.entries,
  async edit(_entry, update) {
    currentConfig = update(currentConfig);
  },
}), ROUTE_CONFIG);
const saveFromWindow = (draft) => callRoute(editingHandler, fakeRequest(
  'POST', '/plugins/dsh-tool-exposure/save', guard, JSON.stringify(draft),
));
const olderDraft = { ...JSON.parse(validBody), configVersion: inventory.payload.configVersion };
const firstSave = await saveFromWindow(olderDraft);
const secondSave = await saveFromWindow({ ...olderDraft, unlisted: 'closed' });
const repeatedSave = await saveFromWindow(olderDraft);
check('route: a stale window cannot replace a newer save under the editor lock', () => {
  ok(/^[a-f0-9]{64}$/.test(olderDraft.configVersion), 'inventory reports a revision');
  eq(firstSave.status, 200, 'first save');
  ok(firstSave.payload.configVersion !== olderDraft.configVersion, 'save returns the new revision');
  eq(secondSave.status, 409, 'stale save');
  eq(secondSave.payload.code, 'config_conflict', 'conflict response');
  eq(currentConfig.unlisted, 'open', 'first save preserved');
  eq(currentConfig.roles.expert.mode, 'allow', 'first role policy preserved');
  eq(repeatedSave.payload.configVersion, firstSave.payload.configVersion, 'replaying the same save is safe');
});

const badJson = await callRoute(
  routeHandler,
  fakeRequest('POST', '/plugins/dsh-tool-exposure/save', { ...guard, origin: 'http://127.0.0.1:1130' }, '{not json'),
);
const tooBig = await callRoute(
  routeHandler,
  fakeRequest('POST', '/plugins/dsh-tool-exposure/save', { ...guard, origin: 'http://127.0.0.1:1130' }, 'x'.repeat(300 * 1024)),
);
const missingEditorHandler = T.createRouteHandler(routeCtx(null, []), ROUTE_CONFIG);
const missingEditor = await callRoute(
  missingEditorHandler,
  fakeRequest('POST', '/plugins/dsh-tool-exposure/save', { ...guard, origin: 'http://127.0.0.1:1130' }, validBody),
);
const missingEntryHandler = T.createRouteHandler(
  routeCtx({ entries: () => [], edit: async () => {} }, []),
  ROUTE_CONFIG,
);
const missingEntry = await callRoute(
  missingEntryHandler,
  fakeRequest('POST', '/plugins/dsh-tool-exposure/save', { ...guard, origin: 'http://127.0.0.1:1130' }, validBody),
);
const editFailHandler = T.createRouteHandler(
  routeCtx({ entries: () => [{ options: { id: 'tool-exposure' } }], edit: async () => { throw new Error('boom'); } }, []),
  ROUTE_CONFIG,
);
const editFail = await callRoute(
  editFailHandler,
  fakeRequest('POST', '/plugins/dsh-tool-exposure/save', { ...guard, origin: 'http://127.0.0.1:1130' }, validBody),
);

const closedConfig = T.normalizeConfig({ unlisted: 'closed', sources: { fofa: { match: ['fofa_*'] } }, roles: {} });
const resetAgent = makeAgent('whatever');
T.applyAgentPolicy(makePluginCtx([resetAgent]), resetAgent, closedConfig);
const resetHandler = T.createRouteHandler(routeCtx(undefined, [resetAgent]), closedConfig);
const resetResult = await callRoute(resetHandler, fakeRequest('POST', '/plugins/dsh-tool-exposure/reset', guard));

const debugAgent = makeAgent('expert');
T.setAgentState(debugAgent, T.LEGACY, true);
const debugHandler = T.createRouteHandler(routeCtx(undefined, [debugAgent]), ROUTE_CONFIG);
const debugResult = await callRoute(debugHandler, fakeRequest('POST', '/plugins/dsh-tool-exposure/debug/apply', guard));
const failingAgent = makeAgent('expert');
failingAgent.ctx.tools.restrict = () => { throw new Error('fixture restriction failed'); };
const debugFailure = await callRoute(
  T.createRouteHandler(makePluginCtx([failingAgent]), APPLY_CONFIG),
  fakeRequest('POST', `${T.ROUTE_PREFIX}/debug/apply`, guard),
);
check('route: /debug/apply reports the actual failure', () => {
  eq(debugFailure.payload.ok, false, 'batch status');
  eq(debugFailure.payload.results[0].ok, false, 'agent status');
  eq(debugFailure.payload.results[0].error, 'fixture restriction failed', 'failure reason');
});
const scopedAgent = makeAgent('expert');
scopedAgent.ctx.tools.agentToolCatalog = () => [
  { name: 'inherited_read', provider: { plugin: '@deepseek-ai/dsh-tool-files', official: true } },
  { name: 'vendor_notes', provider: { plugin: 'vendor-notes', official: false } },
];
const debugConfig = T.normalizeConfig({ roles: { expert: { groups: { '@official': 'off' } } } });
const scopedHandler = T.createRouteHandler(makePluginCtx([scopedAgent]), debugConfig);
const scopedDebug = await callRoute(scopedHandler, fakeRequest('GET', '/plugins/dsh-tool-exposure/debug/agents', guard));

check('route: agent diagnostics use inherited tools and their real providers', () => {
  eq(scopedDebug.status, 200, 'diagnostics status');
  eq(scopedDebug.payload.agents[0].managed, 2, 'inherited tools counted');
  eq(scopedDebug.payload.agents[0].denyCount, 1, 'official group restriction counted');
});

check('route: request errors and editor failures map to HTTP status', () => {
  eq(badJson.status, 400, 'bad JSON 400');
  eq(tooBig.status, 413, 'oversized body 413');
  eq(missingEditor.status, 200, 'missing editor returns 200 envelope');
  eq(missingEditor.payload.ok, false, 'missing editor ok false');
  ok(missingEditor.payload.error.includes('configEditor'), 'missing editor message');
  eq(missingEntry.status, 200, 'missing entry returns 200 envelope');
  eq(missingEntry.payload.ok, false, 'missing entry ok false');
  eq(editFail.status, 500, 'editor throw 500');
});

check('route: /reset lifts and /debug/apply clears legacy', () => {
  eq(resetResult.status, 200, 'reset status');
  eq(resetResult.payload.lifted, 1, 'lifted count');
  eq(resetAgent.ctx.restrictions.length, 0, 'restriction lifted');
  eq(debugResult.status, 200, 'debug status');
  eq(debugResult.payload.results[0].ok, true, 'debug applied');
  eq(T.readAgentState(debugAgent, T.LEGACY), false, 'legacy cleared');
});

const { apply: applyPlugin } = await import(new URL('../index.js', import.meta.url).href + `?wiring=${Date.now()}`);
check('apply(): event wiring (created/tool-resolution/claimed/disposed/tools-change)', () => {
  const handlers = {};
  const presets = {
    composedPreset: (agentCtx) => agentCtx.__role,
    list: async () => [],
    remoteExportList: async () => ({ presets: [] }),
  };
  const ctx = {
    get(name) {
      if (name === 'agents') return { list: () => [] };
      if (name === 'agentPresets') return presets;
      return undefined;
    },
    on(event, cb) {
      handlers[event] = cb;
      return () => {};
    },
    effect(fn) {
      return fn();
    },
    inject() {
      return () => {};
    },
  };
  applyPlugin(ctx, {
    sources: { device: { match: ['hdc_*'] } },
    roles: { expert: { mode: 'allow', groups: {}, tools: {} } },
  });
  for (const name of ['agent/created', 'dsh-tool-exposure/before-tool-resolution', 'agent/disposed', 'agent/inbox/claimed', 'tools/change']) {
    ok(typeof handlers[name] === 'function', name + ' wired');
  }
  const agent = makeAgent('expert');
  handlers['agent/created']({ agent });
  eq(agent.ctx.restrictions.length, 1, 'created applies restriction');
  agent.ctx.__role = 'open';
  handlers['dsh-tool-exposure/before-tool-resolution'](agent);
  eq(agent.ctx.restrictions.length, 0, 'new role applied before resolution');
  agent.ctx.__role = 'expert';
  handlers['dsh-tool-exposure/before-tool-resolution'](agent);
  eq(agent.ctx.restrictions.length, 1, 'switch back reapplies restriction');
  handlers['agent/inbox/claimed']({ agent });
  eq(T.readAgentState(agent, T.STARTED), true, 'claimed marks started');
  handlers['agent/disposed']({ agent });
  eq(agent.ctx.restrictions.length, 0, 'disposed releases restriction');
});

/* ------------------------------- result -------------------------------- */

console.log('---');
if (failures > 0) {
  console.log(failures + ' FAILURE(S)');
  process.exitCode = 1;
} else {
  console.log('ALL HOST CHECKS PASSED');
}
