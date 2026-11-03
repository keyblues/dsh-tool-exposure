/**
 * Host-half unit tests for tool-exposure/index.js.
 *
 * Covers config normalization, tool indexing, policy resolution, draft validation,
 * inventory shape (including orphan-role preservation), and the per-agent
 * apply / snapshot / lift state machine — all against fake Cordis contexts.
 *
 * Run: node test/host-policy.mjs
 */
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

check('normalizeConfig: empty config falls back to the five default sources', () => {
  const config = T.normalizeConfig({});
  eq(Object.keys(config.sources).sort(), ['everything', 'fengniao', 'fofatoto', 'hdc', 'icp'], 'sources');
  eq(config.unlisted, 'open', 'unlisted');
  eq(config.roles, {}, 'roles');
});

check('normalizeConfig: explicit empty sources stays empty (no default resurrection)', () => {
  const config = T.normalizeConfig({ sources: {}, roles: {} });
  eq(Object.keys(config.sources), [], 'sources');
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
        const record = { deny: [...filter.deny] };
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

function makePluginCtx(agents) {
  const presets = {
    composedPreset: (agentCtx) => (agentCtx && typeof agentCtx.__role === 'string' ? agentCtx.__role : undefined),
  };
  return {
    tools: fakeHostTools(),
    get(name) {
      if (name === 'agentPresets') return presets;
      if (name === 'agents') return { list: () => agents };
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

check('applyAgentPolicy: unresolved role at creation becomes PENDING, no restriction yet', () => {
  const agent = makeAgent(undefined);
  const ctx = makePluginCtx([agent]);
  const applied = T.applyAgentPolicy(ctx, agent, APPLY_CONFIG);
  eq(applied, false, 'applied');
  eq(agent.ctx.restrictions.length, 0, 'restrictions');
  eq(T.readAgentState(agent, T.PENDING), true, 'pending');
});

check('applyAgentPolicy: pre-step retry resolves role and applies the allow-list', () => {
  const agent = makeAgent(undefined);
  const ctx = makePluginCtx([agent]);
  T.applyAgentPolicy(ctx, agent, APPLY_CONFIG);
  agent.ctx.__role = 'expert';
  const applied = T.applyAgentPolicy(ctx, agent, APPLY_CONFIG, { allowUnresolved: true });
  eq(applied, true, 'applied');
  eq(T.readAgentState(agent, T.PENDING), false, 'pending cleared');
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
  eq(T.readAgentState(agent, T.PENDING), false, 'pending cleared');
});

check('resyncUnstarted: only unstarted non-legacy agents are re-evaluated', () => {
  const pending = makeAgent(undefined);
  const started = makeAgent(undefined);
  const legacy = makeAgent(undefined);
  const ctx = makePluginCtx([pending, started, legacy]);
  T.markLiveAgentsLegacy(ctx);
  // undo legacy for two of them: emulate agents created after plugin load
  T.setAgentState(pending, T.LEGACY, false);
  T.setAgentState(started, T.LEGACY, false);
  T.setAgentState(started, T.STARTED, true);
  pending.ctx.__role = 'expert';
  started.ctx.__role = 'expert';
  legacy.ctx.__role = 'expert';
  T.resyncUnstarted(ctx, APPLY_CONFIG);
  eq(pending.ctx.restrictions.length, 1, 'pending agent restricted');
  eq(started.ctx.restrictions.length, 0, 'started agent untouched');
  eq(legacy.ctx.restrictions.length, 0, 'legacy agent untouched');
});

check('applyAgentPolicy: a failing restrict restores the previous mask (no fail-open)', () => {
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
  const applied = T.applyAgentPolicy(ctx, agent, changed);
  eq(applied, false, 'apply fails');
  eq(agent.ctx.restrictions.length, 1, 'previous restriction restored');
  eq(agent.ctx.restrictions[0].deny, ['hdc_shell'], 'restored deny');
  eq(T.readAgentState(agent, T.APPLIED).signature, 'standard|hdc_shell', 'signature restored');
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

check('applyPendingPolicy: retries unresolved role, then applies unlisted after 3 attempts', () => {
  const closed = T.normalizeConfig({
    unlisted: 'closed',
    sources: { fofa: { match: ['fofa_*'] } },
    roles: { expert: { mode: 'allow', groups: { fofa: 'on' }, tools: {} } },
  });
  const agent = makeAgent(undefined);
  const ctx = makePluginCtx([agent]);
  T.setAgentState(agent, T.PENDING, true);
  T.applyPendingPolicy(ctx, agent, closed);
  eq(T.readAgentState(agent, T.PENDING), true, 'still pending after 1');
  T.applyPendingPolicy(ctx, agent, closed);
  eq(T.readAgentState(agent, T.PENDING), true, 'still pending after 2');
  eq(agent.ctx.restrictions.length, 0, 'not applied yet');
  T.applyPendingPolicy(ctx, agent, closed);
  eq(T.readAgentState(agent, T.PENDING), false, 'gave up after 3');
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

check('isRequestOriginAllowed: rejects DNS-rebinding style Host/Origin', () => {
  const ctx = { get: (name) => (name === 'webServer' ? { getOrigin: () => 'http://127.0.0.1:1130' } : undefined) };
  const req = (headers) => ({ headers });
  eq(T.isRequestOriginAllowed(ctx, req({ host: '127.0.0.1:1130' })), true, 'expected host');
  eq(T.isRequestOriginAllowed(ctx, req({ host: '127.0.0.1:1130', origin: 'http://127.0.0.1:1130' })), true, 'same origin');
  eq(T.isRequestOriginAllowed(ctx, req({ host: 'localhost:1130' })), true, 'loopback alias');
  eq(T.isRequestOriginAllowed(ctx, req({ host: 'evil.example:1130', origin: 'http://evil.example:1130' })), false, 'rebinding host');
  eq(T.isRequestOriginAllowed(ctx, req({ host: '127.0.0.1:1130', origin: 'http://evil.example:1130' })), false, 'cross origin');
  eq(T.isRequestOriginAllowed(ctx, req({})), false, 'missing host');
  const noOrigin = { get: () => undefined };
  eq(T.isRequestOriginAllowed(noOrigin, req({ host: '127.0.0.1:1130' })), true, 'loopback fallback');
  eq(T.isRequestOriginAllowed(noOrigin, req({ host: 'evil.example:1130' })), false, 'fallback blocks rebinding');
  eq(
    T.isRequestOriginAllowed(noOrigin, req({ host: '127.0.0.1:1130', origin: 'http://evil.example:1130' })),
    false,
    'fallback rejects cross origin',
  );
  eq(
    T.isRequestOriginAllowed(noOrigin, req({ host: '127.0.0.1:1130', origin: 'http://localhost:1130' })),
    true,
    'fallback accepts loopback origin',
  );
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
check('registry read failure: fail-closed (no APPLIED, no restriction)', () => {
  eq(T.applyAgentPolicy(brokenCtx, brokenAgent, APPLY_CONFIG), false, 'apply skipped');
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
      if (name === 'webServer') return { getOrigin: () => 'http://127.0.0.1:1130' };
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
const guard = { 'x-dsh-tool-exposure-plugin': '1', host: '127.0.0.1:1130' };
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
check('apply(): event wiring (created/pre-step/claimed/disposed/tools-change)', () => {
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
      fn();
      return () => {};
    },
    inject() {
      return () => {};
    },
  };
  applyPlugin(ctx, {
    sources: { device: { match: ['hdc_*'] } },
    roles: { expert: { mode: 'allow', groups: {}, tools: {} } },
  });
  for (const name of ['agent/created', 'agent/pre-step', 'agent/disposed', 'agent/inbox/claimed', 'tools/change']) {
    ok(typeof handlers[name] === 'function', name + ' wired');
  }
  const agent = makeAgent('expert');
  handlers['agent/created']({ agent });
  eq(agent.ctx.restrictions.length, 1, 'created applies restriction');
  eq(handlers['agent/pre-step']({ agent }, () => 'next'), 'next', 'pre-step returns next()');
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
