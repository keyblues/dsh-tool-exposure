/**
 * dsh-tool-exposure — Host half.
 *
 * 按角色（agent preset）管理继承工具的暴露面，按真实注册插件自动分组。
 *
 * 机制（全部基于 DSH 现有 API，不改任何内置插件）：
 *   - discovery 模式管理全局与 ancestor preset 工具，官方工具归为一组；
 *     老配置保留 sources 匹配范围，agent 自身注册的工具不参与限制。
 *   - 会话保留创建时的规则，用当前绑定的 preset 和工具目录计算可见性。
 *   - agent.ctx.tools.restrict() 作用于该会话。限制随会话退出或插件卸载释放。
 *     自动发现的白名单使用 allow 掩码，覆盖尚未注册的继承工具。
 *   - restrict 要求提供 allow 或 deny，且不能传未知或本作用域注册的工具名。
 *     这里只下发已注册的继承工具名，并跳过空 deny 列表。
 *   - MCP 除了工具还会往系统提示词注入服务器名单（mcp-resource-servers）与
 *     每服务器 instructions（mcp:<server>），restrict 不影响它们。这里为每个
 *     agent 注册作用域 system-prompt/assemble 监听器，按同一套组策略裁剪：
 *     组关闭（或组内工具全部隐藏）时，该服务器的提示词与名单条目一并消失；
 *     没有可见资源工具或服务器时整节删除。零工具服务器同样成组可管理。
 *
 * Client 半（client.js）在 Settings 里渲染矩阵页，通过本文件注册的同源路由读写：
 *   GET  {prefix}/ping
 *   GET  {prefix}/inventory
 *   GET  {prefix}/effective?role=<preset id>
 *   POST {prefix}/save
 *   POST {prefix}/reset
 * 所有请求使用 DSH 的连接鉴权并携带 x-dsh-tool-exposure-plugin: 1。
 */

import { createHash } from 'node:crypto';
import { MCP_SERVER_NAME, providerGroup } from './providers.js';

const TAG = '[dsh-tool-exposure]';

/** 本插件在 profile 配置里的行 id（与 cordis.patch.yml 保持一致）。 */
const ROW_ID = 'tool-exposure';

/** 同源路由前缀；client.js 里的常量必须与此一致。 */
const ROUTE_PREFIX = '/plugins/dsh-tool-exposure';

/** 自定义请求头：区分本插件页面的请求与跨站简单请求。 */
const GUARD_HEADER = 'x-dsh-tool-exposure-plugin';

/** 每个 agent 对象上的状态槽（Symbol.for 保证跨插件实例/模块重载可复用）。 */
const APPLIED = Symbol.for('dsh-tool-exposure.applied');
const POLICY_SNAPSHOT = Symbol.for('dsh-tool-exposure.policy-snapshot');
const STARTED = Symbol.for('dsh-tool-exposure.started');
const LEGACY = Symbol.for('dsh-tool-exposure.legacy');
/** 提示词过滤器（system-prompt/assemble 作用域监听器）的清理函数。 */
const PROMPT_FILTER = Symbol.for('dsh-tool-exposure.prompt-filter');
/** waterfall 过滤时读取的当次策略视图（mode + 工具可见集 + 服务器提示词可见性）。 */
const POLICY_VIEW = Symbol.for('dsh-tool-exposure.policy-view');

/* ------------------------------------------------------------------ */
/* MCP 提示词常量（与 @deepseek-ai/dsh-mcp-resources / dsh-mcp-client 对齐） */
/* ------------------------------------------------------------------ */

/** dsh-mcp-resources 注册的服务器名单 section 名。 */
const RESOURCE_SECTION = 'mcp-resource-servers';
/** 名单 section 的正文标题；上游改名时作为文本兜底识别。 */
const RESOURCE_SECTION_HEADING = '## MCP resource servers';
/** dsh-mcp-client 按服务器注册的 instructions section：mcp:<server>。 */
const MCP_SECTION = /^mcp:([A-Za-z0-9_-]{1,32})$/;
/** 名单 section 中点名的三个共享资源工具（官方包注册，工具级可隐藏）。 */
const RESOURCE_TOOLS = ['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'];

/** 复刻 dsh-mcp-resources 的名单文本；全部可见时与上游逐字节一致。 */
function resourceSectionText(toolNames, serverNames) {
  const mention = toolNames.length === 1
    ? toolNames[0]
    : `${toolNames.slice(0, -1).join(', ')}, or ${toolNames[toolNames.length - 1]}`;
  return `## MCP resource servers\n\nUse ${mention} with one of these names as the server argument: ${JSON.stringify(serverNames)}.`;
}

/** 保存请求体上限（矩阵配置本身很小，防御异常大包）。 */
const MAX_BODY_BYTES = 256 * 1024;

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
 * 新安装自动发现工具。没有 discovery 字段的已有 sources 配置保留原有管理范围。
 */
