/**
 * dsh-tool-exposure — Host half.
 *
 * 按角色（agent preset）管理「第三方插件注册的工具」的暴露面。
 *
 * 机制（全部基于 DSH 现有 API，不改任何内置插件）：
 *   - 受管工具集合 = config.sources 里各组 match 通配符对「全局工具名」展开的并集；
 *     未出现在任何组里的全局工具永远不受本插件影响。
 *   - 角色 = agentPresets.composedPreset(agent.ctx)，即 agent 创建时选中的 preset。
 *   - 对每个新建 agent：解析出该角色应隐藏的受管工具，用 agent.ctx.tools.restrict({ deny })
 *     注册在 agent.ctx.effect() 上 —— 隐藏是「看不见 + 调不到」（UNKNOWN_TOOL），
 *     且与 PTC 模式一致（被隐藏的工具不会生成 SDK 绑定）。
 *   - 快照语义：只在 agent 创建时应用；已有会话保持创建时的工具面（配置保存只影响新会话）。
 *     唯一例外是「尚未开始第一步」的 agent：tools/change 时会重算一次，用于收掉
 *     MCP 等异步晚注册的工具。
 *   - restrict 的硬约束：未知名字 / 空过滤器 / scope-local 名字会抛错。这里只下发
 *     「当前确实已注册的全局工具名」，并跳过空 deny 列表。
 *
 * Client 半（client.js）在 Settings 里渲染矩阵页，通过本文件注册的同源路由读写：
 *   GET  {prefix}/ping
 *   GET  {prefix}/inventory
 *   GET  {prefix}/effective?role=<preset id>
 *   POST {prefix}/save
 *   POST {prefix}/reset
 * 所有请求必须带 x-dsh-tool-exposure-plugin: 1（插件路由 loopback-open，需自定义头
 * 让跨站页面无法构造简单请求）。
 */

const TAG = '[dsh-tool-exposure]';

/** 本插件在 profile 配置里的行 id（与 cordis.patch.yml 保持一致）。 */
const ROW_ID = 'tool-exposure';

/** 同源路由前缀；client.js 里的常量必须与此一致。 */
const ROUTE_PREFIX = '/plugins/dsh-tool-exposure';

/** 自定义请求头：区分本插件页面的请求与跨站简单请求。 */
const GUARD_HEADER = 'x-dsh-tool-exposure-plugin';

/** 每个 agent 对象上的状态槽（Symbol.for 保证跨插件实例/模块重载可复用）。 */
const APPLIED = Symbol.for('dsh-tool-exposure.applied');
const STARTED = Symbol.for('dsh-tool-exposure.started');
const LEGACY = Symbol.for('dsh-tool-exposure.legacy');
/**
 * agent/created 时 preset 可能还没挂载完（实测子代理就是这种情况）：此刻
 * composedPreset() 返回 undefined。解析不到角色的 agent 先挂起，等第一次
 * agent/pre-step（preset 已挂载、请求组装之前）再应用。
 */
const PENDING = Symbol.for('dsh-tool-exposure.pending');
/** 首次 pre-step 仍解析不到角色时的重试计数（避免永久按 unlisted 静默 fail-open）。 */
const PENDING_ATTEMPTS = Symbol.for('dsh-tool-exposure.pending-attempts');

/** tools/change 后的重算去抖（毫秒）。 */
const RESYNC_DEBOUNCE_MS = 120;

/** 保存请求体上限（矩阵配置本身很小，防御异常大包）。 */
const MAX_BODY_BYTES = 256 * 1024;

/** 首次安装时 patch 里的默认 sources（normalizeConfig 在 config 缺省时回退到这里）。 */
const DEFAULT_SOURCES = {
  fofatoto: { label: 'FOFA 测绘', match: ['fofa_*'] },
  icp: { label: 'ICP 备案', match: ['mcp__icp__*'] },
  fengniao: { label: '企业工商', match: ['fengniao_*'] },
  everything: { label: '全盘检索', match: ['everything_*'] },
  hdc: { label: '鸿蒙设备与 DevEco', match: ['hdc_*', 'hms_*'] },
};

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 每个 agent 的插件状态。用 WeakMap 而不是 agent 上的 Symbol 属性：agent 可能被
 * freeze / 只读代理包住，属性写入会静默失败，导致每次 apply 都重复注册一层
 * 永不解绑的 restriction（restrict 取交集，之后放宽配置也永远不生效）。
 * WeakMap 挂在 globalThis 的 Symbol 槽上，保证插件禁用/启用、HMR 产生的新模块
 * 实例仍能读到旧实例写入的状态（否则页面上的“解除现有会话策略”会 lift 不到旧掩码）。
 */
const AGENT_STATE_KEY = Symbol.for('dsh-tool-exposure.agent-state');
const AGENT_STATE =
  globalThis[AGENT_STATE_KEY] instanceof WeakMap ? globalThis[AGENT_STATE_KEY] : (globalThis[AGENT_STATE_KEY] = new WeakMap());

function setAgentState(agent, symbol, value) {
  if (agent === null || typeof agent !== 'object') return false;
  let state = AGENT_STATE.get(agent);
  if (state === undefined) {
    state = {};
    AGENT_STATE.set(agent, state);
  }
  state[symbol] = value;
  return true;
}

function readAgentState(agent, symbol) {
  if (agent === null || typeof agent !== 'object') return undefined;
  const state = AGENT_STATE.get(agent);
  return state === undefined ? undefined : state[symbol];
}