function normalizeConfig(raw) {
  const input = isObject(raw) ? raw : {};
  const sources = {};
  const rawSources = isObject(input.sources) ? input.sources : {};
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
  const discovery = input.discovery === true || (input.discovery === undefined && input.sources === undefined);
  return { discovery, unlisted: input.unlisted === 'closed' ? 'closed' : 'open', sources, roles };
}

function configVersion(config) {
  return createHash('sha256').update(JSON.stringify(config)).digest('hex');
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

/** Read registration-owned metadata, or expose an honest unknown-provider fallback. */
function toolCatalogOf(tools, agent = null) {
  try {
    let catalog;
    if (agent !== null && typeof tools.agentToolCatalog === 'function') catalog = tools.agentToolCatalog(agent);
    else if (typeof tools.toolCatalog === 'function') catalog = tools.toolCatalog();
    else {
      const names = globalToolNames(tools);
      if (names === null) return null;
      catalog = names.map((name) => ({ name, description: toolDescription(tools, name), provider: null }));
    }
    if (!Array.isArray(catalog)) throw new TypeError('Tool catalog must be an array');
    return catalog.filter((tool) => tool && typeof tool.name === 'string' && tool.name !== '' && !RESERVED_TOOL_NAMES.has(tool.name));
  } catch (error) {
    console.warn(`${TAG} tool catalog failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * 发现配置过的 MCP 服务器名单（包含没有任何工具、只提供 instructions/资源的服务器）。
 *
 * 来源：mcpManager.list()（Settings 管理的服务器）、configEditor 里的直接
 * dsh-mcp-client 配置行、以及工具目录 provider.mcpServer。三处都只是内存读取；
 * 任一来源失败只降级（少发现几个组），不影响策略本身。
 */
function discoverMcpServers(ctx, catalogs = []) {
  const names = new Set();
  for (const catalog of catalogs) {
    if (!Array.isArray(catalog)) continue;
    for (const tool of catalog) {
      const server = tool && typeof tool === 'object' ? tool.provider?.mcpServer : undefined;
      if (typeof server === 'string' && MCP_SERVER_NAME.test(server)) names.add(server);
    }
  }
  const manager = optionalService(ctx, 'mcpManager');
  if (manager && typeof manager.list === 'function') {
    try {
      for (const row of manager.list() || []) {
        if (isObject(row) && typeof row.name === 'string' && MCP_SERVER_NAME.test(row.name)) names.add(row.name);
      }
    } catch (error) {
      console.warn(`${TAG} mcpManager.list() failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const editor = optionalService(ctx, 'configEditor');
  if (editor && typeof editor.entries === 'function') {
    try {
      for (const entry of editor.entries() || []) {
        const options = entry && typeof entry === 'object' ? entry.options : undefined;
        if (options?.name !== '@deepseek-ai/dsh-mcp-client') continue;
        const server = options?.config?.serverName;
        if (typeof server === 'string' && MCP_SERVER_NAME.test(server)) names.add(server);
      }
    } catch (error) {
      console.warn(`${TAG} configEditor.entries() failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return [...names].sort();
}

/**
 * 全局 MCP 按服务器归组，其余官方工具归在一起。其他工具优先匹配自定义组。
 * 关闭 discovery 时只使用自定义 sources 的第一个匹配组。
 *
 * @param {string[]} servers 已配置但可能没有工具的 MCP 服务器名；
 *   自动发现模式下为它们建立零工具组，用来管理 instructions/资源提示词。
 */
function buildToolIndex(config, names, catalog = [], servers = []) {
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
  const providers = new Map(catalog.map((tool) => [tool.name, tool.provider || null]));
  const automatic = new Map();
  const automaticGroup = (source) => {
    if (!automatic.has(source.id)) {
      automatic.set(source.id, { ...source, automatic: true, match: [], matchers: [], tools: [] });
    }
    return automatic.get(source.id);
  };
  const prioritized = (group) => group.kind === 'official' || group.kind === 'mcp';
  for (const name of names) {
    const provider = providers.get(name) || null;
    const detected = config.discovery ? providerGroup(provider) : null;
    let hit = detected && prioritized(detected) ? automaticGroup(detected) : null;
    for (const group of hit === null ? groups : []) {
      if (group.matchers.some((matcher) => matcher.test(name))) {
        hit = group;
        break;
      }
    }
    if (hit === null && detected) hit = automaticGroup(detected);
    if (hit === null) {
      ungrouped.push(name);
    } else {
      hit.tools.push(name);
      owner.set(name, hit.id);
    }
  }
  const rank = { official: 0, mcp: 1, plugin: 2, unknown: 3 };
  // 没有工具的服务器也要成组：组的开关同时管理它在系统提示词里的
  // instructions section 与服务器名单中的出现。
  if (config.discovery) {
    for (const server of servers) {
      if (typeof server !== 'string' || !MCP_SERVER_NAME.test(server)) continue;
      const id = `@mcp/${server}`;
      if (automatic.has(id)) continue;
      automaticGroup({ id, label: server, kind: 'mcp' });
    }
  }
  const discovered = [...automatic.values()].sort((left, right) =>
    rank[left.kind] - rank[right.kind] || left.label.localeCompare(right.label));
  groups.unshift(...discovered.filter(prioritized));
  groups.push(...discovered.filter((group) => !prioritized(group)));
  const managed = names.filter((name) => owner.has(name));
  return { groups, owner, ungrouped, managed, registered: new Set(names), providers };
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
 *
 * serverPrompts：每个 MCP 服务器在系统提示词中的可见性（instructions section
 * 与服务器名单）。规则：组开关（含 mode 基线）决定基础值；组内有工具时至少
 * 要有一个工具可见，全部工具被单独关闭时提示词一并隐藏。
 */
function resolveRolePolicy(config, roleId, index) {
  const entry = roleEntryOf(config, roleId);
  const fallbackMode = config.unlisted === 'closed' ? 'allow' : 'open';
  const mode = entry === null ? fallbackMode : entry.mode;
  const groupOverrides = entry === null ? {} : entry.groups;
  const toolOverrides = entry === null ? {} : entry.tools;
  const visible = new Set();
  const visiblePerGroup = new Map();
  for (const name of index.managed) {
    const groupId = index.owner.get(name);
    let isVisible = mode !== 'allow';
    const groupValue = groupOverrides[groupId];
    if (groupValue === 'on') isVisible = true;
    else if (groupValue === 'off') isVisible = false;
    const toolValue = toolOverrides[name];
    if (toolValue === 'on') isVisible = true;
    else if (toolValue === 'off') isVisible = false;
    if (isVisible) {
      visible.add(name);
      visiblePerGroup.set(groupId, (visiblePerGroup.get(groupId) ?? 0) + 1);
    }
  }
  const hidden = new Set();
  for (const name of index.managed) if (!visible.has(name)) hidden.add(name);
  const serverPrompts = new Map();
  for (const group of index.groups) {
    if (group.kind !== 'mcp' || typeof group.id !== 'string' || !group.id.startsWith('@mcp/')) continue;
    const server = group.id.slice(5);
    if (!MCP_SERVER_NAME.test(server)) continue;
    let groupVisible = mode !== 'allow';
    const groupValue = groupOverrides[group.id];
    if (groupValue === 'on') groupVisible = true;
    else if (groupValue === 'off') groupVisible = false;
    if (group.tools.length > 0 && (visiblePerGroup.get(group.id) ?? 0) === 0) groupVisible = false;
    serverPrompts.set(server, groupVisible);
  }
  return { mode, configured: entry !== null, visible, hidden, serverPrompts };
}

/* ------------------------------------------------------------------ */
/* 角色识别与逐 agent 应用                                             */
/* ------------------------------------------------------------------ */

/** 读取会话当前绑定的 preset，未绑定时使用未列出角色的规则。 */
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

/** 宿主在 agent.ctx 上持有限制，插件也持有同一个限制的清理函数。 */
function attachRestriction(ctx, agent, tools, filter) {
  const removeRestriction = tools.restrict(filter);
  let dispose;
  try {
    dispose = ctx.effect(() => () => {
      if (readAgentState(agent, APPLIED)?.dispose === dispose) setAgentState(agent, APPLIED, undefined);
      return removeRestriction();
    }, 'tool-exposure: release agent restriction');
  } catch (error) {
    removeRestriction();
    throw error;
  }
  return dispose;
}

/* ------------------------------------------------------------------ */
/* MCP 提示词过滤（system-prompt/assemble 作用域 waterfall）            */
/* ------------------------------------------------------------------ */

/**
 * DSH 把 MCP 的服务器名单（mcp-resource-servers section）和每个服务器的
 * instructions（mcp:<server> section）直接写进系统提示词，不受 tools.restrict()
 * 影响。这里按 agent 注册作用域监听器，在组装后的 presentation 上把这些
 * section 按角色策略裁掉：工具隐藏了，提示词也就不再污染上下文。
 */

/** 策略视图里单个工具的最终可见性（含未受管工具的 mode 回退）。 */
function toolVisibleInView(view, name) {
  if (typeof name !== 'string') return false;
  if (view.visible.has(name)) return true;
  if (view.hidden.has(name)) return false;
  return view.mode !== 'allow';
}

/** 策略视图里单个服务器的提示词可见性（未成组的服务器按 mode 回退）。 */
function serverVisibleInView(view, server) {
  if (typeof server !== 'string') return false;
  const state = view.serverPrompts.get(server);
  return state === undefined ? view.mode !== 'allow' : state;
}

/**
 * 重写服务器名单 section 的文本：剔除隐藏的服务器名，只点名可见的资源工具。
 * 返回原文本表示无需改动（保持 KV cache 逐字节一致）；null 表示整节删除。
 */
function rebuildResourceSection(text, view) {
  if (typeof text !== 'string' || text === '') return text;
  const visibleTools = RESOURCE_TOOLS.filter((name) => toolVisibleInView(view, name));
  if (visibleTools.length === 0) return null;
  const listing = / as the server argument: (\[.*\])\.$/.exec(text);
  if (listing === null) return text;
  let names;
  try {
    names = JSON.parse(listing[1]);
  } catch {
    return text;
  }
  if (!Array.isArray(names)) return text;
  const filtered = names.filter((name) => typeof name === 'string' && serverVisibleInView(view, name)).sort();
  if (filtered.length === 0) return null;
  if (filtered.length === names.length && visibleTools.length === RESOURCE_TOOLS.length) return text;
  return resourceSectionText(visibleTools, filtered);
}

/**
 * 裁剪一次组装结果中的 MCP section。只读不改输入对象；没有变化时原样返回。
 * 过滤失败按宿主原样放行（fail-open），不让提示词裁剪拖垮请求。
 */
function filterMcpPresentation(assembly, view) {
  if (view === null || typeof view !== 'object' || !isObject(assembly) || !Array.isArray(assembly.sections)) {
    return assembly;
  }
  let changed = false;
  const sections = [];
  for (const section of assembly.sections) {
    if (!isObject(section)) {
      sections.push(section);
      continue;
    }
    const name = typeof section.name === 'string' ? section.name : '';
    const isResource = name === RESOURCE_SECTION
      || (typeof section.text === 'string' && section.text.startsWith(RESOURCE_SECTION_HEADING));
    if (isResource) {
      const text = rebuildResourceSection(section.text, view);
      if (text === section.text) {
        sections.push(section);
        continue;
      }
      changed = true;
      if (text !== null) sections.push({ ...section, text });
      continue;
    }
    const server = MCP_SECTION.exec(name);
    if (server !== null && !serverVisibleInView(view, server[1])) {
      changed = true;
      continue;
    }
    sections.push(section);
  }
  return changed ? { ...assembly, sections } : assembly;
}

/**
 * 为一个 agent 注册作用域内的 system-prompt/assemble 监听器。
 *
 * 通过 agent.ctx 注册（Cordis 的 traceable 绑定让监听器带上 agent 作用域
 * 标签），宿主只会把该作用域（含子代理）的组装事件派发给它。已注册时直接
 * 复用；agent.ctx.on 不可用（测试桩）时静默跳过。
 */
function attachAgentPromptFilter(ctx, agent) {
  if (agent === null || typeof agent !== 'object') return null;
  const existing = readAgentState(agent, PROMPT_FILTER);
  if (existing !== undefined) return existing;
  const agentCtx = agent.ctx;
  if (typeof agentCtx?.on !== 'function') return null;
  const listener = async (assembly, context, next) => {
    const result = await next();
    const view = readAgentState(agent, POLICY_VIEW);
    if (view === undefined) return result;
    try {
      return filterMcpPresentation(result, view);
    } catch (error) {
      console.warn(`${TAG} prompt filter failed: ${error instanceof Error ? error.message : String(error)}`);
      return result;
    }
  };
  let off;
  try {
    off = agentCtx.on('system-prompt/assemble', listener);
  } catch (error) {
    console.warn(`${TAG} prompt filter registration failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
  let dispose;
  try {
    dispose = ctx.effect(() => () => {
      if (readAgentState(agent, PROMPT_FILTER)?.dispose === dispose) setAgentState(agent, PROMPT_FILTER, undefined);
      return off();
    }, 'tool-exposure: release agent prompt filter');
  } catch (error) {
    try {
      off();
    } catch {
      /* 注册环境已失效 */
    }
    throw error;
  }
  const record = { dispose };
  setAgentState(agent, PROMPT_FILTER, record);
  return record;
}

/** 显式 force 使用当前配置替换会话快照。角色和继承工具始终读取当前绑定。 */
function applyAgentPolicy(ctx, agent, config, options = {}) {
  if (!agent || typeof agent !== 'object') return false;
  const force = options.force === true;
  if (!force && readAgentState(agent, LEGACY) === true) return false;
  const existing = force ? undefined : readAgentState(agent, POLICY_SNAPSHOT);
  const snapshot = existing ?? { config };
  if (!force && existing === undefined) setAgentState(agent, POLICY_SNAPSHOT, snapshot);
  const tools = agent.ctx?.tools;
  if (typeof tools?.restrict !== 'function') {
    throw new Error('Agent tools service is unavailable');
  }

  const roleId = roleOfAgent(ctx, agent);
  const registry = tools.registrations ?? tools;
  const revision = tools.catalogRevision;
  const scopeChain = tools.agentToolScopeChain?.(agent);
  const previous = readAgentState(agent, APPLIED);
  const sameRegistry = previous?.registry === registry;
  if (!force && sameRegistry && previous.roleId === roleId && revision !== undefined && previous.revision === revision) {
    const previousChain = previous.scopeChain;
    if (scopeChain && previousChain?.length === scopeChain.length && scopeChain.every((key, i) => key === previousChain[i])) return true;
  }

  const catalog = toolCatalogOf(tools, snapshot.config.discovery ? agent : null);
  if (catalog === null) throw new Error('Unable to read the agent tool catalog');
  const names = catalog.map((tool) => tool.name);
  const servers = discoverMcpServers(ctx, [catalog]);
  const index = buildToolIndex(snapshot.config, names, catalog, servers);
  const policy = resolveRolePolicy(snapshot.config, roleId, index);
  // 提示词过滤器读取的当次视图：mode、工具可见集与服务器提示词可见性。
  setAgentState(agent, POLICY_VIEW, {
    mode: policy.mode,
    visible: policy.visible,
    hidden: policy.hidden,
    serverPrompts: policy.serverPrompts,
  });
  attachAgentPromptFilter(ctx, agent);
  const deny = [...policy.hidden];
  // 自动发现覆盖所有继承工具。用 allow 让晚注册的工具在重算前保持隐藏。
  // 手工分组保留未匹配工具的宿主可见性，继续使用 deny。
  const allow = snapshot.config.discovery && policy.mode === 'allow' ? [...policy.visible] : undefined;
  const signature = `${roleId ?? ''}|${allow === undefined ? deny.join(',') : `allow:${allow.join(',')}`}`;
  let dispose = previous?.dispose ?? null;
  if (!sameRegistry || previous.signature !== signature) {
    const filter = allow === undefined ? (deny.length ? { deny } : null) : { allow };
    // 宿主取各层限制的交集，先安装新限制可以在失败时保留原有保护。
    dispose = filter ? attachRestriction(ctx, agent, tools, filter) : null;
    try {
      previous?.dispose?.();
    } catch {
      /* 旧作用域可能已经销毁 */
    }
  }
  setAgentState(agent, APPLIED, { signature, roleId, dispose, registry, revision, scopeChain });
  if (force) {
    setAgentState(agent, POLICY_SNAPSHOT, snapshot);
    setAgentState(agent, LEGACY, false);
  }
  return true;
}

/** 插件加载时将没有策略快照的现有会话保留为 legacy。 */
function markLiveAgentsLegacy(ctx) {
  const agents = optionalService(ctx, 'agents');
  const list = agents && typeof agents.list === 'function' ? agents.list() : [];
  for (const agent of Array.isArray(list) ? list : []) {
    if (readAgentState(agent, POLICY_SNAPSHOT) === undefined) setAgentState(agent, LEGACY, true);
  }
}

/** 工具目录变化后按各会话自己的快照重算。 */
function refreshAgentPolicies(ctx) {
  const agents = optionalService(ctx, 'agents');
  const list = agents && typeof agents.list === 'function' ? agents.list() : [];
  for (const agent of Array.isArray(list) ? list : []) {
    const snapshot = readAgentState(agent, POLICY_SNAPSHOT);
    if (snapshot === undefined) continue;
    try {
      applyAgentPolicy(ctx, agent, snapshot.config);
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
    // 提示词过滤器一并解除：会话回到宿主默认的系统提示词。
    const filter = readAgentState(agent, PROMPT_FILTER);
    if (filter && typeof filter.dispose === 'function') {
      try {
        filter.dispose();
      } catch {
        /* 已随作用域消失 */
      }
    }
    // 清除会话快照，后续工具注册保留解除状态。
    setAgentState(agent, LEGACY, true);
    setAgentState(agent, POLICY_SNAPSHOT, undefined);
    setAgentState(agent, APPLIED, undefined);
    setAgentState(agent, POLICY_VIEW, undefined);
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
      // Missing names identify shipped presets whose display copy belongs to the Client locale.
      name: typeof row.name === 'string' ? row.name : undefined,
      description: typeof row.description === 'string' ? row.description : undefined,
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

/** Resolve display assets through DSH's package reader once per module and resolution base. */
function makeProviderDisplay(ctx) {
  const packages = optionalService(ctx, 'pluginPackages');
  const metadata = [];
  const references = new Map();
  function lookup(specifier, baseUrl) {
    if (typeof packages?.metaOf !== 'function' || typeof baseUrl !== 'string' || !specifier) return undefined;
    const key = JSON.stringify([baseUrl, specifier]);
    if (references.has(key)) return references.get(key);
    let id;
    try {
      const meta = packages.metaOf(specifier, baseUrl);
      if (meta?.title !== undefined || typeof meta?.icon === 'string') {
        id = metadata.length;
        metadata.push({ title: meta.title, icon: meta.icon });
      }
    } catch {
      // Metadata is optional. Keep the provider identity even when its files cannot be read.
    }
    references.set(key, id);
    return id;
  }
  return {
    metadata,
    project(provider) {
      if (!provider) return null;
      const { plugin, module, official, mcpServer } = provider;
      const baseUrl = provider.baseUrl ?? ctx.baseUrl;
      return {
        plugin, module, official, mcpServer,
        packageMeta: lookup(plugin, baseUrl),
        moduleMeta: module !== plugin ? lookup(module, baseUrl) : undefined,
      };
    },
  };
}

/** 组装矩阵页所需的完整数据。 */
async function buildInventory(ctx, config) {
  const tools = ctx.tools;
  const globalCatalog = toolCatalogOf(tools);
  const diagnostics = [];
  if (globalCatalog === null) {
    diagnostics.push({
      level: 'error',
      text: '工具注册表读取失败（tools.schemas() 抛错），本次矩阵可能不完整；现有会话的掩码保持不变。',
    });
  }
  const roles = await listRoles(ctx);
  const presets = optionalService(ctx, 'agentPresets');
  const roleCatalogs = new Map();
  const allTools = new Map((globalCatalog || []).map((tool) => [tool.name, tool]));
  if (config.discovery && typeof tools.presetToolCatalog !== 'function') {
    diagnostics.push({ level: 'warn', text: '工具来源跟踪服务尚未加载；当前仅显示全局工具，来源记为未知。请通过插件管理安装完整组合包并重启 DSH。' });
  }
  for (const role of roles) {
    let catalog = globalCatalog || [];
    if (!role.broken && presets && typeof tools.presetToolCatalog === 'function') {
      try {
        catalog = await tools.presetToolCatalog(presets, role.id);
      } catch (error) {
        diagnostics.push({ level: 'error', text: `读取角色「${role.id}」的工具失败：${error instanceof Error ? error.message : String(error)}` });
      }
    }
    roleCatalogs.set(role.id, catalog);
    for (const tool of catalog) if (!RESERVED_TOOL_NAMES.has(tool.name)) allTools.set(tool.name, tool);
  }
  const catalog = (config.discovery ? [...allTools.values()] : globalCatalog || []).filter((tool) => !RESERVED_TOOL_NAMES.has(tool.name));
  // 服务器名单也覆盖没有工具、只提供 instructions/资源的 MCP 服务器，
  // 三个索引共用同一份发现结果，保证矩阵与运行时策略一致。
  const serverNames = discoverMcpServers(ctx, [catalog, ...roleCatalogs.values()]);
  const index = buildToolIndex(config, catalog.map((tool) => tool.name), catalog, serverNames);
  const globalIndex = buildToolIndex(config, (globalCatalog || []).map((tool) => tool.name), globalCatalog || [], serverNames);
  const roleIndexes = new Map(roles.map((role) => {
    const items = config.discovery ? roleCatalogs.get(role.id) : globalCatalog || [];
    return [role.id, buildToolIndex(config, items.map((tool) => tool.name), items, serverNames)];
  }));
  const groupMatches = new Map();
  for (const candidate of [globalIndex, ...roleIndexes.values()]) {
    for (const group of candidate.groups) {
      if (!groupMatches.has(group.id)) groupMatches.set(group.id, new Set());
      for (const name of group.tools) groupMatches.get(group.id).add(name);
    }
  }
  const roleIds = new Set(roles.map((role) => role.id));

  for (const group of index.groups) {
    if (group.automatic) continue;
    if (!SOURCE_ID_PATTERN.test(group.id)) {
      diagnostics.push({ level: 'warn', text: `工具组 id 不合法：${group.id}（页面保存会被拒绝，请用「改名」修正）` });
    }
    if (group.match.length === 0) {
      diagnostics.push({
        level: 'warn',
        text: `工具组「${group.label}」(${group.id}) 的 match 为空，不会匹配任何工具（策略可能比预期更宽）`,
      });
    } else if ((groupMatches.get(group.id)?.size || 0) === 0 && !group.match.includes('*')) {
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
    const roleIndex = roleIndexes.get(roleId) || globalIndex;
    for (const groupId of Object.keys(role.groups)) {
      if (!roleIndex.groups.some((group) => group.id === groupId)) {
        diagnostics.push({ level: 'warn', text: `角色「${roleId}」引用了不存在的工具组「${groupId}」` });
      }
    }
    for (const name of Object.keys(role.tools)) {
      if (!roleIndex.owner.has(name)) {
        diagnostics.push({ level: 'warn', text: `角色「${roleId}」引用了未受管的工具「${name}」` });
      }
    }
  }

  const roleViews = roles.map((role) => {
    const entry = roleEntryOf(config, role.id);
    const roleIndex = roleIndexes.get(role.id);
    const policy = resolveRolePolicy(config, role.id, roleIndex);
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
      managed: roleIndex.managed.length,
      visible: policy.visible.size,
      hidden: policy.hidden.size,
    };
  });

  const providerDisplay = makeProviderDisplay(ctx);
  const wireCatalog = (items) => {
    const itemIndex = buildToolIndex(config, items.map((tool) => tool.name), items);
    return items.map((tool) => ({
      name: tool.name,
      source: itemIndex.owner.get(tool.name) || null,
      description: tool.description,
      provider: providerDisplay.project(tool.provider),
    }));
  };
  const globalTools = wireCatalog(globalCatalog || []);
  const roleTools = Object.fromEntries([...roleCatalogs].map(([id, items]) => [id, wireCatalog(items)]));

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
    configVersion: configVersion(config),
    discovery: config.discovery,
    unlisted: config.unlisted,
    mcpServers: serverNames.map((name) => ({
      name,
      toolCount: index.groups.find((group) => group.id === `@mcp/${name}`)?.tools.length ?? 0,
    })),
    sources: index.groups.filter((group) => !group.automatic).map((group) => ({
      id: group.id,
      label: group.label,
      match: group.match,
      toolCount: groupMatches.get(group.id)?.size || 0,
    })),
    roles: roleViews,
    orphanRoles,
    tools: globalTools,
    globalTools,
    roleTools,
    providerMetadata: providerDisplay.metadata,
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
  let catalog = toolCatalogOf(tools) || [];
  const roles = await listRoles(ctx);
  const role = typeof roleId === 'string' && roleId !== '' ? roleId : null;
  const known = role === null ? false : roles.some((item) => item.id === role);
  const presets = optionalService(ctx, 'agentPresets');
  if (config.discovery && known && presets && typeof tools.presetToolCatalog === 'function') {
    catalog = await tools.presetToolCatalog(presets, role);
  }
  const serverNames = discoverMcpServers(ctx, [catalog]);
  const index = buildToolIndex(config, catalog.map((tool) => tool.name), catalog, serverNames);
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
    // 每个已发现 MCP 服务器的提示词可见性（instructions + 服务器名单）。
    servers: [...serverNames].map((name) => ({ name, visible: serverVisibleInView(policy, name) })),
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
  // 自定义分组与自动发现开关一起保存；缺字段时拒绝清空已有分组。
  if (!isObject(draft.sources)) errors.push('缺少 sources 字段：拒绝用空请求覆盖现有工具组配置');
  // roles 同样是覆盖写：缺字段/非对象时拒绝，避免旧客户端或脚本静默清空角色策略。
  if (!isObject(draft.roles)) errors.push('缺少 roles 字段：拒绝用空请求覆盖现有角色策略');
  const unlisted = draft.unlisted === 'closed' ? 'closed' : 'open';
  if (draft.discovery !== undefined && typeof draft.discovery !== 'boolean') errors.push('discovery 必须是布尔值');
  const discovery = draft.discovery === true;

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

  return { errors, config: { discovery, unlisted, sources, roles } };
}

/** 把矩阵草稿写回本插件在 profile 中的配置行。 */
async function saveDraft(ctx, draft) {
  const { errors, config } = normalizeDraft(draft);
  if (errors.length > 0) return { status: 400, body: { ok: false, error: errors.join('；') } };
  const expectedVersion = draft.configVersion;
  if (expectedVersion !== undefined && (typeof expectedVersion !== 'string' || !/^[a-f0-9]{64}$/.test(expectedVersion))) {
    return { status: 400, body: { ok: false, error: 'Invalid configVersion' } };
  }
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
  const savedVersion = configVersion(config);
  await editor.edit(entry, (current) => {
    // The editor reads the current value under its write lock, including changes
    // from another window or a manual profile edit.
    if (expectedVersion !== undefined) {
      const currentVersion = configVersion(normalizeConfig(current));
      if (currentVersion !== expectedVersion && currentVersion !== savedVersion) {
        const error = httpError(409, 'The tool exposure configuration changed. Rescan before saving again.');
        error.code = 'config_conflict';
        throw error;
      }
    }
    return config;
  });
  return { status: 200, body: { ok: true, saved: true, appliedTo: 'new-sessions', configVersion: savedVersion } };
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

function createRouteHandler(ctx, config) {
  return async function handle(req, res) {
    // Node 会把重复的请求头合并成 "1, 1"，按逗号列表判断，避免误拒。
    const guard = req.headers[GUARD_HEADER];
    const guarded = typeof guard === 'string' && guard.split(',').some((part) => part.trim() === '1');
    if (!guarded) {
      sendJson(res, 403, { ok: false, error: 'forbidden' });
      return;
    }
    try {
      const connection = optionalService(ctx, 'connection');
      if (typeof connection?.admit !== 'function') {
        sendJson(res, 503, { ok: false, error: 'DSH authentication is unavailable' });
        return;
      }
      const admission = connection.admit(req);
      if ('rejection' in admission) {
        const status = admission.rejection;
        sendJson(res, status, { ok: false, error: status === 401 ? 'unauthorized' : 'forbidden' });
        return;
      }
      const peer = admission.peer;
      // 修改可见性规则是用户操作。API Peer 即使是 owner 也只能读取诊断。
      if (peer.principal.kind !== 'owner' || (req.method === 'POST' && peer.id !== connection.browserPeer?.id)) {
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
      const sub = url.pathname.startsWith(`${ROUTE_PREFIX}/`) ? url.pathname.slice(ROUTE_PREFIX.length) : '';
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
          const snapshot = readAgentState(agent, POLICY_SNAPSHOT);
          const agentConfig = snapshot?.config ?? config;
          let catalog = [];
          try {
            catalog = toolCatalogOf(agent.ctx.tools, agentConfig.discovery ? agent : null) || [];
          } catch {
            /* The agent scope may already have been disposed. */
          }
          const servers = discoverMcpServers(ctx, [catalog]);
          const index = buildToolIndex(agentConfig, catalog.map((tool) => tool.name), catalog, servers);
          const roleId = roleOfAgent(ctx, agent);
          const policy = resolveRolePolicy(agentConfig, roleId, index);
          const deny = [...policy.hidden].filter((name) => index.registered.has(name));
          const applied = readAgentState(agent, APPLIED);
          const view = readAgentState(agent, POLICY_VIEW);
          rows.push({
            id: String(agent.id),
            role: roleId,
            mode: policy.mode,
            managed: index.managed.length,
            denyCount: deny.length,
            applied: applied ? applied.signature : null,
            promptFilter: readAgentState(agent, PROMPT_FILTER) !== undefined,
            promptHiddenServers: view ? [...view.serverPrompts.entries()].filter(([, visible]) => visible === false).map(([name]) => name).sort() : [],
            started: readAgentState(agent, STARTED) === true,
            legacy: readAgentState(agent, LEGACY) === true,
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
            if (!applyAgentPolicy(ctx, agent, config, { force: true })) {
              throw new Error('Agent policy was not applied');
            }
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
        sendJson(res, 200, { ok: results.every((result) => result.ok), results });
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
      if (status === 409 && error.code === 'config_conflict') {
        sendJson(res, status, { ok: false, error: error.message, code: error.code });
        return;
      }
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
        () => webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: createRouteHandler(ctx, config) }),
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

/** 工具注册表是硬依赖；预设、会话和 Web 服务按需读取。 */
export const inject = ['tools'];

/** Cordis 插件入口。 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);

  ctx.on('agent/created', (payload) => {
    const agent = payload && payload.agent;
    if (!agent) return;
    try {
      applyAgentPolicy(ctx, agent, config);
    } catch (error) {
      console.warn(`${TAG} apply on agent/created failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  // 工具服务在请求采集工具前同步调用。规则应用失败时由 DSH 终止这一轮请求。
  ctx.on('dsh-tool-exposure/before-tool-resolution', (agent) => {
    const snapshot = readAgentState(agent, POLICY_SNAPSHOT);
    if (snapshot) applyAgentPolicy(ctx, agent, snapshot.config);
  });

  ctx.on('agent/disposed', (payload) => {
    const agent = payload && payload.agent;
    const applied = readAgentState(agent, APPLIED);
    const filter = readAgentState(agent, PROMPT_FILTER);
    if (agent) AGENT_STATE.delete(agent);
    if (applied && typeof applied.dispose === 'function') {
      try {
        applied.dispose();
      } catch {
        /* agent 作用域已释放 */
      }
    }
    if (filter && typeof filter.dispose === 'function') {
      try {
        filter.dispose();
      } catch {
        /* agent 作用域已释放 */
      }
    }
  });

  // 诊断页展示会话是否已经开始处理消息。
  ctx.on('agent/inbox/claimed', (payload) => {
    const agent = payload && payload.agent;
    if (agent) setAgentState(agent, STARTED, true);
  });

  // 宿主先发 tools/change，再由来源记录服务写入元数据。合并同一轮的注册变化，
  // 并忽略更新限制自身产生的通知。
  ctx.effect(() => {
    let queued = false;
    let active = true;
    const off = ctx.on('tools/change', () => {
      if (queued) return;
      queued = true;
      queueMicrotask(() => {
        if (!active) return;
        try {
          refreshAgentPolicies(ctx);
        } catch (error) {
          console.warn(`${TAG} resync failed: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          queued = false;
        }
      });
    });
    return () => {
      active = false;
      off();
    };
  }, 'tool-exposure: tools/change resync');

  // 配置热重载后按原快照恢复限制。安装前已存在的会话保留宿主状态。
  try {
    markLiveAgentsLegacy(ctx);
    refreshAgentPolicies(ctx);
  } catch (error) {
    console.warn(`${TAG} unable to restore live agent policies: ${error instanceof Error ? error.message : String(error)}`);
  }
  mountRoutes(ctx, config);
}

/** 仅本地测试使用；不属于插件契约。 */
export const __test = {
  ROW_ID,
  ROUTE_PREFIX,
  APPLIED,
  LEGACY,
  PROMPT_FILTER,
  POLICY_VIEW,
  STARTED,
  applyAgentPolicy,
  attachAgentPromptFilter,
  buildEffective,
  createRouteHandler,
  buildInventory,
  buildToolIndex,
  discoverMcpServers,
  filterMcpPresentation,
  rebuildResourceSection,
  globToRegExp,
  globalToolNames,
  liftAllRestrictions,
  listRoles,
  markLiveAgentsLegacy,
  mountRoutes,
  normalizeMatchList,
  serverVisibleInView,
  setAgentState,
  normalizeConfig,
  normalizeDraft,
  readAgentState,
  refreshAgentPolicies,
  resolveRolePolicy,
  toolVisibleInView,
};