/** 安全地取一个可选服务。 */
function optionalService(ctx, name) {
  try {
    return typeof ctx.get === 'function' ? ctx.get(name) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 通配符（* 与 ?）匹配器；其余字符按字面量处理。
 *
 * 不能用 `new RegExp('.*a.*a.*b')` 这类做法：失败匹配会指数级回溯（实测 8 个 `*a`
 * 就要 100+ 秒），而 match 来自配置，能经 /save 或手改 YAML 植入，会把单线程 Host
 * 卡死。这里用双指针 + 单星回溯，最坏 O(n*m)，不回溯爆炸。
 */
function globToRegExp(pattern) {
  const source = String(pattern);
  return {
    test(name) {
      const text = String(name);
      let si = 0;
      let pi = 0;
      let star = -1;
      let mark = 0;
      while (si < text.length) {
        if (pi < source.length && (source[pi] === '?' || source[pi] === text[si])) {
          si += 1;
          pi += 1;
        } else if (pi < source.length && source[pi] === '*') {
          star = pi;
          pi += 1;
          mark = si;
        } else if (star >= 0) {
          pi = star + 1;
          mark += 1;
          si = mark;
        } else {
          return false;
        }
      }
      while (pi < source.length && source[pi] === '*') pi += 1;
      return pi === source.length;
    },
  };
}

/* ------------------------------------------------------------------ */
/* 配置解析                                                            */
/* ------------------------------------------------------------------ */

/** match 单项/总长度上限：避免超大通配符把编译或匹配拖垮（正常工具名远小于此）。 */
const MAX_MATCH_ITEM_LENGTH = 256;
const MAX_MATCH_TOTAL_LENGTH = 4096;

/** 把 match（数组或单个字符串）归一成去空、限长的字符串数组。 */
function normalizeMatchList(raw) {
  const items = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  const match = [];
  let total = 0;
  for (const item of items) {
    if (typeof item !== 'string') continue;
    // 页面/Host 文档都按逗号分隔书写；手改配置写成单字符串时也要拆开，
    // 否则页面预览与真实策略会不一致。
    for (const part of item.split(',')) {
      const value = part.trim();
      if (value === '') continue;
      if (value.length > MAX_MATCH_ITEM_LENGTH) {
        console.warn(`${TAG} match item dropped (over ${MAX_MATCH_ITEM_LENGTH} chars): ${value.slice(0, 32)}…`);
        continue;
      }
      total += value.length;
      if (total > MAX_MATCH_TOTAL_LENGTH) {
        console.warn(`${TAG} match total length cap (${MAX_MATCH_TOTAL_LENGTH}) reached; remaining patterns dropped`);
        break;
      }
      match.push(value);
    }
  }
  return match;
}

/**
 * 把 patch 里的 raw config 归一成内部结构。
 * 注意：sources 显式写成 {} 表示「没有受管组」，只有字段缺省时才回退默认值；
 * 其它非对象形状（null/数组/字符串）按空集处理，不再静默装回默认组。
 */
function normalizeConfig(raw) {
  const input = isObject(raw) ? raw : {};
  const sources = {};
  const rawSources = input.sources === undefined ? DEFAULT_SOURCES : isObject(input.sources) ? input.sources : {};
  for (const [id, source] of Object.entries(rawSources)) {
    // `sources['__proto__'] = ...` 会改原型而不是建属性，组会被静默吞掉；显式跳过。
    if (id === '__proto__') continue;
    if (!isObject(source)) continue;
    const match = normalizeMatchList(source.match);
    // 空 match 的组保留下来：页面可见、可修复；静默删除会把组内工具变成未归组（策略变宽）。
    sources[id] = {
      label: typeof source.label === 'string' && source.label !== '' ? source.label : id,
      match,
    };
  }
  const roles = {};
  if (isObject(input.roles)) {
    for (const [roleId, role] of Object.entries(input.roles)) {
      if (roleId === '__proto__') continue;
      if (!isObject(role)) continue;
      const groups = {};
      if (isObject(role.groups)) {
        for (const [groupId, value] of Object.entries(role.groups)) {
          if (value === 'on' || value === 'off') groups[groupId] = value;
        }
      }
      const tools = {};
      if (isObject(role.tools)) {
        for (const [name, value] of Object.entries(role.tools)) {
          if (value === 'on' || value === 'off') tools[name] = value;
        }
      }
      roles[roleId] = { mode: role.mode === 'allow' ? 'allow' : 'open', groups, tools };
    }
  }
  return { unlisted: input.unlisted === 'closed' ? 'closed' : 'open', sources, roles };
}

/* ------------------------------------------------------------------ */
/* 工具索引与策略解析                                                  */
/* ------------------------------------------------------------------ */

/**
 * 保留工具名：PTC 模式的 `run_code` 是 transport，dsh-tools 明确要求“per-agent
 * restrictions must not remove it”，restrict 传它会抛错。从受管集合里排除。
 */
const RESERVED_TOOL_NAMES = new Set(['run_code']);

/** 当前全局工具名（不含 preset 作用域内的 scope-local 工具与保留 transport）。 */
function globalToolNames(tools) {
  let schemas;
  try {
    schemas = typeof tools.schemas === 'function' ? tools.schemas() : [];
  } catch (error) {
    // 读取失败 ≠ 没有工具：返回 null 让调用方 fail-closed（保留旧掩码、不落 APPLIED）。
    console.warn(`${TAG} tools.schemas() failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
  const names = new Set();
  for (const schema of Array.isArray(schemas) ? schemas : []) {
    if (!schema || typeof schema.name !== 'string' || schema.name === '') continue;
    if (RESERVED_TOOL_NAMES.has(schema.name)) continue;
    names.add(schema.name);
  }
  return [...names].sort();
}

/**
 * 按 sources 的 match 把全局工具名归组。
 * 同一工具被多个组匹配时，按 sources 的书写顺序取第一个组。
 */
function buildToolIndex(config, names) {
  const groups = [];
  for (const [id, source] of Object.entries(config.sources)) {
    groups.push({
      id,
      label: source.label,
      match: [...source.match],
      matchers: source.match.map(globToRegExp),
      tools: [],
    });
  }
  const owner = new Map();
  const ungrouped = [];
  for (const name of names) {
    let hit = null;
    for (const group of groups) {
      if (group.matchers.some((matcher) => matcher.test(name))) {
        hit = group;
        break;
      }
    }
    if (hit === null) {
      ungrouped.push(name);
    } else {
      hit.tools.push(name);
      owner.set(name, hit.id);
    }
  }
  const managed = names.filter((name) => owner.has(name));
  return { groups, owner, ungrouped, managed, registered: new Set(names) };
}

/** 某角色的原始配置项；未配置返回 null。 */
function roleEntryOf(config, roleId) {
  if (typeof roleId !== 'string' || roleId === '') return null;
  return Object.prototype.hasOwnProperty.call(config.roles, roleId) ? config.roles[roleId] : null;
}

/**
 * 解析一个角色的有效暴露面。
 * 基线：mode=open 全给 / mode=allow 全不给；未配置的角色走 unlisted。
 * 覆盖：groups 次之，tools（单工具例外）最后生效。
 */
function resolveRolePolicy(config, roleId, index) {
  const entry = roleEntryOf(config, roleId);
  const fallbackMode = config.unlisted === 'closed' ? 'allow' : 'open';
  const mode = entry === null ? fallbackMode : entry.mode;
  const groupOverrides = entry === null ? {} : entry.groups;
  const toolOverrides = entry === null ? {} : entry.tools;
  const visible = new Set();
  for (const name of index.managed) {
    const groupId = index.owner.get(name);
    let isVisible = mode !== 'allow';
    const groupValue = groupOverrides[groupId];
    if (groupValue === 'on') isVisible = true;
    else if (groupValue === 'off') isVisible = false;
    const toolValue = toolOverrides[name];
    if (toolValue === 'on') isVisible = true;
    else if (toolValue === 'off') isVisible = false;
    if (isVisible) visible.add(name);
  }
  const hidden = new Set();
  for (const name of index.managed) if (!visible.has(name)) hidden.add(name);
  return { mode, configured: entry !== null, visible, hidden };
}

/* ------------------------------------------------------------------ */
/* 角色识别与逐 agent 应用                                             */
/* ------------------------------------------------------------------ */

/** agent 创建时选中的 preset id；无 preset 组合时返回 null（走 unlisted）。 */
function roleOfAgent(ctx, agent) {
  const presets = optionalService(ctx, 'agentPresets');
  if (!presets || typeof presets.composedPreset !== 'function') return null;
  try {
    const id = presets.composedPreset(agent.ctx);
    return typeof id === 'string' && id !== '' ? id : null;
  } catch {
    return null;
  }
}

/**
 * 对单个 agent 应用（或更新）暴露策略。
 * 快照语义：LEGACY agent（插件加载时已存在的会话）默认不碰，除非 force。
 * 角色解析时机：agent/created 时 preset 可能尚未挂载（实测子代理如此），此时先挂
 * PENDING，由 agent/pre-step 监听器再应用；pre-step 之后仍解析不到就按 unlisted 处理。
 */
function applyAgentPolicy(ctx, agent, config, options = {}) {
  if (!agent || typeof agent !== 'object') return false;
  if (options.force !== true && readAgentState(agent, LEGACY) === true) return false;
  // 用属性访问（agent.ctx.tools）而不是 ctx.get('tools')：服务调用按「调用上下文」定作用域，
  // 只有通过 agent.ctx 访问才会把 restriction 落到该 agent 的作用域上。
  const agentCtx = agent.ctx;
  if (!agentCtx) return false;
  let tools;
  try {
    tools = agentCtx.tools;
  } catch {
    return false;
  }
  if (!tools || typeof tools.restrict !== 'function') return false;

  const presets = optionalService(ctx, 'agentPresets');
  const canResolveRole = Boolean(presets && typeof presets.composedPreset === 'function');
  const roleId = canResolveRole ? roleOfAgent(ctx, agent) : null;
  if ((canResolveRole === false || roleId === null) && options.allowUnresolved !== true) {
    // preset 服务还没挂载、或 created 时角色解析不到：挂起，等 pre-step 再试。
    setAgentState(agent, PENDING, true);
    return false;
  }
  setAgentState(agent, PENDING, false);

  const names = globalToolNames(tools);
  if (names === null) {
    // 注册表读取失败：保持当前掩码，不落 APPLIED（tools/change 后还会再试）。
    return false;
  }
  const index = buildToolIndex(config, names);
  const policy = resolveRolePolicy(config, roleId, index);
  const deny = [...policy.hidden].filter((name) => index.registered.has(name) && !RESERVED_TOOL_NAMES.has(name));
  const signature = `${roleId === null ? '' : roleId}|${deny.join(',')}`;
  const previous = readAgentState(agent, APPLIED);
  if (previous && previous.signature === signature) return true;
  if (previous && typeof previous.dispose === 'function') {
    try {
      previous.dispose();
    } catch {
      /* 旧的 restriction 已随 agent 作用域消失时忽略 */
    }
  }
  if (deny.length === 0) {
    setAgentState(agent, APPLIED, { signature, deny: [], dispose: null });
    return true;
  }
  let dispose = null;
  let registered = null;
  try {
    if (typeof agentCtx.effect === 'function') {
      // effect 的返回值才是 disposer；个别实现返回 undefined，此时退回 register 的返回值。
      const returned = agentCtx.effect(() => {
        registered = agentCtx.tools.restrict({ deny });
        return registered;
      }, 'tool-exposure: restrict');
      dispose = typeof returned === 'function' ? returned : typeof registered === 'function' ? registered : null;
    } else {
      registered = agentCtx.tools.restrict({ deny });
      dispose = registered;
    }
  } catch (error) {
    // effect 可能在 register 之后才抛错：先释放已经注册的那层，避免叠加泄漏。
    if (typeof registered === 'function') {
      try {
        registered();
      } catch {
        /* ignore */
      }
    }
    // 未知名字 / scope-local 名字 / 空过滤器都会抛错。此时旧 restriction 已被释放，
    // 尽量把旧掩码装回去，避免一次失败把 agent 从「已收窄」变成「全开」（fail-open）。
    console.warn(
      `${TAG} restrict failed for role ${roleId === null ? '<unlisted>' : roleId}: ${error instanceof Error ? error.message : String(error)}`,
    );
    let restored = null;
    if (previous && Array.isArray(previous.deny) && previous.deny.length > 0) {
      let restoredRegister = null;
      try {
        if (typeof agentCtx.effect === 'function') {
          const returned = agentCtx.effect(() => {
            restoredRegister = agentCtx.tools.restrict({ deny: previous.deny });
            return restoredRegister;
          }, 'tool-exposure: restrict-restore');
          restored =
            typeof returned === 'function' ? returned : typeof restoredRegister === 'function' ? restoredRegister : null;
        } else {
          restoredRegister = agentCtx.tools.restrict({ deny: previous.deny });
          restored = restoredRegister;
        }
      } catch {
        if (typeof restoredRegister === 'function') {
          try {
            restoredRegister();
          } catch {
            /* ignore */
          }
        }
        restored = null;
      }
    }
    setAgentState(agent, APPLIED, {
      signature: restored === null ? '' : previous.signature,
      deny: restored === null ? [] : previous.deny,
      dispose: restored,
    });
    return false;
  }
  setAgentState(agent, APPLIED, { signature, deny, dispose });
  return true;
}

/**
 * 第一次 agent/pre-step：preset 此时已挂载，是解析角色并应用策略的最早可靠时机。
 * 该监听器必须透传 next()（waterfall 事件）。
 */
function applyPendingPolicy(ctx, agent, config) {
  if (!agent || readAgentState(agent, PENDING) !== true) return;
  const presets = optionalService(ctx, 'agentPresets');
  const resolvable = Boolean(presets && typeof presets.composedPreset === 'function');
  if (resolvable && roleOfAgent(ctx, agent) === null) {
    // preset 仍未挂载：下一轮 pre-step 再试（最多 3 次），而不是立刻按 unlisted 放开。
    const attempts = (readAgentState(agent, PENDING_ATTEMPTS) || 0) + 1;
    setAgentState(agent, PENDING_ATTEMPTS, attempts);
    if (attempts < 3) return;
    console.warn(`${TAG} role still unresolved after ${attempts} pre-step(s); applying the unlisted policy`);
  }
  setAgentState(agent, PENDING, false);
  setAgentState(agent, PENDING_ATTEMPTS, 0);
  applyAgentPolicy(ctx, agent, config, { allowUnresolved: true });
}

/** 插件加载时把已存在的 agent 标记为 LEGACY：它们保持创建时的工具面。 */
function markLiveAgentsLegacy(ctx) {
  const agents = optionalService(ctx, 'agents');
  const list = agents && typeof agents.list === 'function' ? agents.list() : [];
  for (const agent of Array.isArray(list) ? list : []) setAgentState(agent, LEGACY, true);
}

/** tools/change 后，只重算「尚未开始第一步」的 agent（收掉异步晚注册的工具）。 */
function resyncUnstarted(ctx, config) {
  const agents = optionalService(ctx, 'agents');
  const list = agents && typeof agents.list === 'function' ? agents.list() : [];
  for (const agent of Array.isArray(list) ? list : []) {
    try {
      if (!agent || readAgentState(agent, LEGACY) === true || readAgentState(agent, STARTED) === true) continue;
      applyAgentPolicy(ctx, agent, config);
    } catch (error) {
      console.warn(`${TAG} resync failed for one agent: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/** 解除所有 live agent 上由本插件注册的 restriction（矩阵页的逃生按钮）。 */
function liftAllRestrictions(ctx) {
  const agents = optionalService(ctx, 'agents');
  const list = agents && typeof agents.list === 'function' ? agents.list() : [];
  let lifted = 0;
  for (const agent of Array.isArray(list) ? list : []) {
    const applied = readAgentState(agent, APPLIED);
    if (applied && typeof applied.dispose === 'function') {
      try {
        applied.dispose();
        lifted += 1;
      } catch {
        /* 已随作用域消失 */
      }
    }
    // 解除后这些会话按快照语义冻结：既不会在 pre-step 被重新应用（PENDING 清掉），
    // 也不会被 tools/change 重算（标记 LEGACY）。
    setAgentState(agent, PENDING, false);
    setAgentState(agent, LEGACY, true);
    setAgentState(agent, APPLIED, { signature: '', dispose: null });
  }
  return lifted;
}

/* ------------------------------------------------------------------ */
/* 名册 / 矩阵数据                                                     */
/* ------------------------------------------------------------------ */

/** 读取 agent preset 名册（Host 服务不可用时返回空数组）。 */
async function listRoles(ctx) {
  const presets = optionalService(ctx, 'agentPresets');
  if (!presets || typeof presets.list !== 'function') return [];
  let rows;
  try {
    rows = await presets.list();
  } catch (error) {
    console.warn(`${TAG} agentPresets.list() failed: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
  // isDefault 只由 remoteExportList() 提供（list() 的字段集里没有它）。
  const defaults = new Set();
  if (typeof presets.remoteExportList === 'function') {
    try {
      const exported = await presets.remoteExportList();
      const exportedRows = exported && Array.isArray(exported.presets) ? exported.presets : [];
      for (const row of exportedRows) {
        if (isObject(row) && typeof row.id === 'string' && row.isDefault === true) defaults.add(row.id);
      }
    } catch (error) {
      console.warn(
        `${TAG} agentPresets.remoteExportList() failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const roles = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!isObject(row)) continue;
    const id =
      typeof row.id === 'string' && row.id !== ''
        ? row.id
        : typeof row.agentPreset === 'string'
          ? row.agentPreset
          : '';
    if (id === '') continue;
    roles.push({
      id,
      name: typeof row.name === 'string' && row.name !== '' ? row.name : id,
      description: typeof row.description === 'string' ? row.description : '',
      order: typeof row.order === 'number' && Number.isFinite(row.order) ? row.order : null,
      isDefault: defaults.has(id),
      broken: typeof row.broken === 'string' ? row.broken : null,
    });
  }
  // list() 已按 order 排序；这里再兜一次底（order 缺省排最后），保持稳定。
  roles.sort((left, right) => (left.order ?? Infinity) - (right.order ?? Infinity) || left.id.localeCompare(right.id));
  return roles;
}

function toolDescription(tools, name) {
  try {
    const definition = typeof tools.get === 'function' ? tools.get(name) : undefined;
    return definition && typeof definition.description === 'string' ? definition.description : '';
  } catch {
    return '';
  }
}

/** 组装矩阵页所需的完整数据。 */
async function buildInventory(ctx, config) {
  const tools = ctx.tools;
  const names = globalToolNames(tools);
  const diagnostics = [];
  if (names === null) {
    diagnostics.push({
      level: 'error',
      text: '工具注册表读取失败（tools.schemas() 抛错），本次矩阵可能不完整；现有会话的掩码保持不变。',
    });
  }
  const index = buildToolIndex(config, names === null ? [] : names);
  const roles = await listRoles(ctx);
  const roleIds = new Set(roles.map((role) => role.id));

  for (const group of index.groups) {
    if (!SOURCE_ID_PATTERN.test(group.id)) {
      diagnostics.push({ level: 'warn', text: `工具组 id 不合法：${group.id}（页面保存会被拒绝，请用「改名」修正）` });
    }
    if (group.match.length === 0) {
      diagnostics.push({
        level: 'warn',
        text: `工具组「${group.label}」(${group.id}) 的 match 为空，不会匹配任何工具（策略可能比预期更宽）`,
      });
    } else if (group.tools.length === 0) {
      diagnostics.push({ level: 'warn', text: `工具组「${group.label}」(${group.id}) 当前没有匹配到任何已注册工具` });
    }
  }
  for (const roleId of Object.keys(config.roles)) {
    if (roleIds.has(roleId)) continue;
    if (!isValidRoleId(roleId)) {
      diagnostics.push({ level: 'warn', text: `角色 id 不合法：${roleId}（页面保存时会丢弃该条目，请修正 cordis.patch.yml）` });
    } else {
      diagnostics.push({ level: 'warn', text: `配置里的角色「${roleId}」当前没有对应的 agent preset（配置保留，不影响运行）` });
    }
  }
  for (const [roleId, role] of Object.entries(config.roles)) {
    for (const groupId of Object.keys(role.groups)) {
      if (!index.groups.some((group) => group.id === groupId)) {
        diagnostics.push({ level: 'warn', text: `角色「${roleId}」引用了不存在的工具组「${groupId}」` });
      }
    }
    for (const name of Object.keys(role.tools)) {
      if (!index.owner.has(name)) {
        diagnostics.push({ level: 'warn', text: `角色「${roleId}」引用了未受管的工具「${name}」` });
      }
    }
  }

  const roleViews = roles.map((role) => {
    const entry = roleEntryOf(config, role.id);
    const policy = resolveRolePolicy(config, role.id, index);
    return {
      id: role.id,
      name: role.name,
      description: role.description,
      isDefault: role.isDefault,
      broken: role.broken,
      configured: entry !== null,
      mode: entry === null ? (config.unlisted === 'closed' ? 'allow' : 'open') : entry.mode,
      groups: entry === null ? {} : entry.groups,
      tools: entry === null ? {} : entry.tools,
      managed: index.managed.length,
      visible: policy.visible.size,
      hidden: policy.hidden.size,
    };
  });

  const editor = optionalService(ctx, 'configEditor');
  const editable = Boolean(editor && typeof editor.edit === 'function');

  // 配置里有、但当前名册里已经没有的角色（preset 被卸载/改名）。页面不渲染它们，
  // 但必须原样回传给客户端并在保存时保留，否则一次保存就会静默删掉这些策略。
  // 非法 role id（手改配置才会出现）不回传：否则 normalizeDraft 会拒绝整次保存，
  // 让页面无法保存任何修改；这类条目只保留在磁盘配置里并给一条诊断。
  const orphanRoles = {};
  for (const [roleId, role] of Object.entries(config.roles)) {
    if (roleIds.has(roleId)) continue;
    if (!isValidRoleId(roleId)) continue;
    orphanRoles[roleId] = { mode: role.mode, groups: { ...role.groups }, tools: { ...role.tools } };
  }

  return {
    ok: true,
    rowId: ROW_ID,
    unlisted: config.unlisted,
    sources: index.groups.map((group) => ({
      id: group.id,
      label: group.label,
      match: group.match,
      toolCount: group.tools.length,
    })),
    roles: roleViews,
    orphanRoles,
    tools: (names === null ? [] : names).map((name) => ({
      name,
      source: index.owner.get(name) || null,
      description: toolDescription(tools, name),
    })),
    managed: index.managed.length,
    ungrouped: index.ungrouped,
    diagnostics,
    editable,
    editableHint: editable ? null : '当前环境没有 configEditor 服务，无法从页面保存；请直接编辑本 profile 的 cordis.patch.yml。',
    generatedAt: Date.now(),
  };
}

/** 某角色（或未配置角色）的最终可见清单，供页面预览与验收。 */
async function buildEffective(ctx, config, roleId) {
  const tools = ctx.tools;
  const names = globalToolNames(tools);
  const index = buildToolIndex(config, names === null ? [] : names);
  const roles = await listRoles(ctx);
  const role = typeof roleId === 'string' && roleId !== '' ? roleId : null;
  const known = role === null ? false : roles.some((item) => item.id === role);
  const policy = resolveRolePolicy(config, role, index);
  return {
    ok: true,
    role,
    known,
    mode: policy.mode,
    configured: policy.configured,
    managed: index.managed.length,
    visible: [...policy.visible].sort(),
    hidden: [...policy.hidden].sort(),
  };
}

/* ------------------------------------------------------------------ */
/* 保存（矩阵页 → profile 配置）                                       */
/* ------------------------------------------------------------------ */

/**
 * 角色 id 来自 preset registry（registry 只要求 trim 非空，z.string()），因此写入侧
 * 必须接受任何合法 roster id（大写、点、下划线、空格、非 ASCII 都可能），否则页面
 * 只要出现一个自定义 preset 就会整页保存 400。只挡控制字符和危险对象键。
 */
function isValidRoleId(id) {
  return (
    typeof id === 'string' &&
    id !== '' &&
    id.length <= 64 &&
    id.trim() === id &&
    !/[\u0000-\u001f\u007f]/.test(id) &&
    id !== '__proto__' &&
    id !== 'prototype' &&
    id !== 'constructor'
  );
}

/** 工具组 id 由页面生成（slug）：首字符限定字母，避免纯数字键打乱“书写顺序”语义。 */
const SOURCE_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

/** 校验并归一矩阵页提交的草稿；返回 { errors, config }。 */
function normalizeDraft(input) {
  const errors = [];
  const draft = isObject(input) ? input : {};
  // sources 是受管集合的唯一来源：缺字段时拒绝保存，避免一次空请求把现有配置清空。
  if (!isObject(draft.sources)) errors.push('缺少 sources 字段：拒绝用空请求覆盖现有工具组配置');
  // roles 同样是覆盖写：缺字段/非对象时拒绝，避免旧客户端或脚本静默清空角色策略。
  if (!isObject(draft.roles)) errors.push('缺少 roles 字段：拒绝用空请求覆盖现有角色策略');
  const unlisted = draft.unlisted === 'closed' ? 'closed' : 'open';

  const sources = {};
  const rawSources = isObject(draft.sources) ? draft.sources : {};
  for (const [id, source] of Object.entries(rawSources)) {
    if (!SOURCE_ID_PATTERN.test(id)) {
      errors.push(`工具组 id 不合法：${id}（只能以小写字母开头，包含小写字母、数字和连字符）`);
      continue;
    }
    if (!isObject(source)) {
      errors.push(`工具组 ${id} 的内容不合法`);
      continue;
    }
    const rawMatch = Array.isArray(source.match) ? source.match : typeof source.match === 'string' ? [source.match] : [];
    // 先按逗号拆，再做长度校验：与加载路径（normalizeConfig）保持一致，
    // 否则 "200 字符 + 逗号 + 200 字符" 会被误判为超长。
    const matchParts = [];
    for (const item of rawMatch) {
      if (typeof item !== 'string') continue;
      for (const part of item.split(',')) {
        const value = part.trim();
        if (value !== '') matchParts.push(value);
      }
    }
    const matchTotal = matchParts.reduce((sum, item) => sum + item.length, 0);
    if (matchParts.some((item) => item.length > MAX_MATCH_ITEM_LENGTH) || matchTotal > MAX_MATCH_TOTAL_LENGTH) {
      errors.push(`工具组 ${id} 的 match 过长（单项上限 ${MAX_MATCH_ITEM_LENGTH}，总长上限 ${MAX_MATCH_TOTAL_LENGTH}）`);
      continue;
    }
    const match = matchParts;
    if (match.length === 0) {
      errors.push(`工具组 ${id} 的 match 不能为空`);
      continue;
    }
    sources[id] = {
      label: typeof source.label === 'string' && source.label.trim() !== '' ? source.label.trim() : id,
      match,
    };
  }

  const roles = {};
  const rawRoles = isObject(draft.roles) ? draft.roles : {};
  for (const [roleId, role] of Object.entries(rawRoles)) {
    if (!isValidRoleId(roleId)) {
      errors.push(`角色 id 不合法：${roleId}（来自 preset 的 id 不能为空、不能含控制字符）`);
      continue;
    }
    if (!isObject(role)) {
      errors.push(`角色 ${roleId} 的内容不合法`);
      continue;
    }
    const groups = {};
    if (isObject(role.groups)) {
      for (const [groupId, value] of Object.entries(role.groups)) {
        if (value === 'on' || value === 'off') groups[groupId] = value;
      }
    }
    const tools = {};
    if (isObject(role.tools)) {
      for (const [name, value] of Object.entries(role.tools)) {
        if (value === 'on' || value === 'off') tools[name] = value;
      }
    }
    roles[roleId] = { mode: role.mode === 'allow' ? 'allow' : 'open', groups, tools };
  }

  return { errors, config: { unlisted, sources, roles } };
}

/** 把矩阵草稿写回本插件在 profile 中的配置行。 */
async function saveDraft(ctx, draft) {
  const { errors, config } = normalizeDraft(draft);
  if (errors.length > 0) return { status: 400, body: { ok: false, error: errors.join('；') } };
  const editor = optionalService(ctx, 'configEditor');
  if (!editor || typeof editor.edit !== 'function') {
    return {
      status: 200,
      body: { ok: false, error: '当前环境没有 configEditor 服务，无法从页面保存；请直接编辑本 profile 的 cordis.patch.yml。' },
    };
  }
  const entries = typeof editor.entries === 'function' ? editor.entries() : [];
  const entry = (Array.isArray(entries) ? entries : []).find((candidate) => candidate?.options?.id === ROW_ID);
  if (entry === undefined) {
    return {
      status: 200,
      body: { ok: false, error: `找不到本插件在 profile 中的配置行（id: ${ROW_ID}），请直接编辑本 profile 的 cordis.patch.yml。` },
    };
  }
  await editor.edit(entry, () => config);
  return { status: 200, body: { ok: true, saved: true, appliedTo: 'new-sessions' } };
}

/* ------------------------------------------------------------------ */
/* 同源 HTTP 路由                                                      */
/* ------------------------------------------------------------------ */

function sendJson(res, status, body) {
  if (res.writableEnded === true || res.headersSent === true) return;
  const text = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(text);
}

/** 带 HTTP 状态码的错误，供路由 catch 映射（而不是一律 500）。 */
function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        fail(httpError(413, '请求体过大'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(httpError(400, '请求体不是合法 JSON'));
      }
    });
    req.on('error', (error) => fail(error));
  });
}

/**
 * 同源校验：guard header 不是秘密，DNS rebinding 下攻击页面的 origin 与请求 Host
 * 相同（都指向攻击者域名），浏览器不会拦截自定义头。因此必须校验 Host/Origin 是
 * 本机 webServer 的 origin 或 loopback，挡住 rebinding 驱动的 /save、/reset。
 */
function isRequestOriginAllowed(ctx, req) {
  const hostHeader = typeof req.headers.host === 'string' ? req.headers.host.trim().toLowerCase() : '';
  if (hostHeader === '') return false;
  const originHeader = typeof req.headers.origin === 'string' ? req.headers.origin.trim().toLowerCase() : '';
  const hostnameOf = (value) => value.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  const isLoopback = (hostname) => hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
  const webServer = optionalService(ctx, 'webServer');
  let expectedOrigin = '';
  try {
    if (webServer && typeof webServer.getOrigin === 'function') expectedOrigin = String(webServer.getOrigin()).toLowerCase();
  } catch {
    expectedOrigin = '';
  }
  if (expectedOrigin !== '') {
    let expectedHost = '';
    try {
      expectedHost = new URL(expectedOrigin).host.toLowerCase();
    } catch {
      expectedHost = '';
    }
    if (expectedHost !== '' && hostHeader === expectedHost) return originHeader === '' || originHeader === expectedOrigin;
    // 允许 localhost / 127.0.0.1 互访；Origin（若有）也必须是 loopback。
    if (isLoopback(hostnameOf(hostHeader))) {
      if (originHeader === '') return true;
      try {
        return isLoopback(hostnameOf(new URL(originHeader).host));
      } catch {
        return false;
      }
    }
    return false;
  }
  // 服务不支持 getOrigin（尚未 listen）时退化为 loopback 白名单；Origin 若存在也必须 loopback。
  if (!isLoopback(hostnameOf(hostHeader))) return false;
  if (originHeader === '') return true;
  try {
    return isLoopback(hostnameOf(new URL(originHeader).host));
  } catch {
    return false;
  }
}

function createRouteHandler(ctx, config) {
  return async function handle(req, res) {
    // Node 会把重复的请求头合并成 "1, 1"，按逗号列表判断，避免误拒。
    const guard = req.headers[GUARD_HEADER];
    const guarded = typeof guard === 'string' && guard.split(',').some((part) => part.trim() === '1');
    if (!guarded) {
      sendJson(res, 403, { ok: false, error: 'forbidden' });
      return;
    }
    if (!isRequestOriginAllowed(ctx, req)) {
      sendJson(res, 403, { ok: false, error: 'forbidden' });
      return;
    }
    let url;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      sendJson(res, 400, { ok: false, error: 'invalid url' });
      return;
    }
    const sub = url.pathname.startsWith(ROUTE_PREFIX) ? url.pathname.slice(ROUTE_PREFIX.length) : '';
    try {
      if (req.method === 'GET' && sub === '/ping') {
        sendJson(res, 200, { ok: true, rowId: ROW_ID, editable: Boolean(optionalService(ctx, 'configEditor')) });
        return;
      }
      if (req.method === 'GET' && sub === '/inventory') {
        sendJson(res, 200, await buildInventory(ctx, config));
        return;
      }
      if (req.method === 'GET' && sub === '/effective') {
        sendJson(res, 200, await buildEffective(ctx, config, url.searchParams.get('role')));
        return;
      }
      // 诊断：列出 live agent 的角色解析与已应用策略（不含任何用户数据）。
      if (req.method === 'GET' && sub === '/debug/agents') {
        const agents = optionalService(ctx, 'agents');
        const list = agents && typeof agents.list === 'function' ? agents.list() : [];
        const rows = [];
        for (const agent of Array.isArray(list) ? list : []) {
          let names = [];
          try {
            names = globalToolNames(agent.ctx.tools);
          } catch {
            names = [];
          }
          const index = buildToolIndex(config, names === null ? [] : names);
          const roleId = roleOfAgent(ctx, agent);
          const policy = resolveRolePolicy(config, roleId, index);
          const deny = [...policy.hidden].filter((name) => index.registered.has(name));
          const applied = readAgentState(agent, APPLIED);
          rows.push({
            id: String(agent.id),
            role: roleId,
            mode: policy.mode,
            managed: index.managed.length,
            denyCount: deny.length,
            applied: applied ? applied.signature : null,
            started: readAgentState(agent, STARTED) === true,
            legacy: readAgentState(agent, LEGACY) === true,
            pending: readAgentState(agent, PENDING) === true,
          });
        }
        sendJson(res, 200, { ok: true, agents: rows });
        return;
      }
      // 诊断：对全部 live agent 强制重新应用一次策略（包含 legacy，用于排查）。
      if (req.method === 'POST' && sub === '/debug/apply') {
        const agents = optionalService(ctx, 'agents');
        const list = agents && typeof agents.list === 'function' ? agents.list() : [];
        const results = [];
        for (const agent of Array.isArray(list) ? list : []) {
          const roleId = roleOfAgent(ctx, agent);
          try {
            const forced = applyAgentPolicy(ctx, agent, config, { force: true, allowUnresolved: true });
            // 强制应用后回到常规快照规则：否则这次覆盖永远不会被后续配置代际 reconcile。
            if (forced) setAgentState(agent, LEGACY, false);
            const applied = readAgentState(agent, APPLIED);
            results.push({ id: String(agent.id), role: roleId, ok: true, applied: applied ? applied.signature : null });
          } catch (error) {
            results.push({
              id: String(agent.id),
              role: roleId,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        sendJson(res, 200, { ok: true, results });
        return;
      }
      if (req.method === 'POST' && sub === '/save') {
        const draft = await readJsonBody(req);
        const result = await saveDraft(ctx, draft);
        sendJson(res, result.status, result.body);
        return;
      }
      if (req.method === 'POST' && sub === '/reset') {
        const lifted = liftAllRestrictions(ctx);
        sendJson(res, 200, { ok: true, lifted });
        return;
      }
      sendJson(res, 404, { ok: false, error: 'not found' });
    } catch (error) {
      const status = error && typeof error.status === 'number' ? error.status : 500;
      sendJson(res, status, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  };
}

/** 等 webServer 服务出现后挂载路由（插件可能先于 web 宿主激活）。 */
function mountRoutes(ctx, config) {
  // 不能用一次性布尔：webServer 是可替换服务，替换后旧路由随旧 ctx 释放，必须重挂。
  let registeredFor = null;
  const mount = (hostCtx) => {
    const webServer = optionalService(hostCtx, 'webServer');
    if (!webServer || typeof webServer.register !== 'function') return;
    if (registeredFor === webServer) return;
    registeredFor = webServer;
    try {
      hostCtx.effect(
        () => webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: createRouteHandler(hostCtx, config) }),
        'tool-exposure: routes',
      );
    } catch (error) {
      registeredFor = null;
      console.warn(`${TAG} route registration failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  if (typeof ctx.inject === 'function') ctx.inject(['webServer'], (webCtx) => mount(webCtx));
  mount(ctx);
}

/* ------------------------------------------------------------------ */
/* 插件入口                                                            */
/* ------------------------------------------------------------------ */

/** Cordis 插件名（Loader 诊断用）。 */
export const name = 'dsh-tool-exposure';

/** 工具注册表是硬依赖；其余服务（agentPresets / agents / configEditor / webServer）按需探测。 */
export const inject = ['tools'];

/** Cordis 插件入口。 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);

  // 插件加载/重载时已存在的 agent：保持它们创建时的工具面（快照语义）。
  // agents 服务异常不应让整个插件（含设置页路由）加载失败。
  try {
    markLiveAgentsLegacy(ctx);
  } catch (error) {
    console.warn(`${TAG} markLiveAgentsLegacy failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  ctx.on('agent/created', (payload) => {
    const agent = payload && payload.agent;
    if (!agent) return;
    try {
      applyAgentPolicy(ctx, agent, config);
    } catch (error) {
      console.warn(`${TAG} apply on agent/created failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  // agent/created 时 preset 可能还没挂载：第一次 pre-step 补应用（此时请求尚未组装）。
  ctx.on('agent/pre-step', (payload, next) => {
    const agent = payload && payload.agent;
    if (agent) {
      try {
        applyPendingPolicy(ctx, agent, config);
      } catch (error) {
        console.warn(`${TAG} apply on agent/pre-step failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return next();
  });

  ctx.on('agent/disposed', (payload) => {
    const agent = payload && payload.agent;
    const applied = readAgentState(agent, APPLIED);
    if (applied && typeof applied.dispose === 'function') {
      try {
        applied.dispose();
      } catch {
        /* agent 作用域已释放 */
      }
    }
  });

  // 第一个用户消息被领取 = 该 agent 已经进入工作状态，之后不再重算（快照语义）。
  ctx.on('agent/inbox/claimed', (payload) => {
    const agent = payload && payload.agent;
    if (agent) setAgentState(agent, STARTED, true);
  });

  // 工具集变化（晚注册的 MCP 工具、HMR 等）：只收「还没开始」的 agent。
  ctx.effect(() => {
    let timer = null;
    const off = ctx.on('tools/change', () => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        try {
          resyncUnstarted(ctx, config);
        } catch (error) {
          console.warn(`${TAG} resync failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }, RESYNC_DEBOUNCE_MS);
    });
    return () => {
      off();
      if (timer !== null) clearTimeout(timer);
    };
  }, 'tool-exposure: tools/change resync');

  mountRoutes(ctx, config);
}

/** 仅本地测试使用；不属于插件契约。 */
export const __test = {
  DEFAULT_SOURCES,
  ROW_ID,
  ROUTE_PREFIX,
  APPLIED,
  LEGACY,
  PENDING,
  STARTED,
  applyAgentPolicy,
  applyPendingPolicy,
  buildEffective,
  createRouteHandler,
  buildInventory,
  buildToolIndex,
  globToRegExp,
  globalToolNames,
  isRequestOriginAllowed,
  liftAllRestrictions,
  listRoles,
  markLiveAgentsLegacy,
  mountRoutes,
  normalizeMatchList,
  setAgentState,
  normalizeConfig,
  normalizeDraft,
  readAgentState,
  resolveRolePolicy,
  resyncUnstarted,
};
