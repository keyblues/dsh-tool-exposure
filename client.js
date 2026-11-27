/**
 * dsh-tool-exposure — Client half.
 *
 * 左侧菜单 →「工具暴露」：独立主页面，按角色管理继承工具与插件分组。
 *
 * 布局沿用 Host 的主题 token 与管理页设计语言：
 *   - 固定页头与操作反馈，独立滚动的角色/工具工作区；
 *   - 按页面实际可用宽度在双栏、横向角色列表和窄屏控件布局间切换；
 *   - 工具搜索与可见性筛选只改变展示，策略保持整组与单工具的原有语义。
 *
 * 与 Host 半的契约（必须与 index.js 保持一致）：
 *   GET  /plugins/dsh-tool-exposure/inventory
 *   POST /plugins/dsh-tool-exposure/save
 *   POST /plugins/dsh-tool-exposure/reset
 *   所有请求带 x-dsh-tool-exposure-plugin: 1 与 cache: 'no-store'。
 *
 * 解析规则与 Host resolveRolePolicy 完全一致：
 *   mode=open 基线全给 / allow 基线全不给 → groups 覆盖整组 → tools 覆盖单工具。
 */
window.__ModuleLoader__.load({
  id: 'dsh-tool-exposure',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Locale namespace owned by this plugin. */
    const NS = 'dsh-tool-exposure';
    const PANEL_ID = 'dsh-tool-exposure';

    /** Same-origin Host routes (must stay in sync with ROUTE_PREFIX in index.js). */
    const ROUTE_INVENTORY = '/plugins/dsh-tool-exposure/inventory';
    const ROUTE_SAVE = '/plugins/dsh-tool-exposure/save';
    const ROUTE_RESET = '/plugins/dsh-tool-exposure/reset';

    /** Guard header the Host requires; it rejects every request without it with 403. */
    const GUARD_HEADERS = { 'x-dsh-tool-exposure-plugin': '1' };

    /** Source-id rule enforced by the Host's normalizeDraft() (first char must be a letter). */
    const SOURCE_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
    /** Match limits enforced by the Host; keep the UI in sync. */
    const MAX_MATCH_ITEM_LENGTH = 256;
    const MAX_MATCH_TOTAL_LENGTH = 4096;

    /** After a save the Host row reloads; wait, then rescan with bounded retries. */
    const SAVE_RESCAN_DELAY_MS = 800;
    const RESCAN_RETRY_MS = 600;
    const RESCAN_RETRIES = 3;

    /** Successful notices fade out on their own. */
    const NOTICE_TTL_MS = 4000;

    const DICT = {
      en: {
        nav: 'Tool exposure',
        title: 'Tool exposure',
        intro:
          'Manage tool visibility by role. Saved changes apply to new sessions.',
        back: 'Back to conversation',
        roleSearch: 'Find a role',
        roleNoMatch: 'No matching roles.',
        toolSearch: 'Search tools, plugins or descriptions',
        filterLabel: 'Tool visibility',
        filterAll: 'All tools',
        filterVisible: 'Visible',
        filterHidden: 'Hidden',
        clearFilters: 'Clear filters',
        noMatches: 'No tools match these filters.',
        matchCount: '{count} matching tools',
        toolCount: '{count} tools',
        filterHint: 'Group switches affect the whole group.',
        expandAll: 'Expand all',
        collapseAll: 'Collapse all',
        statVisible: 'Visible tools',
        statHidden: 'Hidden tools',
        statGroups: 'Tool groups',
        advanced: 'Advanced settings',
        draftKept: 'Your draft is kept when you return to the conversation.',
        loading: 'Loading…',
        loadFailedTitle: 'Could not load the exposure matrix',
        loadFailedHint: 'Make sure the Host half of this bundle is enabled, then retry. Reloading the page also works.',
        retry: 'Retry',
        rolesTitle: 'Roles',
        rolesIntro: 'Pick a role to edit which managed tool groups it can see.',
        roleMeta: '{mode} · {visible}/{managed} visible',
        roleUnconfigured: 'not configured',
        roleDefault: 'default',
        roleBroken: 'activation failed',
        roleReset: 'Use global default',
        roleResetHint: 'Remove this role entry and inherit the global default again.',
        roleEmpty: 'No agent preset was found, so there is no role to configure.',
        roleNoDescription: 'No description.',
        presetStandardName: 'Standard mode',
        presetStandardDescription: 'Work with code, files, and information. Suitable for most tasks, with search, editing, terminal commands, and other tools available as needed.',
        presetPtcName: 'PTC mode',
        presetPtcDescription: 'All Standard mode capabilities, with programmatic tool calling for batch processing and result analysis.',
        presetMinimalName: 'Minimal mode',
        presetMinimalDescription: 'Use terminal commands and image reading with context compaction to test basic capabilities.',
        presetCordisName: 'Creator mode',
        presetCordisDescription: 'Customize DSH through plugins, interface changes, tools, and agent presets.',
        baselineTitle: 'Default rule',
        baselineDescOpen: 'Tools are visible by default. Turn off individual tools or groups as needed.',
        baselineDescAllow: 'Tools are hidden by default. Only selected tools and groups are visible.',
        modeOpen: 'Open by default',
        modeAllow: 'Allow-list',
        groupsTitle: 'Tool groups',
        globalTools: 'Global tools',
        officialTools: 'Official tools',
        unknownProvider: 'Unknown provider',
        providerLabel: 'Provided by {plugin}',
        mcpServer: 'MCP server',
        mcpPromptOnly: 'no tools · this switch also controls the server’s prompt text',
        automaticGroup: 'Detected from registrations',
        noGlobalTools: 'This role has no manageable tools.',
        groupTools: '{count} tools',
        groupPartial: 'partly visible',
        groupNoTools: 'no matching tools',
        groupEmpty: 'no tools',
        expand: 'Expand',
        collapse: 'Collapse',
        toolVisible: 'visible',
        toolHidden: 'hidden',
        ungroupedTitle: 'Ungrouped tools',
        ungroupedHint: 'These global tools match no tool group, so this policy never touches them.',
        ungroupedEmpty: 'No ungrouped tool.',
        globalTitle: 'Global',
        discoveryTitle: 'Group by providing plugin',
        discoveryHint: 'Discover globally shared and inherited preset tools. Official tools stay together; custom groups can organize other tools.',
        unlistedLabel: 'Roles without their own entry',
        unlistedOpen: 'Unrestricted',
        unlistedClosed: 'No managed tools',
        unlistedHint: 'Applies to roles that have no entry of their own.',
        manageTitle: 'Manage tool groups',
        manageHint: 'Custom groups match tool names with * and ?. They take priority over detected third-party groups; official tools keep their own group. New groups precede a * fallback.',
        manageAdd: 'Add tool group',
        manageEmpty: 'No custom tool groups.',
        manageLabel: 'Label',
        manageMatch: 'Match',
        manageMatchHint: 'Tool name or wildcard (*)',
        manageId: 'id',
        manageRemove: 'Delete',
        manageAddTitle: 'New tool group',
        manageAddConfirm: 'Add',
        manageCancel: 'Cancel',
        manageInvalidId: 'Invalid group id: {id}',
        manageDuplicateId: 'That group id already exists.',
        manageEmptyMatch: 'Match for group "{label}" cannot be empty.',
        manageIdHint: 'The id may contain lowercase letters, digits and hyphens only.',
        manageMatchTooLong: 'A match item is too long (max 256 characters each, 4096 total).',
        manageRemoveLabel: 'Delete tool group {label}',
        manageRename: 'Rename',
        manageRenameConfirm: 'Rename',
        manageRenameCancel: 'Cancel',
        save: 'Save',
        saving: 'Saving…',
        discard: 'Discard',
        discarded: 'Draft discarded.',
        rescan: 'Rescan',
        rescanning: 'Scanning…',
        lift: 'Remove tool restrictions from current sessions',
        lifting: 'Lifting…',
        liftConfirm: 'Lift every restriction this plugin applied to live sessions?',
        liftYes: 'Confirm',
        liftNo: 'Cancel',
        liftDone: 'Lifted the policy on {count} live session(s).',
        liftDesc: 'Remove this plugin’s restrictions from all loaded sessions and subagents. Saved settings continue to apply to new sessions.',
        saved: 'Saved; new sessions pick it up.',
        unsaved: 'Unsaved changes',
        saveFailed: 'Save failed: {error}',
        saveFailedShort: 'Save failed',
        saveConflict: 'The configuration changed elsewhere. Your draft is still here. Rescan to load the latest settings.',
        rescanFailed: 'Rescan failed: {error}',
        rescanDone: 'Tool list updated.',
        rescanWaiting: 'Your changes were saved. Waiting for DSH to load them.',
        dismissNotice: 'Dismiss message',
        rescanDiscard: 'Rescanning discards unsaved changes. Continue?',
        removeGroupConfirm: 'Remove tool group "{label}" from the draft?',
        diagnosticsTitle: 'Warnings',
        effectiveTitle: 'Effective tools',
        effectiveVisible: 'Visible {count}',
        effectiveHidden: 'Hidden {count}',
        effectiveNone: 'none',
        readonlyHint: 'Saving from this page is unavailable; edit the profile cordis.patch.yml instead.',
        editHint: 'Click a role card to edit it.',
      },
      zh: {
        nav: '工具暴露',
        title: '工具暴露',
        intro:
          '按角色管理工具可见性，保存后对新建会话生效。',
        back: '返回会话',
        roleSearch: '查找角色',
        roleNoMatch: '没有匹配的角色。',
        toolSearch: '搜索工具、插件或描述',
        filterLabel: '工具可见性',
        filterAll: '全部工具',
        filterVisible: '仅可见',
        filterHidden: '仅隐藏',
        clearFilters: '清除筛选',
        noMatches: '没有符合筛选条件的工具。',
        matchCount: '匹配 {count} 个工具',
        toolCount: '共 {count} 个工具',
        filterHint: '整组开关作用于全组',
        expandAll: '全部展开',
        collapseAll: '全部收起',
        statVisible: '可见工具',
        statHidden: '隐藏工具',
        statGroups: '工具分组',
        advanced: '高级设置',
        draftKept: '返回会话后草稿仍会保留。',
        loading: '加载中…',
        loadFailedTitle: '矩阵数据加载失败',
        loadFailedHint: '请确认本 bundle 的 Host 半已启用后重试，刷新页面也可以。',
        retry: '重试',
        rolesTitle: '角色',
        rolesIntro: '选择一个角色，编辑它能看到的受管工具组。',
        roleMeta: '{mode} · 可见 {visible}/{managed}',
        roleUnconfigured: '未配置',
        roleDefault: '默认',
        roleBroken: '激活失败',
        roleReset: '恢复全局默认',
        roleResetHint: '删除本角色条目，重新继承全局默认。',
        roleEmpty: '没有找到任何 agent preset，暂无可配置的角色。',
        roleNoDescription: '暂无说明。',
        presetStandardName: '标准模式',
        presetStandardDescription: '处理代码、文件和资料，适合大多数任务。Agent 会按需使用检索、编辑和终端等工具。',
        presetPtcName: 'PTC 模式',
        presetPtcDescription: '包含标准模式的所有能力，更适合批量调用工具，并对结果进行筛选、整理、去重、统计或汇总的任务。',
        presetMinimalName: '极简模式',
        presetMinimalDescription: 'Agent 使用终端和图片读取工具，并支持上下文压缩，适合测试和对比其基础表现。',
        presetCordisName: '创造模式',
        presetCordisDescription: '用对话定制 DSH：让 Agent 编写插件，添加新功能或界面；也能组合工具和提示词，创建自己的模式。',
        baselineTitle: '默认规则',
        baselineDescOpen: '工具默认可见，可单独关闭工具或分组。',
        baselineDescAllow: '工具默认隐藏，只开放你选择的工具或分组。',
        modeOpen: '默认开放',
        modeAllow: '白名单',
        groupsTitle: '工具组',
        globalTools: '全局工具',
        officialTools: '官方工具',
        unknownProvider: '来源未知',
        providerLabel: '提供插件：{plugin}',
        mcpServer: 'MCP 服务器',
        mcpPromptOnly: '无工具 · 开关同时控制该服务器的提示词',
        automaticGroup: '根据注册来源自动识别',
        noGlobalTools: '此角色暂无可管理的工具。',
        groupTools: '{count} 个工具',
        groupPartial: '部分可见',
        groupNoTools: '没有匹配到工具',
        groupEmpty: '暂无工具',
        expand: '展开',
        collapse: '收起',
        toolVisible: '可见',
        toolHidden: '隐藏',
        ungroupedTitle: '未归组工具',
        ungroupedHint: '这些全局工具没有被任何工具组匹配，不受本策略影响。',
        ungroupedEmpty: '没有未归组的工具。',
        globalTitle: '全局',
        discoveryTitle: '按提供插件自动分组',
        discoveryHint: '读取全局共享与预设继承工具，官方工具集中为一组；自定义分组可整理其他工具。',
        unlistedLabel: '没有单独配置的角色',
        unlistedOpen: '不限制',
        unlistedClosed: '看不到受管工具',
        unlistedHint: '没有单独条目的角色继承此设置。',
        manageTitle: '管理工具组',
        manageHint: '自定义组用 * 与 ? 匹配工具名，优先于第三方自动分组；官方工具保留独立分组。新增分组排在 * 兜底组之前。',
        manageAdd: '添加工具组',
        manageEmpty: '还没有自定义工具组。',
        manageLabel: '名称',
        manageMatch: '匹配',
        manageMatchHint: '工具名或通配符（*）',
        manageId: 'id',
        manageRemove: '删除',
        manageAddTitle: '新建工具组',
        manageAddConfirm: '添加',
        manageCancel: '取消',
        manageInvalidId: '工具组 id 不合法：{id}',
        manageDuplicateId: '该工具组 id 已存在。',
        manageEmptyMatch: '工具组「{label}」的匹配不能为空。',
        manageIdHint: 'id 只能用小写字母、数字和连字符。',
        manageMatchTooLong: '匹配项过长（单项最多 256 个字符，总计最多 4096 个）。',
        manageRemoveLabel: '删除工具组 {label}',
        manageRename: '改名',
        manageRenameConfirm: '确定',
        manageRenameCancel: '取消',
        save: '保存',
        saving: '保存中…',
        discard: '放弃修改',
        discarded: '已放弃未保存的修改。',
        rescan: '重新扫描',
        rescanning: '扫描中…',
        lift: '解除所有当前会话的工具限制',
        lifting: '解除中…',
        liftConfirm: '确定解除本插件在所有现有会话上注册的工具限制吗？',
        liftYes: '确认解除',
        liftNo: '取消',
        liftDone: '已解除 {count} 个现有会话上的策略。',
        liftDesc: '撤销本插件对所有已加载会话和子代理的工具限制；已保存设置继续用于新建会话。',
        saved: '已保存，新建会话生效。',
        unsaved: '有未保存的修改',
        saveFailed: '保存失败：{error}',
        saveFailedShort: '保存失败',
        saveConflict: '配置已在别处更新。当前草稿已保留，重新扫描可读取最新配置。',
        rescanFailed: '重新扫描失败：{error}',
        rescanDone: '工具清单已更新。',
        rescanWaiting: '修改已保存，正在等 DSH 载入。',
        dismissNotice: '关闭提示',
        rescanDiscard: '重新扫描会丢弃未保存的修改，继续吗？',
        removeGroupConfirm: '从草稿中删除工具组「{label}」？',
        diagnosticsTitle: '提示',
        effectiveTitle: '最终可见工具',
        effectiveVisible: '可见 {count}',
        effectiveHidden: '隐藏 {count}',
        effectiveNone: '无',
        readonlyHint: '当前环境无法从页面保存；请直接编辑本 profile 的 cordis.patch.yml。',
        editHint: '点选一个角色卡片开始编辑。',
      },
    };

    /* ------------------------------------------------------------------ */
    /* 翻译                                                                */
    /* ------------------------------------------------------------------ */

    function detectLocale() {
      try {
        const lang = (document.documentElement.lang || navigator.language || 'en').toLowerCase();
        return lang.startsWith('zh') ? 'zh' : 'en';
      } catch {
        return 'en';
      }
    }

    function fallbackTranslate(key) {
      const dict = DICT[detectLocale()] || DICT.en;
      const value = dict[key];
      if (typeof value === 'string') return value;
      return typeof DICT.en[key] === 'string' ? DICT.en[key] : key;
    }

    function makeTranslate(bound) {
      if (typeof bound !== 'function') return fallbackTranslate;
      return (key) => {
        let value;
        try {
          value = bound(key);
        } catch {
          return fallbackTranslate(key);
        }
        return typeof value === 'string' && value !== '' && value !== key ? value : fallbackTranslate(key);
      };
    }

    let translateFn = fallbackTranslate;
    let presetTranslateFn = null;
    let resolvePackageText = null;

    // Same display contract as dsh-agent-preset-registry/display; no private Client imports.
    const BUILT_IN_PRESET_COPY = new Map([
      ['standard', 'presetStandard'], ['ptc', 'presetPtc'],
      ['minimal', 'presetMinimal'], ['cordis', 'presetCordis'],
    ]);

    function roleDisplayText(role) {
      const prefix = role.name === undefined ? BUILT_IN_PRESET_COPY.get(role.id) : undefined;
      const translatePreset = (key) => {
        try {
          const value = presetTranslateFn?.(key);
          if (typeof value === 'string' && value !== '' && value !== key) return value;
        } catch { /* A custom profile may omit the official preset UI dictionaries. */ }
        return t(key);
      };
      return {
        displayName: prefix === undefined ? asText(role.name) || role.id : translatePreset(prefix + 'Name'),
        displayDescription: prefix === undefined ? asText(role.description) : translatePreset(prefix + 'Description'),
      };
    }

    function t(key) {
      return translateFn(key);
    }

    function fill(template, values) {
      let text = typeof template === 'string' ? template : '';
      const source = values !== null && typeof values === 'object' ? values : {};
      for (const key of Object.keys(source)) text = text.split(`{${key}}`).join(String(source[key]));
      return text;
    }

    /* ------------------------------------------------------------------ */
    /* 小工具                                                              */
    /* ------------------------------------------------------------------ */

    function asText(value) {
      return typeof value === 'string' ? value.trim() : '';
    }

    function packageDisplayText(value) {
      if (!isObject(value)) return asText(value);
      try {
        const translated = asText(resolvePackageText?.(value));
        if (translated) return translated;
      } catch { /* Older hosts may have no package text resolver. */ }
      return asText(value[detectLocale()]) || asText(value.en);
    }

    function groupLabel(id, label) {
      const value = asText(label);
      if (id === '@official') return t('officialTools');
      if (id === '@unknown') return t('unknownProvider');
      return id === 'global' && value === 'Global tools' ? t('globalTools') : value === '' ? id : value;
    }

    function isObject(value) {
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    }

    function errorTextOf(error) {
      return error instanceof Error && error.message !== '' ? error.message : String(error);
    }

    function saveFailureNotice(error) {
      const text = error?.code === 'config_conflict'
        ? t('saveConflict')
        : fill(t('saveFailed'), { error: errorTextOf(error) });
      return { tone: 'error', text };
    }

    function slugify(text) {
      return asText(text)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 32)
        .replace(/-+$/g, '');
    }

    /** 生成一个未被占用的默认组 id（中文名称 slug 为空时用）。 */
    function nextGroupId(sources) {
      let index = 1;
      while (Object.prototype.hasOwnProperty.call(sources, `group-${index}`)) index += 1;
      return `group-${index}`;
    }

    function splitMatch(text) {
      return asText(text)
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item !== '');
    }

    /**
     * 通配符匹配器（* 与 ?，其余按字面量）。用双指针 + 单星回溯，最坏 O(n*m)：
     * 不能编译成 `.*` 链正则——长/恶意 match 会在渲染期指数回溯或直接抛
     * "Invalid regular expression"，把整页打崩。
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

    /**
     * Deterministic snapshot for dirty comparison.
     * Object key order is preserved on purpose: sources order decides first-match
     * group ownership, so a pure reorder must count as a change.
     */
    function stableSnapshot(value) {
      return JSON.stringify(value);
    }

    function wait(ms) {
      return new Promise((resolve) => {
        setTimeout(resolve, ms);
      });
    }

    function copyOverrides(value) {
      const out = {};
      if (!isObject(value)) return out;
      for (const key of Object.keys(value)) {
        if (value[key] === 'on' || value[key] === 'off') out[key] = value[key];
      }
      return out;
    }

    /* ------------------------------------------------------------------ */
    /* HTTP                                                                */
    /* ------------------------------------------------------------------ */

    async function requestJson(url, options) {
      const hasBody = options !== undefined && options.body !== undefined;
      const init = {
        cache: 'no-store',
        method: options !== undefined && options.method !== undefined ? options.method : 'GET',
        headers: hasBody
          ? { ...GUARD_HEADERS, accept: 'application/json', 'content-type': 'application/json' }
          : { ...GUARD_HEADERS, accept: 'application/json' },
      };
      if (hasBody) init.body = options.body;
      const response = await fetch(url, init);
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      if (!response.ok) {
        const detail =
          isObject(payload) && typeof payload.error === 'string' && payload.error !== ''
            ? payload.error
            : `HTTP ${response.status}`;
        const error = new Error(detail);
        if (typeof payload?.code === 'string') error.code = payload.code;
        throw error;
      }
      if (!isObject(payload)) throw new Error(`HTTP ${response.status}`);
      if (payload.ok === false) {
        throw new Error(
          typeof payload.error === 'string' && payload.error !== '' ? payload.error : `HTTP ${response.status}`,
        );
      }
      return payload;
    }

    /* ------------------------------------------------------------------ */
    /* 草稿模型（与 Host normalizeConfig / normalizeDraft 对齐）            */
    /* ------------------------------------------------------------------ */

    function draftFromInventory(payload) {
      const sources = {};
      for (const source of Array.isArray(payload.sources) ? payload.sources : []) {
        if (!isObject(source) || typeof source.id !== 'string' || source.id === '') continue;
        const label = asText(source.label);
        sources[source.id] = {
          label: label === '' ? source.id : label,
          match: Array.isArray(source.match) ? source.match.join(', ') : '',
        };
      }
      const roles = {};
      for (const role of Array.isArray(payload.roles) ? payload.roles : []) {
        if (!isObject(role) || typeof role.id !== 'string' || role.id === '') continue;
        roles[role.id] = {
          configured: role.configured === true,
          mode: role.mode === 'allow' ? 'allow' : 'open',
          groups: copyOverrides(role.groups),
          tools: copyOverrides(role.tools),
        };
      }
      // 配置里存在、但当前 preset 名册里已经没有的角色：原样保留，保存时回传。
      // 页面不渲染它们（没有对应角色卡片），但绝不能因为一次保存就静默删掉。
      if (isObject(payload.orphanRoles)) {
        for (const roleId of Object.keys(payload.orphanRoles)) {
          if (typeof roleId !== 'string' || roleId === '' || roles[roleId] !== undefined) continue;
          const role = payload.orphanRoles[roleId];
          if (!isObject(role)) continue;
          roles[roleId] = {
            configured: true,
            mode: role.mode === 'allow' ? 'allow' : 'open',
            groups: copyOverrides(role.groups),
            tools: copyOverrides(role.tools),
          };
        }
      }
      return { discovery: payload.discovery === true, unlisted: payload.unlisted === 'closed' ? 'closed' : 'open', sources, roles };
    }

    function buildLocalIndex(sources, names, discovery = false, catalog = [], servers = []) {
      const groups = [];
      for (const id of Object.keys(sources)) {
        const source = sources[id];
        const match = splitMatch(source.match);
        groups.push({
          id,
          label: groupLabel(id, source.label),
          match,
          matchers: match.map(globToRegExp),
          tools: [],
        });
      }
      const owner = new Map();
      const ungrouped = [];
      const providers = new Map(catalog.map((tool) => [tool.name, tool.provider || null]));
      const automatic = new Map();
      const automaticGroup = (provider, mcpServer) => {
        const official = provider?.official === true;
        const known = typeof provider?.plugin === 'string' && provider.plugin !== '';
        const id = mcpServer ? `@mcp/${mcpServer}` : official ? '@official' : known ? `@plugin/${provider.plugin}` : '@unknown';
        if (!automatic.has(id)) {
          const kind = mcpServer ? 'mcp' : official ? 'official' : known ? 'plugin' : 'unknown';
          automatic.set(id, {
            id, label: mcpServer || groupLabel(id, known ? provider.plugin : ''), kind, automatic: true,
            match: [], matchers: [], tools: [],
          });
        }
        return automatic.get(id);
      };
      const prioritized = (group) => group.kind === 'official' || group.kind === 'mcp';
      for (const name of names) {
        const provider = providers.get(name) || null;
        const server = typeof provider?.mcpServer === 'string' ? provider.mcpServer : '';
        let hit = discovery && (server || provider?.official === true) ? automaticGroup(provider, server) : null;
        for (const group of hit === null ? groups : []) {
          if (group.matchers.some((matcher) => matcher.test(name))) {
            hit = group;
            break;
          }
        }
        if (hit === null && discovery) hit = automaticGroup(provider, server);
        if (hit === null) ungrouped.push(name);
        else {
          hit.tools.push(name);
          owner.set(name, hit.id);
        }
      }
      // 与 Host 半一致：没有工具的 MCP 服务器也成组，开关管理其提示词可见性。
      if (discovery) {
        for (const server of servers) {
          if (typeof server !== 'string' || server === '' || !/^[A-Za-z0-9_-]{1,32}$/.test(server)) continue;
          const id = `@mcp/${server}`;
          if (!automatic.has(id)) {
            automatic.set(id, {
              id, label: server, kind: 'mcp', automatic: true, match: [], matchers: [], tools: [],
            });
          }
        }
      }
      const rank = { official: 0, mcp: 1, plugin: 2, unknown: 3 };
      const discovered = [...automatic.values()].sort((left, right) =>
        rank[left.kind] - rank[right.kind] || left.label.localeCompare(right.label));
      groups.unshift(...discovered.filter(prioritized));
      groups.push(...discovered.filter((group) => !prioritized(group)));
      const managed = names.filter((name) => owner.has(name));
      return { groups, owner, ungrouped, managed, providers, registered: new Set(names) };
    }

    function baselineToolVisible(mode, groupValue) {
      let visible = mode !== 'allow';
      if (groupValue === 'on') visible = true;
      else if (groupValue === 'off') visible = false;
      return visible;
    }

    function isToolVisible(mode, groupId, overrides, name) {
      const groups = isObject(overrides) && isObject(overrides.groups) ? overrides.groups : {};
      const tools = isObject(overrides) && isObject(overrides.tools) ? overrides.tools : {};
      let visible = baselineToolVisible(mode, groups[groupId]);
      if (tools[name] === 'on') visible = true;
      else if (tools[name] === 'off') visible = false;
      return visible;
    }

    function groupStateOf(mode, groupId, tools, overrides) {
      if (!Array.isArray(tools) || tools.length === 0) return 'none';
      let visible = 0;
      for (const name of tools) if (isToolVisible(mode, groupId, overrides, name)) visible += 1;
      if (visible === 0) return 'none';
      return visible === tools.length ? 'all' : 'partial';
    }

    /** 零工具 MCP 服务器组：开关直接写组覆盖，状态由覆盖与 mode 基线决定。 */
    function serverGroupStateOf(mode, overrides, groupId) {
      const groups = isObject(overrides) && isObject(overrides.groups) ? overrides.groups : {};
      const value = groups[groupId];
      if (value === 'on') return 'all';
      if (value === 'off') return 'none';
      return mode === 'allow' ? 'none' : 'all';
    }

    function ensureRoleEntry(draft, roleId) {
      const stored = isObject(draft.roles) ? draft.roles[roleId] : undefined;
      const base = isObject(stored) ? stored : null;
      const configured = base !== null && base.configured === true;
      const mode = configured ? (base.mode === 'allow' ? 'allow' : 'open') : draft.unlisted === 'closed' ? 'allow' : 'open';
      return {
        configured: true,
        mode,
        groups: base !== null ? copyOverrides(base.groups) : {},
        tools: base !== null ? copyOverrides(base.tools) : {},
      };
    }

    function withRole(draft, roleId, entry) {
      return { ...draft, roles: { ...draft.roles, [roleId]: entry } };
    }

    function serializeDraft(draft) {
      const sources = {};
      for (const id of Object.keys(draft.sources)) {
        const source = draft.sources[id];
        const label = asText(source.label);
        sources[id] = { label: label === '' ? id : label, match: splitMatch(source.match) };
      }
      const roles = {};
      for (const roleId of Object.keys(draft.roles).sort()) {
        const role = draft.roles[roleId];
        if (!isObject(role) || role.configured !== true) continue;
        roles[roleId] = {
          mode: role.mode === 'allow' ? 'allow' : 'open',
          groups: copyOverrides(role.groups),
          tools: copyOverrides(role.tools),
        };
      }
      return { discovery: draft.discovery === true, unlisted: draft.unlisted === 'closed' ? 'closed' : 'open', sources, roles };
    }

    function matchesSavedConfig(payload, confirmation, nextDraft) {
      if (confirmation.version !== null && typeof payload.configVersion === 'string') {
        return payload.configVersion === confirmation.version;
      }
      return stableSnapshot(serializeDraft(nextDraft ?? draftFromInventory(payload))) === confirmation.snapshot;
    }

    function draftProblemOf(draft) {
      if (draft === null) return '';
      for (const id of Object.keys(draft.sources)) {
        const source = draft.sources[id];
        if (!SOURCE_ID_PATTERN.test(id)) return fill(t('manageInvalidId'), { id });
        const items = splitMatch(source.match);
        if (items.length === 0) {
          const label = asText(source.label);
          return fill(t('manageEmptyMatch'), { label: label === '' ? id : label });
        }
        if (
          items.some((item) => item.length > MAX_MATCH_ITEM_LENGTH) ||
          items.reduce((sum, item) => sum + item.length, 0) > MAX_MATCH_TOTAL_LENGTH
        ) {
          return t('manageMatchTooLong');
        }
      }
      return '';
    }

    /* ------------------------------------------------------------------ */
    /* 基础控件（对照 DSH 0.2.2-rc.3 的 ui-primitives 源码）                */
    /* ------------------------------------------------------------------ */

    /** Host Switch：36×20 轨道、16×16 圆形滑块。 */
    function Switch(props) {
      return h(
        'button',
        {
          type: 'button',
          role: 'switch',
          className: 'tx-switch',
          'aria-checked': props.checked === true,
          'aria-label': props.mixed === true ? `${props.label} · ${t('groupPartial')}` : props.label,
          title: props.label,
          'data-mixed': props.mixed === true ? 'true' : undefined,
          disabled: props.disabled === true,
          onClick: (event) => {
            event.stopPropagation();
            if (props.disabled === true) return;
            props.onChange(!(props.checked === true));
          },
        },
        h('span', { className: 'tx-switchThumb', 'aria-hidden': 'true' }),
      );
    }

    /** Host SegmentedTabs 的 sm 尺寸；此处用于值选择，保留按钮组语义。 */
    function Segmented(props) {
      return h(
        'div',
        { className: 'tx-seg', role: 'group', 'aria-label': props.ariaLabel,
          style: { gridTemplateColumns: `repeat(${props.options.length}, minmax(0, 1fr))` } },
        h('span', {
          className: 'tx-segIndicator', 'aria-hidden': 'true',
          style: {
            width: `calc((100% - 4px) / ${props.options.length})`,
            transform: `translateX(${Math.max(0, props.options.findIndex((option) => option.value === props.value)) * 100}%)`,
          },
        }),
        props.options.map((option) =>
          h(
            'button',
            {
              key: option.value,
              type: 'button',
              className: 'tx-segBtn',
              'data-active': props.value === option.value ? 'true' : undefined,
              'aria-pressed': props.value === option.value,
              disabled: props.disabled === true,
              onClick: () => {
                if (props.disabled !== true && props.value !== option.value) props.onChange(option.value);
              },
            },
            option.label,
          ),
        ),
      );
    }

    function Notice({ notice, onDismiss }) {
      const tone = notice?.tone;
      const canDismiss = tone === 'error' || tone === 'info';
      return h(
        'div',
        { className: 'tx-feedback' },
        h('span', { className: 'tx-srOnly', role: 'status', 'aria-atomic': true },
          tone !== 'error' ? notice?.text : null),
        notice ? h('div', { className: 'tx-notice', 'data-tone': tone },
          h(Icon, { kind: tone === 'ok' ? 'check' : tone === 'error' ? 'warning' : 'info' }),
          h('span', {
            className: 'tx-noticeText',
            role: tone === 'error' ? 'alert' : undefined,
            'aria-hidden': tone === 'error' ? undefined : true,
          }, notice.text),
          canDismiss ? h('button', {
            type: 'button', className: 'tx-noticeDismiss',
            'aria-label': t('dismissNotice'), title: t('dismissNotice'), onClick: onDismiss,
          }, h(Icon, { kind: 'close' })) : null,
        ) : null,
      );
    }

    function Chevron(props) {
      return h(
        'svg',
        {
          className: 'tx-chevron',
          width: 12,
          height: 12,
          viewBox: '0 0 12 12',
          'aria-hidden': 'true',
          'data-open': props.open === true ? 'true' : undefined,
        },
        h('path', {
          d: 'M4.5 2.5 8 6l-3.5 3.5',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      );
    }

    function ToolExposureIcon() {
      return h('svg', {
        className: 'tx-icon', width: 16, height: 16, viewBox: '0 0 24 24',
        fill: 'none', 'aria-hidden': 'true',
      },
      h('path', {
        d: 'M2.5 12C4.8 8.1 8.2 5.75 12 5.75s7.2 2.35 9.5 6.25c-2.3 3.9-5.7 6.25-9.5 6.25S4.8 15.9 2.5 12Z',
        stroke: 'currentColor', strokeWidth: 1.75, strokeLinejoin: 'round',
      }),
      h('circle', { cx: 12, cy: 12, r: 2.6, fill: 'currentColor' }));
    }

    function Icon({ kind = 'tools' } = {}) {
      const paths = {
        tools: 'M3 4h6v6H3zM15 4h6v6h-6zM3 16h6v5H3zM15 16h6v5h-6zM5 7h2M17 18h2',
        back: 'm10 6-6 6 6 6M4 12h16',
        search: 'M10.5 18a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15m5.5-2 5 5',
        refresh: 'M20 7v5h-5M4 17v-5h5M6.1 7a7 7 0 0 1 11.5-1L20 9M4 15l2.4 3A7 7 0 0 0 18 17',
        official: 'M12 3 4 6v6c0 4.5 8 9 8 9s8-4.5 8-9V6l-8-3Zm-4 9 3 3 5-6',
        check: 'm5 12 4 4L19 6',
        warning: 'M12 3 2.5 20h19L12 3Zm0 6v4m0 3h.01',
        info: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9-1v5m0-8h.01',
        close: 'm6 6 12 12M18 6 6 18',
      };
      return h('svg', { className: 'tx-icon', width: 16, height: 16, viewBox: '0 0 24 24',
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
      h('path', { d: paths[kind] || paths.tools }));
    }

    function pluginImage(src) {
      if (typeof src !== 'string' || !/^data:image\/(?:svg\+xml|png|jpeg|webp);base64,/.test(src)) return null;
      return h('img', {
        className: 'tx-pluginImage', src, alt: '', hidden: true,
        onLoad: (event) => { event.currentTarget.hidden = false; },
        onError: (event) => { event.currentTarget.hidden = true; },
      });
    }

    /* ------------------------------------------------------------------ */
    /* 页面                                                                */
    /* ------------------------------------------------------------------ */

    function ToolExposurePage(props = {}) {
      const memory = props.memory;
      const cached = memory?.snapshot;
      const restored = cached?.dirty || memory?.pendingSave || memory?.awaitingSnapshot ? cached : null;
      const [phase, setPhase] = React.useState(restored?.inventory ? 'ready' : 'loading');
      const [inventory, setInventory] = React.useState(restored?.inventory || null);
      const [draft, setDraft] = React.useState(restored?.draft || null);
      // 最近一次“已保存/已加载”的草稿快照，用于脏检测与放弃修改。
      // 保存成功后立即更新它：即使随后的重扫失败（Host 热重载窗口），界面也不该同时
      // 显示“已保存”和“有未保存的修改”。
      const [baseline, setBaseline] = React.useState(restored?.baseline || null);
      const [configVersion, setConfigVersion] = React.useState(restored?.configVersion ?? null);
      const [busy, setBusy] = React.useState(memory?.pendingSave ? 'save' : '');
      const [notice, setNotice] = React.useState(restored?.notice || null);
      const [errorText, setErrorText] = React.useState('');
      const [selectedRole, setSelectedRole] = React.useState(cached?.selectedRole || '');
      const [expanded, setExpanded] = React.useState(cached?.expanded || {});
      const [filteredExpanded, setFilteredExpanded] = React.useState(cached?.filteredExpanded || {});
      const [toolQuery, setToolQuery] = React.useState(cached?.toolQuery || '');
      const [roleQuery, setRoleQuery] = React.useState(cached?.roleQuery || '');
      const [visibility, setVisibility] = React.useState(cached?.visibility || 'all');
      const filterActive = toolQuery.trim() !== '' || visibility !== 'all';
      const shownExpansion = filterActive ? filteredExpanded : expanded;
      const setShownExpansion = filterActive ? setFilteredExpanded : setExpanded;
      const [manageOpen, setManageOpen] = React.useState(false);
      const [addForm, setAddForm] = React.useState(null);
      const [liftConfirm, setLiftConfirm] = React.useState(false);
      const [showEffective, setShowEffective] = React.useState(false);
      const [renameForm, setRenameForm] = React.useState(null);
      const mounted = React.useRef(true);
      const seq = React.useRef(0);
      const draftRef = React.useRef(null);
      const savingRef = React.useRef(Boolean(memory?.pendingSave));
      draftRef.current = draft;

      React.useEffect(() => {
        mounted.current = true;
        return () => {
          mounted.current = false;
          seq.current += 1;
        };
      }, []);

      const applyInventory = React.useCallback((payload, manual = false) => {
        const nextDraft = draftFromInventory(payload);
        const version = typeof payload.configVersion === 'string' ? payload.configVersion : null;
        const confirmation = memory?.awaitingSnapshot;
        if (confirmation) {
          // 同时保护初次加载、手工扫描和后台回读，旧 Host handler 不能回滚已保存策略。
          const externalUpdate = manual && version !== null && confirmation.baseVersion !== null
            && version !== confirmation.baseVersion;
          if (!externalUpdate && !matchesSavedConfig(payload, confirmation, nextDraft)) return false;
          memory.awaitingSnapshot = null;
        }
        const roleIds = (Array.isArray(payload.roles) ? payload.roles : [])
          .filter((role) => isObject(role) && typeof role.id === 'string' && role.id !== '')
          .map((role) => role.id);
        setInventory(payload);
        setDraft(nextDraft);
        setBaseline(nextDraft);
        setConfigVersion(version);
        setAddForm(null);
        setRenameForm(null);
        setSelectedRole((current) => (roleIds.includes(current) ? current : roleIds[0] || ''));
        setPhase('ready');
        setErrorText('');
        return true;
      }, [memory]);

      const load = React.useCallback(async () => {
        const token = ++seq.current;
        setPhase('loading');
        setErrorText('');
        try {
          const payload = await requestJson(ROUTE_INVENTORY);
          if (!mounted.current || token !== seq.current) return;
          applyInventory(payload);
        } catch (error) {
          if (!mounted.current || token !== seq.current) return;
          setErrorText(errorTextOf(error));
          setPhase('error');
        }
      }, [applyInventory]);

      React.useEffect(() => {
        if (!restored?.inventory) void load();
      }, [load]);

      React.useEffect(() => {
        const pending = memory?.pendingSave;
        if (!pending) return;
        void pending.then(({ postedDraft, confirmation }) => {
          if (!mounted.current) return;
          setBaseline(postedDraft);
          setConfigVersion(confirmation.version);
          setNotice({ tone: 'ok', text: t('saved') });
          void refreshAfterSave(confirmation);
        }, (error) => {
          if (mounted.current) setNotice(saveFailureNotice(error));
        }).finally(() => {
          savingRef.current = false;
          if (mounted.current) setBusy('');
        });
      }, [memory]);

      // 成功提示自动消失，其他提示可手动关闭。
      React.useEffect(() => {
        if (notice === null || notice.tone !== 'ok') return undefined;
        const timer = setTimeout(() => {
          if (mounted.current) setNotice(null);
        }, NOTICE_TTL_MS);
        return () => clearTimeout(timer);
      }, [notice]);

      // 保存后的重扫：Host 的配置行重载是异步的，旧 handler 在重载完成前仍会用旧 config
      // 应答 /inventory。只有服务端快照与刚 POST 的草稿一致时才应用，否则继续重试；
      // 这样不会用旧配置覆盖界面（否则用户下一次保存会把上一次保存抹掉）。
      const refreshAfterSave = React.useCallback(
        async (confirmation) => {
          const token = seq.current;
          const stillCurrent = () => mounted.current && token === seq.current
            && (!memory || memory.awaitingSnapshot === confirmation);
          for (let attempt = 0; attempt < RESCAN_RETRIES + 1; attempt += 1) {
            await wait(attempt === 0 ? SAVE_RESCAN_DELAY_MS : RESCAN_RETRY_MS);
            if (!stillCurrent()) return;
            try {
              const payload = await requestJson(ROUTE_INVENTORY);
              if (!stillCurrent()) return;
              if (!matchesSavedConfig(payload, confirmation)) continue;
              if (memory) memory.awaitingSnapshot = null;
              setNotice((current) => current?.kind === 'rescanWaiting' ? null : current);
              // 后台重扫期间用户又改了草稿：不能用服务端状态覆盖。
              if (draftRef.current === null || stableSnapshot(serializeDraft(draftRef.current)) !== confirmation.snapshot) return;
              applyInventory(payload);
              return;
            } catch {
              if (!stillCurrent()) return;
            }
          }
        },
        [applyInventory, memory],
      );

      React.useEffect(() => {
        // 保存可能在离开页面后完成。保留已提交策略，直到 Host 确认加载了同一版本。
        if (memory?.awaitingSnapshot) void refreshAfterSave(memory.awaitingSnapshot);
      }, [memory, refreshAfterSave]);

      /* --------------------------- 草稿修改 --------------------------- */

      const updateDraft = (updater) => {
        setDraft((current) => {
          if (current === null) return current;
          const next = updater(current);
          return isObject(next) ? next : current;
        });
        setNotice((current) => current?.tone === 'info' ? current : null);
      };

      const changeUnlisted = (value) => {
        updateDraft((current) => ({ ...current, unlisted: value === 'closed' ? 'closed' : 'open' }));
      };

      const changeMode = (roleId, mode) => {
        const nextMode = mode === 'allow' ? 'allow' : 'open';
        updateDraft((current) => {
          const stored = current.roles[roleId];
          const configured = isObject(stored) && stored.configured === true;
          const fallback = current.unlisted === 'closed' ? 'allow' : 'open';
          // 未配置的角色点「已选中的默认项」不应物化配置，否则会悄悄脱离全局默认。
          if (!configured && nextMode === fallback) return current;
          const entry = ensureRoleEntry(current, roleId);
          return withRole(current, roleId, { ...entry, mode: nextMode });
        });
      };

      const toggleGroup = (roleId, groupId, tools) => {
        if (!Array.isArray(tools) || tools.length === 0) return;
        updateDraft((current) => {
          const entry = ensureRoleEntry(current, roleId);
          const state = groupStateOf(entry.mode, groupId, tools, entry);
          const desired = state === 'all' ? 'off' : 'on';
          const baseline = entry.mode === 'allow' ? 'off' : 'on';
          const groups = { ...entry.groups };
          // 与基线一致时删掉覆盖，避免 off→on 往返留下粘性配置（脏标记也回不去）。
          if (desired === baseline) delete groups[groupId];
          else groups[groupId] = desired;
          const nextTools = { ...entry.tools };
          for (const name of tools) delete nextTools[name];
          return withRole(current, roleId, { ...entry, groups, tools: nextTools });
        });
      };

      // 零工具 MCP 服务器组的开关：与整组开关同一套「写覆盖 / 删覆盖」语义，
      // 只管理该服务器在系统提示词中的 instructions 与名单条目。
      const toggleServerGroup = (roleId, groupId) => {
        updateDraft((current) => {
          const entry = ensureRoleEntry(current, roleId);
          const state = serverGroupStateOf(entry.mode, entry, groupId);
          const desired = state === 'all' ? 'off' : 'on';
          const baseline = entry.mode === 'allow' ? 'off' : 'on';
          const groups = { ...entry.groups };
          if (desired === baseline) delete groups[groupId];
          else groups[groupId] = desired;
          return withRole(current, roleId, { ...entry, groups });
        });
      };

      const toggleTool = (roleId, groupId, name) => {
        updateDraft((current) => {
          const entry = ensureRoleEntry(current, roleId);
          const desired = isToolVisible(entry.mode, groupId, entry, name) ? 'off' : 'on';
          const baseline = baselineToolVisible(entry.mode, entry.groups[groupId]);
          const nextTools = { ...entry.tools };
          if ((desired === 'on') === baseline) delete nextTools[name];
          else nextTools[name] = desired;
          return withRole(current, roleId, { ...entry, tools: nextTools });
        });
      };

      const changeSource = (id, patch) => {
        updateDraft((current) => {
          const source = current.sources[id];
          if (source === undefined) return current;
          return { ...current, sources: { ...current.sources, [id]: { ...source, ...patch } } };
        });
      };

      // 手改配置可能留下不合法/需要整理的组 id；改名时同步重映射各角色的组覆盖。
      const commitRename = () => {
        if (renameForm === null || draft === null) return;
        const from = renameForm.id;
        const to = asText(renameForm.value);
        if (!SOURCE_ID_PATTERN.test(to)) {
          setNotice({ tone: 'error', text: to === '' ? t('manageIdHint') : fill(t('manageInvalidId'), { id: to }) });
          return;
        }
        if (to !== from && Object.prototype.hasOwnProperty.call(draft.sources, to)) {
          setNotice({ tone: 'error', text: t('manageDuplicateId') });
          return;
        }
        if (to !== from) {
          updateDraft((current) => {
            if (!Object.prototype.hasOwnProperty.call(current.sources, from)) return current;
            const sources = {};
            for (const key of Object.keys(current.sources)) {
              if (key === from) sources[to] = current.sources[from];
              else sources[key] = current.sources[key];
            }
            const roles = {};
            for (const roleId of Object.keys(current.roles)) {
              const role = current.roles[roleId];
              const groups = {};
              for (const groupId of Object.keys(role.groups)) {
                groups[groupId === from ? to : groupId] = role.groups[groupId];
              }
              roles[roleId] = { ...role, groups };
            }
            return { ...current, sources, roles };
          });
        }
        setRenameForm(null);
        setNotice(null);
      };

      const removeSource = (id) => {
        const source = draft !== null ? draft.sources[id] : undefined;
        const label = groupLabel(id, source === undefined ? '' : source.label);
        if (
          typeof window !== 'undefined' &&
          typeof window.confirm === 'function' &&
          !window.confirm(fill(t('removeGroupConfirm'), { label }))
        ) {
          return;
        }
        updateDraft((current) => {
          const sources = { ...current.sources };
          delete sources[id];
          let detachedTools = [];
          if (!current.discovery) {
            const catalog = inventory?.globalTools ?? inventory?.tools;
            const toolNames = (Array.isArray(catalog) ? catalog : [])
              .filter((tool) => typeof tool?.name === 'string' && tool.name !== '')
              .map((tool) => tool.name);
            const before = buildLocalIndex(current.sources, toolNames);
            const after = buildLocalIndex(sources, toolNames);
            detachedTools = before.groups.find((group) => group.id === id)?.tools.filter((name) => !after.owner.has(name)) ?? [];
          }
          const roles = {};
          for (const roleId of Object.keys(current.roles)) {
            const role = current.roles[roleId];
            const groups = { ...role.groups };
            delete groups[id];
            const tools = { ...role.tools };
            for (const name of detachedTools) delete tools[name];
            roles[roleId] = { ...role, groups, tools };
          }
          return { ...current, sources, roles };
        });
      };

      const addSource = () => {
        if (addForm === null || draft === null) return;
        const id = asText(addForm.id);
        const label = asText(addForm.label);
        if (!SOURCE_ID_PATTERN.test(id)) {
          setNotice({ tone: 'error', text: fill(t('manageInvalidId'), { id }) });
          return;
        }
        if (Object.prototype.hasOwnProperty.call(draft.sources, id)) {
          setNotice({ tone: 'error', text: t('manageDuplicateId') });
          return;
        }
        const match = splitMatch(addForm.match);
        if (match.length === 0) {
          setNotice({ tone: 'error', text: fill(t('manageEmptyMatch'), { label: label === '' ? id : label }) });
          return;
        }
        updateDraft((current) => {
          const source = { label: label === '' ? id : label, match: match.join(', ') };
          const sources = {};
          let inserted = false;
          for (const [groupId, existing] of Object.entries(current.sources)) {
            // Preserve first-match semantics while keeping a catch-all from swallowing the new group.
            if (!inserted && splitMatch(existing.match).includes('*')) {
              sources[id] = source;
              inserted = true;
            }
            sources[groupId] = existing;
          }
          if (!inserted) sources[id] = source;
          return { ...current, sources };
        });
        setAddForm(null);
      };

      const editAddForm = (field, value) => {
        setAddForm((current) => {
          if (current === null) return current;
          const next = { ...current, [field]: value };
          if (field === 'id') next.idTouched = true;
          if (field === 'label' && current.idTouched !== true) {
            const slug = slugify(value);
            // 中文名称 slug 为空时给一个可用的默认 id，否则「添加」会永久灰掉。
            next.id = value === '' ? '' : slug !== '' ? slug : nextGroupId(draft === null ? {} : draft.sources);
          }
          return next;
        });
      };

      const toggleExpanded = (groupId) => {
        setShownExpansion((current) => ({
          ...current,
          [groupId]: !(Object.hasOwn(current, groupId) ? current[groupId] : filterActive),
        }));
      };

      /* --------------------------- 派生数据 --------------------------- */

      const groupLocale = [t('officialTools'), t('unknownProvider'), t('globalTools')].join('\0');
      const view = React.useMemo(() => {
        if (inventory === null || draft === null) return null;
        const validTools = (items) => (Array.isArray(items) ? items : []).filter(
          (tool) => isObject(tool) && typeof tool.name === 'string' && tool.name !== '',
        );
        const tools = validTools(inventory.tools);
        const globalTools = validTools(Array.isArray(inventory.globalTools) ? inventory.globalTools : inventory.tools);
        const mcpServerNames = (Array.isArray(inventory.mcpServers) ? inventory.mcpServers : [])
          .map((item) => (isObject(item) && typeof item.name === 'string' ? item.name : ''))
          .filter((name) => name !== '');
        const catalogForRole = (id) => draft.discovery && isObject(inventory.roleTools) && Object.prototype.hasOwnProperty.call(inventory.roleTools, id)
          ? validTools(inventory.roleTools[id]) : globalTools;
        const makeIndex = (catalog) => buildLocalIndex(draft.sources, catalog.map((tool) => tool.name), draft.discovery, catalog, mcpServerNames);
        const fallbackMode = draft.unlisted === 'closed' ? 'allow' : 'open';
        const roleViews = Object.create(null);
        for (const role of Array.isArray(inventory.roles) ? inventory.roles : []) {
          if (!isObject(role) || typeof role.id !== 'string' || role.id === '') continue;
          const stored = draft.roles[role.id];
          const configured = isObject(stored) && stored.configured === true;
          const mode = configured ? (stored.mode === 'allow' ? 'allow' : 'open') : fallbackMode;
          const overrides = configured ? stored : { groups: {}, tools: {} };
          const index = makeIndex(catalogForRole(role.id));
          const visible = new Set();
          const groupState = {};
          for (const group of index.groups) groupState[group.id] = { visible: 0, total: group.tools.length };
          for (const name of index.managed) {
            const groupId = index.owner.get(name);
            if (!isToolVisible(mode, groupId, overrides, name)) continue;
            visible.add(name);
            if (groupState[groupId] !== undefined) groupState[groupId].visible += 1;
          }
          roleViews[role.id] = {
            index,
            mode,
            configured,
            overrides,
            visible,
            visibleList: index.managed.filter((name) => visible.has(name)),
            hiddenList: index.managed.filter((name) => !visible.has(name)),
            groupState,
          };
        }
        const selectedTools = selectedRole === '' ? tools : catalogForRole(selectedRole);
        const index = roleViews[selectedRole]?.index || makeIndex(selectedTools);
        const descriptions = new Map();
        for (const tool of selectedTools) descriptions.set(tool.name, typeof tool.description === 'string' ? tool.description : '');
        return { index, roles: roleViews, descriptions };
      }, [inventory, draft, selectedRole, groupLocale]);

      const draftSnapshot = React.useMemo(() => (draft === null ? '' : stableSnapshot(draft)), [draft]);
      const baselineSnapshot = React.useMemo(() => (baseline === null ? '' : stableSnapshot(baseline)), [baseline]);
      const dirty = draftSnapshot !== '' && baselineSnapshot !== '' && draftSnapshot !== baselineSnapshot;
      const editable = inventory !== null && inventory.editable !== false;
      const locked = busy !== '' || !editable;
      const problems = draft === null ? '' : draftProblemOf(draft);
      const roles = (inventory !== null && Array.isArray(inventory.roles) ? inventory.roles : []).filter(
        (role) => isObject(role) && typeof role.id === 'string' && role.id !== '',
      ).map((role) => ({ ...role, ...roleDisplayText(role) }));
      const diagnostics = inventory !== null && Array.isArray(inventory.diagnostics) ? inventory.diagnostics : [];
      const activeRole = selectedRole !== '' ? roles.find((role) => role.id === selectedRole) || null : null;
      const activeView = activeRole !== null && view !== null ? view.roles[activeRole.id] || null : null;
      if (memory && inventory && draft) {
        memory.snapshot = {
          inventory, draft, baseline, configVersion, selectedRole, expanded, filteredExpanded, toolQuery, roleQuery, visibility, dirty, notice,
        };
      }

      const save = React.useCallback(async () => {
        if (savingRef.current || busy !== '' || draft === null) return;
        if (!editable) {
          setNotice({ tone: 'error', text: t('readonlyHint') });
          return;
        }
        if (problems !== '') {
          setNotice({ tone: 'error', text: problems });
          return;
        }
        if (!dirty) return;
        savingRef.current = true;
        setBusy('save');
        setNotice(null);
        const postedDraft = JSON.parse(JSON.stringify(draft));
        const body = serializeDraft(postedDraft);
        const snapshot = stableSnapshot(body);
        if (configVersion !== null) body.configVersion = configVersion;
        const pending = requestJson(ROUTE_SAVE, { method: 'POST', body: JSON.stringify(body) }).then((payload) => {
          if (payload.saved !== true) throw new Error(typeof payload.error === 'string' && payload.error !== '' ? payload.error : t('saveFailedShort'));
          const version = typeof payload.configVersion === 'string' ? payload.configVersion : null;
          const confirmation = { snapshot, version, baseVersion: configVersion };
          if (memory) memory.awaitingSnapshot = confirmation;
          if (memory?.snapshot) {
            memory.snapshot = { ...memory.snapshot, baseline: postedDraft, configVersion: version,
              dirty: stableSnapshot(memory.snapshot.draft) !== stableSnapshot(postedDraft), notice: { tone: 'ok', text: t('saved') } };
          }
          return { postedDraft, confirmation };
        });
        if (memory) memory.pendingSave = pending;
        try {
          const { confirmation } = await pending;
          if (!mounted.current) return;
          setNotice({ tone: 'ok', text: t('saved') });
          // 配置已写盘：先把当前草稿记为新的基线，再后台重扫（重扫失败也不影响脏状态，
          // 且不长时间锁住整页交互）。
          setBaseline(postedDraft);
          setConfigVersion(confirmation.version);
          void refreshAfterSave(confirmation);
        } catch (error) {
          const failure = saveFailureNotice(error);
          if (memory && error?.code === 'config_conflict') memory.awaitingSnapshot = null;
          if (memory?.snapshot) memory.snapshot.notice = failure;
          if (!mounted.current) return;
          setNotice(failure);
        } finally {
          if (memory?.pendingSave === pending) memory.pendingSave = null;
          savingRef.current = false;
          if (mounted.current) setBusy('');
        }
      }, [busy, draft, editable, problems, dirty, configVersion, refreshAfterSave, memory]);

      const rescan = React.useCallback(async () => {
        if (busy !== '') return;
        if (dirty) {
          if (
            typeof window !== 'undefined' &&
            typeof window.confirm === 'function' &&
            !window.confirm(t('rescanDiscard'))
          ) {
            return;
          }
        }
        setBusy('rescan');
        setNotice(null);
        const token = ++seq.current;
        try {
          const payload = await requestJson(ROUTE_INVENTORY);
          if (!mounted.current || token !== seq.current) return;
          if (applyInventory(payload, true)) {
            setNotice({ tone: 'ok', text: t('rescanDone') });
          } else if (memory?.awaitingSnapshot) {
            setNotice({ tone: 'info', kind: 'rescanWaiting', text: t('rescanWaiting') });
          }
        } catch (error) {
          if (!mounted.current || token !== seq.current) return;
          setNotice({ tone: 'error', text: fill(t('rescanFailed'), { error: errorTextOf(error) }) });
        } finally {
          if (mounted.current && token === seq.current) {
            setBusy('');
            if (memory?.awaitingSnapshot) void refreshAfterSave(memory.awaitingSnapshot);
          }
        }
      }, [busy, dirty, applyInventory, memory, refreshAfterSave]);

      const liftSessions = React.useCallback(async () => {
        if (busy !== '') return;
        setBusy('lift');
        setNotice(null);
        try {
          const payload = await requestJson(ROUTE_RESET, { method: 'POST', body: '{}' });
          if (!mounted.current) return;
          const count = typeof payload.lifted === 'number' && Number.isFinite(payload.lifted) ? payload.lifted : 0;
          setNotice({ tone: 'ok', text: fill(t('liftDone'), { count: String(count) }) });
        } catch (error) {
          if (!mounted.current) return;
          setNotice({ tone: 'error', text: errorTextOf(error) });
        } finally {
          if (mounted.current) {
            setBusy('');
            setLiftConfirm(false);
          }
        }
      }, [busy]);

      const discard = () => {
        if (baseline === null) return;
        setDraft(JSON.parse(JSON.stringify(baseline)));
        setNotice({ tone: 'ok', text: t('discarded') });
        setAddForm(null);
        setRenameForm(null);
      };

      // 已配置角色恢复成「继承全局默认」：删掉它自己的条目。
      const resetRole = (roleId) => {
        updateDraft((current) => {
          if (!Object.prototype.hasOwnProperty.call(current.roles, roleId)) return current;
          const roles = { ...current.roles };
          delete roles[roleId];
          return { ...current, roles };
        });
      };

      /* ----------------------------- 状态 ----------------------------- */

      const frame = (content, header = null) => h(
        'section', { className: 'tx-shell', 'aria-label': t('title') },
        header || h('div', { className: 'tx-topbar' },
          h('button', { type: 'button', className: 'tx-btn tx-back', onClick: props.onReturn,
            disabled: typeof props.onReturn !== 'function', title: dirty ? t('draftKept') : t('back') },
          h(Icon, { kind: 'back' }), t('back')),
          dirty ? h('span', { className: 'tx-draftHint' }, t('draftKept')) : null,
        ),
        h('div', { className: 'tx-page' }, content),
        h(Notice, { notice, onDismiss: () => setNotice(null) }),
      );

      if (phase === 'loading' && inventory === null) {
        return frame(h('p', { className: 'tx-state', role: 'status' }, t('loading')));
      }

      if (phase === 'error' || inventory === null || draft === null || view === null) {
        return frame(h(
            'div',
            { className: 'tx-errorCard' },
            h('div', { className: 'tx-errorTitle' }, t('loadFailedTitle')),
            errorText !== '' ? h('div', { className: 'tx-errorText' }, errorText) : null,
            h('p', { className: 'tx-errorHint' }, t('loadFailedHint')),
            h(
              'button',
              { type: 'button', className: 'tx-btn tx-btnPrimary', onClick: () => void load() },
              t('retry'),
            ),
          ));
      }

      /* ----------------------------- 渲染 ----------------------------- */

      const addId = addForm === null ? '' : asText(addForm.id);
      const addReady =
        addForm !== null &&
        SOURCE_ID_PATTERN.test(addId) &&
        !Object.prototype.hasOwnProperty.call(draft.sources, addId) &&
        splitMatch(addForm.match).length > 0;
      const addHint =
        addForm === null || addReady
          ? ''
          : addId === ''
            ? t('manageIdHint')
            : !SOURCE_ID_PATTERN.test(addId)
              ? fill(t('manageInvalidId'), { id: addId })
              : Object.prototype.hasOwnProperty.call(draft.sources, addId)
                ? t('manageDuplicateId')
                : fill(t('manageEmptyMatch'), { label: asText(addForm.label) === '' ? addId : asText(addForm.label) });

      const visibleRoles = roles.filter((role) => `${role.id} ${role.displayName} ${role.displayDescription}`.toLowerCase().includes(roleQuery.trim().toLowerCase()));
      const roleCards = visibleRoles.map((role) => {
        const roleView = view.roles[role.id] || { index: view.index, mode: 'open', configured: false, visibleList: [], hiddenList: [] };
        const roleName = role.displayName;
        const modeLabel = roleView.mode === 'allow' ? t('modeAllow') : t('modeOpen');
        const meta = fill(t('roleMeta'), {
          mode: modeLabel,
          visible: String(roleView.visibleList.length),
          managed: String(roleView.index.managed.length),
        });
        return h(
          'button',
          {
            key: role.id,
            type: 'button',
            className: 'tx-roleCard',
            'data-active': role.id === selectedRole ? 'true' : undefined,
            'aria-pressed': role.id === selectedRole,
            onClick: () => setSelectedRole(role.id),
          },
          h(
            'span',
            { className: 'tx-roleHead' },
            h('span', { className: 'tx-roleName', title: roleName }, roleName),
            role.isDefault === true ? h('span', { className: 'tx-tag' }, t('roleDefault')) : null,
            role.broken ? h('span', { className: 'tx-tag tx-tagDanger', title: role.broken }, t('roleBroken')) : null,
          ),
          h('code', { className: 'tx-roleId', title: role.id }, role.id),
          h('span', { className: 'tx-roleDesc', title: role.displayDescription || undefined }, role.displayDescription || t('roleNoDescription')),
          h('span', { className: 'tx-roleMeta' }, meta),
        );
      });

      const packageMetadata = (Array.isArray(inventory.providerMetadata) ? inventory.providerMetadata : []).map((item) => ({
        title: packageDisplayText(item?.title),
        icon: item?.icon,
      }));
      const providers = new Map();
      for (const [name, identity] of view.index.providers) {
        if (!identity?.plugin) continue;
        const bundle = packageMetadata[identity.packageMeta];
        const module = packageMetadata[identity.moduleMeta];
        const bundleTitle = bundle?.title && bundle.title !== identity.plugin ? bundle.title : module?.title || identity.plugin;
        providers.set(name, {
          ...identity,
          bundleTitle,
          bundleIcon: bundle?.icon || module?.icon,
          title: module?.title || bundleTitle,
          icon: module?.icon || bundle?.icon,
        });
      }

      const query = toolQuery.trim().toLowerCase();
      const filteredGroups = view.index.groups.map((group) => {
        const first = providers.get(group.tools[0]);
        // The official aggregate can contain several providers and has its own artwork.
        const provider = group.kind !== 'official' && first
          && group.tools.every((name) => providers.get(name)?.plugin === first.plugin) ? first : null;
        const label = group.kind === 'plugin' && provider ? provider.bundleTitle : group.label;
        const groupMatch = label.toLowerCase().includes(query);
        const matchingTools = group.tools.filter((name) => {
          const visible = activeView?.visible.has(name) === true;
          if (visibility === 'visible' && !visible || visibility === 'hidden' && visible) return false;
          const source = providers.get(name);
          return groupMatch || [
            name, view.descriptions.get(name), source?.plugin, source?.module, source?.bundleTitle, source?.title,
          ].some((text) => typeof text === 'string' && text.toLowerCase().includes(query));
        });
        // 零工具的 MCP 服务器组：按服务器提示词可见性参与筛选，而不是按工具。
        const serverOnly = group.kind === 'mcp' && group.tools.length === 0;
        const serverState = serverOnly && activeView !== null
          ? serverGroupStateOf(activeView.mode, activeView.overrides, group.id)
          : null;
        const serverPass = serverState !== null && groupMatch
          && (visibility === 'all' || (visibility === 'visible' ? serverState === 'all' : serverState !== 'all'));
        const open = Object.hasOwn(shownExpansion, group.id) ? shownExpansion[group.id] : filterActive;
        return { ...group, label, provider, matchingTools, open, serverOnly, serverState, serverPass };
      }).filter((group) => !filterActive || (group.serverOnly ? group.serverPass : group.matchingTools.length > 0));
      const matchingCount = filteredGroups.reduce((sum, group) => sum + group.matchingTools.length, 0);
      const expandableGroups = filteredGroups.filter((group) => group.matchingTools.length > 0);
      const hasCollapsedGroup = expandableGroups.some((group) => !group.open);
      const hasOpenGroup = filteredGroups.some((group) => group.open);
      const hasManageableTools = view.index.managed.length > 0;
      const groupRows = filteredGroups.map((group) => {
        const isOpen = group.open;
        const emptyLabel = group.serverOnly
          ? t('mcpPromptOnly')
          : group.match.includes('*') ? t('groupEmpty') : t('groupNoTools');
        let detail;
        if (group.kind === 'plugin') {
          detail = group.provider?.plugin === group.label ? '' : group.provider?.plugin;
        } else if (group.kind === 'mcp') {
          detail = t('mcpServer');
        } else if (group.automatic) {
          detail = t('automaticGroup');
        } else {
          detail = [group.provider?.bundleTitle, ...group.match].filter(Boolean).join(' · ');
        }
        const stats = activeView !== null ? activeView.groupState[group.id] : { visible: 0, total: 0 };
        // 零工具服务器组的状态来自组覆盖与 mode 基线（提示词可见性），
        // 有工具的组仍按组内工具可见数计算。
        const state = group.serverOnly
          ? (group.serverState ?? 'none')
          : stats === undefined || stats.total === 0 ? 'none' : stats.visible === 0 ? 'none' : stats.visible === stats.total ? 'all' : 'partial';
        const stateLabel =
          group.serverOnly && group.serverState !== null
            ? (group.serverState === 'all' ? t('toolVisible') : t('toolHidden'))
            : stats === undefined || stats.total === 0
              ? '—'
              : state === 'all'
                ? t('toolVisible')
                : state === 'partial'
                  ? t('groupPartial')
                  : t('toolHidden');
        return h(
          'div',
          { key: group.id, className: 'tx-toolGroup', 'data-open': isOpen, 'data-kind': group.kind || 'custom' },
          h(
            'div',
            { className: 'tx-groupRow', 'data-kind': group.kind || 'custom' },
            h(
              'button',
              {
                type: 'button',
                className: 'tx-groupMain',
                'aria-expanded': isOpen,
                onClick: () => toggleExpanded(group.id),
              },
              h('span', { className: 'tx-groupIcon', 'aria-hidden': true },
                h(Icon, { kind: group.kind === 'official' ? 'official' : 'tools' }),
                pluginImage(group.provider?.bundleIcon)),
              h(
                'span',
                { className: 'tx-groupText' },
                h('span', { className: 'tx-groupName', title: group.label }, group.label),
                h(
                  'span',
                  { className: 'tx-groupMeta' },
                  detail ? h('span', { className: 'tx-groupSource', title: detail }, detail) : null,
                  detail ? h('span', { className: 'tx-dot' }, '·') : null,
                  !group.serverOnly
                    ? h('span', { className: 'tx-groupCount' }, fill(t('groupTools'), { count: String(group.tools.length) }))
                    : null,
                  group.tools.length === 0 ? h('span', { className: 'tx-sectionMeta' }, emptyLabel) : null,
                ),
              ),
              h(Chevron, { open: isOpen }),
            ),
            h(
              'span',
              { className: 'tx-groupEnd' },
              h('span', { className: 'tx-groupState', 'data-state': state }, stateLabel),
              h(Switch, {
                checked: state === 'all',
                mixed: state === 'partial',
                disabled: locked || activeRole === null || (group.tools.length === 0 && !group.serverOnly),
                label: `${group.label} · ${activeRole === null ? '' : activeRole.displayName}`,
                onChange: () => {
                  if (activeRole === null) return;
                  if (group.serverOnly) toggleServerGroup(activeRole.id, group.id);
                  else toggleGroup(activeRole.id, group.id, group.tools);
                },
              }),
            ),
          ),
          isOpen
            ? h(
                'div',
                { className: 'tx-toolList' },
                group.tools.length === 0
                  ? h('div', { className: 'tx-toolEmpty' }, emptyLabel)
                  : group.matchingTools.map((name) => {
                      const provider = providers.get(name);
                      return h(
                        'div',
                        { key: name, className: 'tx-toolRow' },
                        h(
                          'span',
                          { className: 'tx-toolText' },
                          h('span', { className: 'tx-toolName', title: name }, name),
                          h(
                            'span',
                            { className: 'tx-toolDesc', title: view.descriptions.get(name) || undefined },
                            view.descriptions.get(name) || '',
                          ),
                          h(
                            'span',
                            { className: 'tx-toolProvider', title: provider?.module || provider?.plugin },
                            pluginImage(provider?.icon),
                            h('span', { className: 'tx-toolDesc' }, provider
                              ? fill(t('providerLabel'), { plugin: provider.title })
                              : t('unknownProvider')),
                          ),
                        ),
                        h(Switch, {
                          checked: activeView !== null && activeView.visible.has(name),
                          disabled: locked || activeRole === null,
                          label: name,
                          onChange: () => {
                            if (activeRole !== null) toggleTool(activeRole.id, group.id, name);
                          },
                        }),
                      );
                    }),
              )
            : null,
        );
      });

      const ungrouped = view.index.ungrouped;

      const activeName = activeRole === null ? '' : activeRole.displayName;
      const activeMode = activeView === null ? 'open' : activeView.mode;
      const headerStatus = busy === 'save' ? t('saving')
        : busy === 'rescan' ? t('rescanning') : dirty ? t('unsaved') : t('intro');

      const header = h(
          'header',
          { className: 'tx-head' },
          h(
            'div',
            { className: 'tx-headText' },
            h('h2', { className: 'tx-title' }, t('title')),
            h('p', { className: 'tx-intro', title: headerStatus, 'data-state': dirty && busy === '' ? 'dirty' : undefined }, headerStatus),
          ),
          h(
            'div',
            { className: 'tx-toolbar' },
            h('button', { type: 'button', className: 'tx-btn tx-back', onClick: props.onReturn,
              disabled: typeof props.onReturn !== 'function', title: dirty ? t('draftKept') : t('back') },
              h(Icon, { kind: 'back' }), t('back')),
            h(
              'button',
              {
                type: 'button', className: 'tx-btn tx-btnOutline', disabled: busy !== '',
                'aria-busy': busy === 'rescan', onClick: () => void rescan(),
              },
              h(Icon, { kind: 'refresh' }),
              t('rescan'),
            ),
            h(
              'button',
              { type: 'button', className: 'tx-btn tx-btnSm', disabled: busy !== '' || !dirty, onClick: discard },
              t('discard'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'tx-btn tx-btnPrimary',
                // 有校验问题时不禁用保存：点击后显示校验提示，比一个
                // 只能 hover 才看到原因的禁用按钮更可诊断。
                disabled: locked || !dirty || !editable,
                'aria-busy': busy === 'save',
                title: !editable ? t('readonlyHint') : problems !== '' ? problems : undefined,
                onClick: () => void save(),
              },
              t('save'),
            ),
          ),
        );

      return frame(h(React.Fragment, null,

        !editable ? h('p', { className: 'tx-hint' }, t('readonlyHint')) : null,
        diagnostics.length > 0
          ? h(
              'div',
              { className: 'tx-warnCard' },
              h('div', { className: 'tx-warnTitle' }, t('diagnosticsTitle')),
              h(
                'ul',
                { className: 'tx-warnList' },
                diagnostics.map((item, index) =>
                  h('li', { key: `diag-${index}` }, isObject(item) && typeof item.text === 'string' ? item.text : String(item)),
                ),
              ),
            )
          : null,

        h('div', { className: 'tx-workspace' },
        // 角色卡片
        h(
          'section',
          { className: 'tx-section tx-rolePanel' },
          h(
            'div',
            { className: 'tx-sectionHead' },
            h('h3', { className: 'tx-sectionTitle' }, t('rolesTitle')),
            h('span', { className: 'tx-sectionMeta' }, `${roles.length}`),
          ),
          h('label', { className: 'tx-search' }, h(Icon, { kind: 'search' }),
            h('input', { type: 'search', value: roleQuery, placeholder: t('roleSearch'), 'aria-label': t('roleSearch'),
              onChange: (event) => setRoleQuery(event.target.value) })),
          visibleRoles.length === 0
            ? h('p', { className: 'tx-empty' }, roles.length === 0 ? t('roleEmpty') : t('roleNoMatch'))
            : h('div', { className: 'tx-roleGrid' }, roleCards),
        ),

        h('div', { className: 'tx-editor' },
        // 选中角色详情
        activeRole === null
          ? h('p', { className: 'tx-hint' }, t('editHint'))
          : h(
              'section',
              { className: 'tx-section tx-policyCard' },
              h(
                'div',
                { className: 'tx-detailHead' },
                h('div', { className: 'tx-roleIdentity' },
                  h('h3', { className: 'tx-sectionTitle', title: activeName }, activeName),
                  h('code', { className: 'tx-roleId', title: activeRole.id }, activeRole.id)),
                h(
                  'span',
                  { className: 'tx-detailActions' },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'tx-btn tx-btnSm',
                      'data-unavailable': !activeView.configured || undefined,
                      disabled: locked || !activeView.configured,
                      title: t('roleResetHint'),
                      onClick: () => resetRole(activeRole.id),
                    },
                    t('roleReset'),
                  ),
                ),
              ),

              h('p', { className: 'tx-roleSummary', title: activeRole.displayDescription || undefined },
                activeRole.displayDescription || t('roleNoDescription')),

              h('div', { className: 'tx-stats' },
                h('div', { className: 'tx-stat', 'data-tone': 'visible' },
                  h('span', { className: 'tx-statValue' }, String(activeView.visibleList.length)),
                  h('span', { className: 'tx-statLabel' }, t('statVisible'))),
                h('div', { className: 'tx-stat', 'data-tone': 'hidden' },
                  h('span', { className: 'tx-statValue' }, String(activeView.hiddenList.length)),
                  h('span', { className: 'tx-statLabel' }, t('statHidden'))),
                h('div', { className: 'tx-stat' },
                  h('span', { className: 'tx-statValue' }, String(view.index.groups.length)),
                  h('span', { className: 'tx-statLabel' }, t('statGroups'))),
              ),

              // 基线
              h(
                'div',
                { className: 'tx-row' },
                h(
                  'div',
                  { className: 'tx-rowText' },
                  h('div', { className: 'tx-rowTitle' }, t('baselineTitle')),
                  h(
                    'div',
                    { className: 'tx-rowDesc' },
                    activeMode === 'allow' ? t('baselineDescAllow') : t('baselineDescOpen'),
                  ),
                ),
                h(Segmented, {
                  value: activeMode,
                  disabled: locked,
                  ariaLabel: t('baselineTitle'),
                  options: [
                    { value: 'open', label: t('modeOpen') },
                    { value: 'allow', label: t('modeAllow') },
                  ],
                  onChange: (value) => changeMode(activeRole.id, value),
                }),
              ),

              // 工具组
              h('div', { className: 'tx-subHead' }, t('groupsTitle')),
              h('div', { className: 'tx-toolControls' },
                h('label', { className: 'tx-search' }, h(Icon, { kind: 'search' }),
                  h('input', { type: 'search', value: toolQuery, placeholder: t('toolSearch'), 'aria-label': t('toolSearch'),
                    onChange: (event) => { setToolQuery(event.target.value); setFilteredExpanded({}); } })),
                h(Segmented, { value: visibility, ariaLabel: t('filterLabel'), options: [
                  { value: 'all', label: t('filterAll') },
                  { value: 'visible', label: t('filterVisible') },
                  { value: 'hidden', label: t('filterHidden') },
                ], onChange: (value) => { setVisibility(value); setFilteredExpanded({}); } }),
                h('div', { className: 'tx-expandActions' },
                  h('div', { className: 'tx-matchSummary' },
                    h('span', { className: 'tx-sectionMeta', role: 'status' },
                      fill(t(filterActive ? 'matchCount' : 'toolCount'), { count: String(matchingCount) })),
                    filterActive && matchingCount > 0
                      ? h('details', {
                          className: 'tx-filterHelp',
                          onBlur: (event) => {
                            if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false;
                          },
                        },
                        h('summary', { title: t('filterHint'), 'aria-label': t('filterHint') },
                          h(Icon, { kind: 'info' }),
                          h('span', { className: 'tx-filterHint', 'aria-hidden': true }, t('filterHint'))),
                        h('span', { className: 'tx-filterPopover' }, t('filterHint')))
                      : null),
                  h('button', { type: 'button', className: 'tx-btn tx-btnSm', disabled: !hasCollapsedGroup, onClick: () =>
                    setShownExpansion(Object.fromEntries(expandableGroups.map((group) => [group.id, true]))) }, t('expandAll')),
                  h('button', { type: 'button', className: 'tx-btn tx-btnSm', disabled: !hasOpenGroup, onClick: () =>
                    setShownExpansion(Object.fromEntries(filteredGroups.map((group) => [group.id, false]))) }, t('collapseAll'))),
              ),
              !hasManageableTools ? h('p', { className: 'tx-empty' }, t('noGlobalTools')) : null,
              h('div', { className: 'tx-groups' }, groupRows),
              filterActive && hasManageableTools && filteredGroups.length === 0 ? h('div', { className: 'tx-emptyResults' },
                h(Icon, { kind: 'search' }), h('p', { className: 'tx-empty' }, t('noMatches')),
                h('button', { type: 'button', className: 'tx-btn tx-btnSm tx-btnOutline', onClick: () => {
                  setToolQuery(''); setVisibility('all'); setFilteredExpanded({});
                } }, t('clearFilters'))) : null,

              // 最终可见清单
              h(
                'button',
                {
                  type: 'button',
                  className: 'tx-disclosure',
                  'aria-expanded': showEffective,
                  onClick: () => setShowEffective(!showEffective),
                },
                h(Chevron, { open: showEffective }),
                t('effectiveTitle'),
              ),
              showEffective
                ? h(
                    'div',
                    { className: 'tx-effective' },
                    h(
                      'div',
                      { className: 'tx-effectiveCol' },
                      h(
                        'div',
                        { className: 'tx-effectiveHead' },
                        fill(t('effectiveVisible'), { count: String(activeView.visibleList.length) }),
                      ),
                      activeView.visibleList.length === 0
                        ? h('span', { className: 'tx-hint' }, t('effectiveNone'))
                        : h(
                            'ul',
                            { className: 'tx-chips' },
                            activeView.visibleList.map((name) => h('li', { key: `on-${name}`, className: 'tx-chip' }, name)),
                          ),
                    ),
                    h(
                      'div',
                      { className: 'tx-effectiveCol' },
                      h(
                        'div',
                        { className: 'tx-effectiveHead' },
                        fill(t('effectiveHidden'), { count: String(activeView.hiddenList.length) }),
                      ),
                      activeView.hiddenList.length === 0
                        ? h('span', { className: 'tx-hint' }, t('effectiveNone'))
                        : h(
                            'ul',
                            { className: 'tx-chips' },
                            activeView.hiddenList.map((name) =>
                              h('li', { key: `off-${name}`, className: 'tx-chip tx-chipOff' }, name),
                            ),
                          ),
                    ),
                  )
                : null,
            ),

        // 未归组
        !draft.discovery || ungrouped.length > 0 ? h(
          'section',
          { className: 'tx-section' },
          h(
            'div',
            { className: 'tx-sectionHead' },
            h('h3', { className: 'tx-sectionTitle' }, t('ungroupedTitle')),
            h('span', { className: 'tx-sectionMeta' }, `${ungrouped.length}`),
          ),
          h('p', { className: 'tx-sectionIntro' }, t('ungroupedHint')),
          ungrouped.length === 0
            ? h('p', { className: 'tx-empty' }, t('ungroupedEmpty'))
            : h(
                'ul',
                { className: 'tx-chips' },
                ungrouped.map((name) =>
                  h('li', { key: name, className: 'tx-chip', title: view.descriptions.get(name) || undefined }, name),
                ),
              ),
        ) : null,

        h('details', { className: 'tx-advanced' },
          h('summary', { className: 'tx-advancedSummary' }, h(Chevron), t('advanced')),
        // 全局
        h(
          'section',
          { className: 'tx-section' },
          h('div', { className: 'tx-sectionHead' }, h('h3', { className: 'tx-sectionTitle' }, t('globalTitle'))),
          h(
            'div',
            { className: 'tx-row' },
            h('div', { className: 'tx-rowText' },
              h('div', { className: 'tx-rowTitle' }, t('discoveryTitle')),
              h('div', { className: 'tx-rowDesc' }, t('discoveryHint')),
            ),
            h(Switch, {
              checked: draft.discovery,
              disabled: locked,
              label: t('discoveryTitle'),
              onChange: () => updateDraft((current) => ({ ...current, discovery: !current.discovery })),
            }),
          ),
          h(
            'div',
            { className: 'tx-row' },
            h(
              'div',
              { className: 'tx-rowText' },
              h('div', { className: 'tx-rowTitle' }, t('unlistedLabel')),
              h('div', { className: 'tx-rowDesc' }, t('unlistedHint')),
            ),
            h(Segmented, {
              value: draft.unlisted,
              disabled: locked,
              ariaLabel: t('unlistedLabel'),
              options: [
                { value: 'open', label: t('unlistedOpen') },
                { value: 'closed', label: t('unlistedClosed') },
              ],
              onChange: changeUnlisted,
            }),
          ),
        ),

        // 管理工具组
        h(
          'section',
          { className: 'tx-section' },
          h(
            'button',
            {
              type: 'button',
              className: 'tx-disclosure',
              'aria-expanded': manageOpen,
              onClick: () => setManageOpen(!manageOpen),
            },
            h(Chevron, { open: manageOpen }),
            t('manageTitle'),
            h('span', { className: 'tx-sectionMeta' }, `${Object.keys(draft.sources).length}`),
          ),
          manageOpen
            ? h(
                'div',
                { className: 'tx-manage' },
                h('p', { className: 'tx-sectionIntro' }, t('manageHint')),
                Object.keys(draft.sources).length === 0 ? h('p', { className: 'tx-empty' }, t('manageEmpty')) : null,
                Object.keys(draft.sources).map((id) => {
                  const source = draft.sources[id];
                  const info = view.index.groups.find((group) => group.id === id);
                  return h(
                    'div',
                    { key: `src-${id}`, className: 'tx-manageRow' },
                    renameForm !== null && renameForm.id === id
                      ? h(
                          'span',
                          { className: 'tx-rename' },
                          h('input', {
                            className: 'tx-input tx-renameInput',
                            type: 'text',
                            value: renameForm.value,
                            spellCheck: false,
                            disabled: locked,
                            'aria-label': t('manageRename'),
                            onChange: (event) => setRenameForm({ id, value: event.target.value }),
                            onKeyDown: (event) => {
                              if (event.key === 'Enter') commitRename();
                              if (event.key === 'Escape') setRenameForm(null);
                            },
                          }),
                          h(
                            'button',
                            { type: 'button', className: 'tx-btn tx-btnSm tx-btnPrimary', disabled: locked, onClick: commitRename },
                            t('manageRenameConfirm'),
                          ),
                          h(
                            'button',
                            { type: 'button', className: 'tx-btn tx-btnSm', disabled: locked, onClick: () => setRenameForm(null) },
                            t('manageRenameCancel'),
                          ),
                        )
                      : h('code', { className: 'tx-groupId', title: id }, id),
                    h(
                      'label',
                      { className: 'tx-field' },
                      h('span', { className: 'tx-fieldLabel' }, t('manageLabel')),
                      h('input', {
                        className: 'tx-input',
                        type: 'text',
                        value: groupLabel(id, source.label),
                        spellCheck: false,
                        disabled: locked,
                        placeholder: id,
                        onChange: (event) => changeSource(id, { label: event.target.value }),
                      }),
                    ),
                    h(
                      'label',
                      { className: 'tx-field' },
                      h('span', { className: 'tx-fieldLabel' }, t('manageMatch')),
                      h('input', {
                        className: 'tx-input',
                        type: 'text',
                        value: source.match,
                        spellCheck: false,
                        disabled: locked,
                        maxLength: 1024,
                        placeholder: t('manageMatchHint'),
                        onChange: (event) => changeSource(id, { match: event.target.value }),
                      }),
                    ),
                    h(
                      'span',
                      { className: 'tx-manageFoot' },
                      h('span', { className: 'tx-sectionMeta' }, fill(t('groupTools'), { count: String(info === undefined ? 0 : info.tools.length) })),
                      h(
                        'button',
                        { type: 'button', className: 'tx-btn tx-btnSm', disabled: locked, onClick: () => setRenameForm({ id, value: id }) },
                        t('manageRename'),
                      ),
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'tx-btn tx-btnSm tx-btnDanger',
                          disabled: locked,
                          'aria-label': fill(t('manageRemoveLabel'), { label: groupLabel(id, source.label) }),
                          onClick: () => removeSource(id),
                        },
                        t('manageRemove'),
                      ),
                    ),
                  );
                }),
                addForm === null
                  ? h(
                      'button',
                      {
                        type: 'button',
                        className: 'tx-btn tx-btnSm tx-btnOutline',
                        disabled: locked,
                        onClick: () => setAddForm({ id: '', label: '', match: '', idTouched: false }),
                      },
                      t('manageAdd'),
                    )
                  : h(
                      'form',
                      {
                        className: 'tx-addForm',
                        onSubmit: (event) => {
                          event.preventDefault();
                          if (addReady) addSource();
                        },
                      },
                      h('div', { className: 'tx-addTitle' }, t('manageAddTitle')),
                      h(
                        'div',
                        { className: 'tx-addGrid' },
                        h(
                          'label',
                          { className: 'tx-field' },
                          h('span', { className: 'tx-fieldLabel' }, t('manageId')),
                          h('input', {
                            className: 'tx-input',
                            type: 'text',
                            value: addForm.id,
                            spellCheck: false,
                            disabled: locked,
                            placeholder: 'my-group',
                            onChange: (event) => editAddForm('id', event.target.value),
                          }),
                        ),
                        h(
                          'label',
                          { className: 'tx-field' },
                          h('span', { className: 'tx-fieldLabel' }, t('manageLabel')),
                          h('input', {
                            className: 'tx-input',
                            type: 'text',
                            value: addForm.label,
                            spellCheck: false,
                            disabled: locked,
                            onChange: (event) => editAddForm('label', event.target.value),
                          }),
                        ),
                        h(
                          'label',
                          { className: 'tx-field' },
                          h('span', { className: 'tx-fieldLabel' }, t('manageMatch')),
                          h('input', {
                            className: 'tx-input',
                            type: 'text',
                            value: addForm.match,
                            spellCheck: false,
                            disabled: locked,
                            maxLength: 1024,
                            placeholder: t('manageMatchHint'),
                            onChange: (event) => editAddForm('match', event.target.value),
                          }),
                        ),
                      ),
                      addHint !== '' ? h('p', { className: 'tx-hint tx-warnInline' }, addHint) : null,
                      h(
                        'div',
                        { className: 'tx-addActions' },
                        h(
                          'button',
                          { type: 'submit', className: 'tx-btn tx-btnSm tx-btnPrimary', disabled: locked || !addReady },
                          t('manageAddConfirm'),
                        ),
                        h(
                          'button',
                          { type: 'button', className: 'tx-btn tx-btnSm', disabled: locked, onClick: () => setAddForm(null) },
                          t('manageCancel'),
                        ),
                      ),
                    ),
              )
            : null,
        ),

        // 解除现有会话
        h(
          'section',
          { className: 'tx-section tx-sectionLast' },
          liftConfirm
            ? h(
                'div',
                { className: 'tx-row' },
                h('div', { className: 'tx-rowText' }, h('div', { className: 'tx-rowTitle' }, t('liftConfirm'))),
                h(
                  'span',
                  { className: 'tx-rowActions' },
                  h(
                    'button',
                    { type: 'button', className: 'tx-btn tx-btnSm tx-btnDanger', disabled: locked, onClick: () => void liftSessions() },
                    busy === 'lift' ? t('lifting') : t('liftYes'),
                  ),
                  h('button', { type: 'button', className: 'tx-btn tx-btnSm', onClick: () => setLiftConfirm(false) }, t('liftNo')),
                ),
              )
            : h(
                'div',
                { className: 'tx-row' },
                h(
                  'div',
                  { className: 'tx-rowText' },
                  h('div', { className: 'tx-rowTitle' }, t('lift')),
                  h('div', { className: 'tx-rowDesc' }, t('liftDesc')),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'tx-btn tx-btnSm',
                    disabled: locked,
                    onClick: () => setLiftConfirm(true),
                  },
                  t('lift'),
                ),
              ),
        ),
        ),
        ),
        ),
      ), header);
    }

    /* ------------------------------------------------------------------ */
    /* 样式（全部走 --dsw-* token，前缀 tx-）                               */
    /* 尺寸来源：DSH dsh-v0.2.2-rc.3，PluginManagerPage.module.css、          */
    /* TaskManagerPage.module.css、ui-primitives/{Button,SegmentedTabs,       */
    /* Switch,Tag}.module.css。Windows 顶栏的留白由 AppFrame 负责。          */
    /* ------------------------------------------------------------------ */

    const CSS = `
.tx-shell{--tx-page-inset:clamp(24px,4vw,48px);--tx-content-width:960px;box-sizing:border-box;position:relative;container:tool-exposure / inline-size;width:100%;height:100%;min-width:0;min-height:0;display:flex;flex-direction:column;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);font-size:14px;line-height:22px}
.tx-topbar{box-sizing:border-box;display:flex;align-items:center;gap:12px;flex:none;width:100%;max-width:calc(var(--tx-content-width) + 2 * var(--tx-page-inset));margin-inline:auto;min-height:40px;padding:10px var(--tx-page-inset) 0}
.tx-back{color:var(--dsw-alias-label-secondary);margin-inline-start:-8px}
.tx-draftHint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.tx-feedback {
  position: absolute;
  z-index: 2;
  inset-inline: 16px;
  inset-block-end: max(16px, env(safe-area-inset-bottom));
  display: flex;
  justify-content: center;
  pointer-events: none;
}
.tx-srOnly {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
.tx-page{box-sizing:border-box;width:100%;min-width:0;min-height:0;flex:1;overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable;padding:32px var(--tx-page-inset) 48px;display:flex;flex-direction:column;align-items:center;gap:32px}
.tx-page>*{flex:none;width:100%;max-width:var(--tx-content-width)}
.tx-workspace{display:grid;grid-template-columns:224px minmax(0,1fr);gap:40px;align-items:start;width:100%;min-width:0}
.tx-rolePanel{position:sticky;top:0;box-sizing:border-box;max-height:calc(100dvh - 200px);overflow:hidden;gap:16px;padding:0}
.tx-editor{display:flex;flex-direction:column;gap:32px;min-width:0}
.tx-policyCard{box-sizing:border-box;padding:0;gap:16px}
.tx-icon{flex:none;display:block}
.tx-search{box-sizing:border-box;display:flex;flex:none;align-items:center;gap:8px;min-width:0;height:36px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:12px;background:transparent;color:var(--dsw-alias-label-tertiary);transition:border-color .15s}
.tx-search:focus-within{border-color:var(--dsw-alias-state-business-primary)}
.tx-search>.tx-icon{width:14px;height:14px}
.tx-search input{font:inherit;font-size:14px;line-height:22px;min-width:0;width:100%;height:100%;padding:0;border:0;outline:none;background:transparent;color:var(--dsw-alias-label-primary)}
.tx-search input::placeholder{color:var(--dsw-alias-label-caption)}
.tx-stats{display:flex;flex-wrap:wrap;align-items:center;gap:8px 24px}
.tx-stat{display:flex;align-items:baseline;gap:6px;min-width:0}
.tx-statValue{font-size:13px;font-weight:500;line-height:20px;font-variant-numeric:tabular-nums}
.tx-statLabel{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.tx-toolControls{display:grid;grid-template-columns:minmax(160px,1fr) auto;gap:10px;align-items:center}
.tx-expandActions{position:relative;grid-column:1/-1;display:flex;align-items:center;gap:4px;flex-wrap:wrap}
.tx-matchSummary{display:flex;align-items:center;gap:10px;flex:1 1 8rem;min-width:0;white-space:nowrap}
.tx-matchSummary>.tx-sectionMeta{flex:none}
.tx-filterHelp{min-width:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.tx-filterHelp>summary{display:flex;align-items:center;gap:4px;min-height:24px;padding-inline:4px;border-radius:var(--dsw-radius-sm);list-style:none;cursor:pointer}
.tx-filterHelp>summary::-webkit-details-marker{display:none}
.tx-filterHelp>summary:hover{background:var(--dsw-alias-interactive-bg-hover)}
.tx-filterHelp>summary>.tx-icon{width:14px;height:14px}
.tx-filterHint{min-width:0;overflow:hidden;text-overflow:ellipsis}
.tx-filterPopover{position:absolute;z-index:1;inset-inline-start:0;inset-block-start:100%;box-sizing:border-box;max-width:100%;padding:6px 10px;border-radius:var(--dsw-radius-md);white-space:normal;color:var(--dsw-alias-toast-label);background:var(--dsw-alias-toast-bg);box-shadow:var(--dsw-shadow-lv3);pointer-events:none}
.tx-emptyResults{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;min-height:140px;padding:20px;color:var(--dsw-alias-label-tertiary)}
.tx-advanced{border-top:.5px solid var(--dsw-alias-border-l2);padding:0}
.tx-advancedSummary{display:flex;align-items:center;gap:8px;list-style:none;cursor:pointer;padding:20px 0;font-size:14px;font-weight:500}
.tx-advancedSummary::marker{content:''}
.tx-advanced[open]>.tx-advancedSummary{margin-bottom:4px}
.tx-advanced[open]>.tx-advancedSummary .tx-chevron{transform:rotate(90deg)}
.tx-advanced>.tx-section{margin-bottom:18px}
.tx-state{color:var(--dsw-alias-label-tertiary);margin:0;padding:24px 0}
.tx-head{box-sizing:border-box;display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:start;gap:16px;flex:none;width:100%;max-width:calc(var(--tx-content-width) + 2 * var(--tx-page-inset));margin-inline:auto;padding:28px var(--tx-page-inset) 0}
.tx-headText{min-width:0;display:flex;flex-direction:column;gap:4px}
.tx-title{margin:0;font-size:20px;font-weight:500;line-height:28px}
.tx-intro{margin:0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tx-intro[data-state=dirty]{color:var(--dsw-alias-state-warn-label,var(--dsw-alias-state-warn-primary))}
.tx-toolbar{display:flex;align-items:center;gap:8px 16px;flex-wrap:wrap;justify-content:flex-end;min-width:0;white-space:nowrap}
.tx-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;height:32px;padding:0 12px;border:none;border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;cursor:pointer}
.tx-toolbar .tx-btn>.tx-icon{width:13px;height:13px}
.tx-toolbar .tx-btn[aria-busy=true]>.tx-icon{animation:tx-spin .85s linear infinite}
.tx-btn:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active)}
.tx-btn:disabled{opacity:.4;cursor:not-allowed}
.tx-btn:focus-visible,.tx-segBtn:focus-visible,.tx-switch:focus-visible,.tx-roleCard:focus-visible,.tx-groupMain:focus-visible,.tx-disclosure:focus-visible,.tx-advancedSummary:focus-visible,.tx-noticeDismiss:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.tx-btnSm{height:28px;padding:0 10px;font-size:12px;line-height:18px;border-radius:var(--dsw-radius-sm)}
.tx-btnPrimary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.tx-btnOutline{border:.5px solid transparent;box-shadow:inset 0 0 0 var(--dsh-hairline-width,.5px) var(--dsh-button-outline-color,var(--dsw-alias-border-l3))}
.tx-btnDanger{color:var(--dsw-alias-state-error-primary)}
.tx-notice {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  max-width: min(100%, 28rem);
  padding: 8px 12px;
  border-radius: var(--dsw-radius-lg);
  color: var(--dsw-alias-toast-label);
  background: var(--dsw-alias-toast-bg);
  box-shadow: var(--dsw-shadow-lv3);
  font-size: 13px;
  line-height: 20px;
  animation: tx-notice-in 150ms ease-out;
}
.tx-notice>.tx-icon{width:16px;height:16px}
.tx-notice[data-tone=ok]>.tx-icon{color:var(--dsw-alias-state-success-primary)}
.tx-notice[data-tone=error]>.tx-icon{color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 55%,currentColor)}
.tx-noticeText{min-width:0;overflow-wrap:anywhere;max-height:min(8rem,30dvh);overflow:auto}
.tx-notice[data-tone=error]>.tx-noticeText{pointer-events:auto}
.tx-noticeDismiss{display:grid;place-items:center;flex:none;width:24px;height:24px;padding:0;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:inherit;cursor:pointer;pointer-events:auto}
.tx-noticeDismiss:hover{background:color-mix(in srgb,currentColor 16%,transparent)}
.tx-noticeDismiss>.tx-icon{width:14px;height:14px}
@keyframes tx-notice-in{from{opacity:0;transform:translateY(4px)}}
@keyframes tx-spin{to{transform:rotate(1turn)}}
.tx-hint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.tx-empty{margin:0;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}
.tx-warnCard{border-radius:var(--dsw-radius-md);background:var(--dsw-alias-state-warn-tertiary);padding:10px 12px;display:flex;flex-direction:column;gap:4px}
.tx-warnTitle{color:var(--dsw-alias-state-warn-label,var(--dsw-alias-state-warn-primary));font-size:12px;font-weight:600;line-height:18px}
.tx-warnList{margin:0;padding-left:16px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.tx-section{display:flex;flex-direction:column;gap:10px;min-width:0}
.tx-sectionLast{padding-top:4px}
.tx-sectionHead{display:flex;align-items:center;gap:8px}
.tx-sectionTitle{margin:0;font-size:14px;font-weight:500;line-height:22px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tx-sectionMeta{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.tx-sectionIntro{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.tx-detailHead{display:flex;align-items:center;justify-content:space-between;gap:8px}
.tx-roleIdentity{display:flex;align-items:center;gap:10px;min-width:0;flex-wrap:wrap}
.tx-roleIdentity>.tx-sectionTitle{font-size:14px;line-height:20px}
.tx-roleSummary,.tx-roleDesc{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tx-roleSummary{margin:-8px 0 0}
.tx-roleId{font-family:var(--ds-font-family-code,ui-monospace,Consolas,monospace);font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
.tx-detailActions{display:flex;align-items:center;gap:8px;flex:none}
.tx-detailActions>[data-unavailable=true]{visibility:hidden}
.tx-subHead{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:22px;margin-top:8px}
.tx-roleGrid {
  /* Keep an 8px drag target around a 4px visible thumb. */
  --dsh-scrollbar-width: 8px;
  --dsh-scrollbar-thumb-border: 2px;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 4px;
  min-height: 0;
  overflow: auto;
  padding: 2px;
}
@media (hover: hover) and (pointer: fine) and (forced-colors: none) {
  .tx-roleGrid:not(:hover):not(:has(:focus-visible)) {
    --dsh-scrollbar-thumb: transparent;
  }
}
.tx-roleCard{appearance:none;font:inherit;text-align:left;cursor:pointer;display:flex;flex-direction:column;gap:5px;min-width:0;padding:12px;border:0;border-radius:var(--dsw-radius-lg,10px);background:transparent;color:var(--dsw-alias-label-primary)}
.tx-roleCard[data-active=true]{background:var(--dsw-alias-bg-module-platform,var(--dsw-alias-bg-layer-2))}
.tx-roleHead{display:flex;align-items:center;gap:6px;min-width:0;flex-wrap:wrap}
.tx-roleName{font-size:14px;font-weight:500;line-height:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.tx-roleMeta{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;margin-top:2px}
.tx-tag{display:inline-flex;align-items:center;flex:none;border-radius:999px;corner-shape:round;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:500;line-height:17px;padding:1px 8px;white-space:nowrap}
.tx-tagDanger{background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent);color:var(--dsw-alias-label-error,var(--dsw-alias-state-error-primary))}
.tx-row{display:flex;align-items:center;justify-content:space-between;gap:24px;padding:20px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.tx-rowText{min-width:0;display:flex;flex-direction:column;gap:4px}
.tx-rowTitle{font-size:14px;line-height:20px}
.tx-rowDesc{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.tx-rowActions{display:flex;align-items:center;gap:8px;flex:none}
.tx-seg{position:relative;display:grid;padding:2px;border:0;border-radius:calc(var(--dsw-radius-md) + 2px);background:var(--dsw-alias-bg-module-platform);flex:none;min-width:0}
.tx-segIndicator{position:absolute;inset:2px auto 2px 2px;box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3);transition:transform 180ms ease;pointer-events:none}
.tx-segBtn{appearance:none;position:relative;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;font:inherit;font-size:14px;font-weight:400;line-height:20px;height:30px;padding:0 12px;border:0;border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap;transition:color 180ms ease}
.tx-segBtn[data-active=true]{color:var(--dsw-alias-label-primary);font-weight:500}
.tx-segBtn:disabled{opacity:.5;cursor:default}
.tx-groups{display:flex;flex-direction:column;gap:2px;min-width:0}
.tx-toolGroup{min-width:0}
.tx-groupRow{display:flex;align-items:center;gap:12px;padding:0 8px;margin-inline:-8px;min-width:0;border-radius:var(--dsw-radius-xl)}
.tx-groupIcon{display:grid;place-items:center;flex:none;box-sizing:content-box;width:48px;height:48px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg);color:var(--dsw-alias-label-secondary)}
.tx-groupIcon>.tx-icon{width:22px;height:22px}
.tx-pluginImage{display:block;object-fit:contain;border-radius:var(--dsw-radius-sm)}
.tx-pluginImage[hidden]{display:none}
.tx-groupIcon>.tx-icon,.tx-groupIcon>.tx-pluginImage{grid-area:1/1}
.tx-groupIcon>.tx-pluginImage{width:75%;height:75%}
.tx-groupIcon:has(>.tx-pluginImage:not([hidden]))>.tx-icon{visibility:hidden}
.tx-toolGroup[data-kind=official] .tx-groupIcon{color:var(--dsw-alias-state-business-primary)}
.tx-groupMain{appearance:none;font:inherit;text-align:left;cursor:pointer;display:flex;align-items:center;gap:14px;min-width:0;flex:1;padding:8px 0;background:transparent;border:none;color:var(--dsw-alias-label-primary);border-radius:var(--dsw-radius-sm)}
.tx-chevron{flex:none;color:var(--dsw-alias-label-tertiary);transition:transform .16s}
.tx-chevron[data-open=true]{transform:rotate(90deg)}
.tx-groupText{display:flex;flex-direction:column;gap:4px;min-width:0;flex:1}
.tx-groupName{font-size:14px;line-height:20px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tx-groupMeta{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:18px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tx-groupSource{min-width:0;overflow:hidden;text-overflow:ellipsis}
.tx-groupCount,.tx-dot{flex:none}
.tx-dot{opacity:.6}
.tx-warnInline{color:var(--dsw-alias-state-warn-label,var(--dsw-alias-state-warn-primary))}
.tx-groupEnd{display:flex;align-items:center;gap:10px;flex:none}
.tx-groupState{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;white-space:nowrap}
.tx-groupState[data-state=partial]{color:var(--dsw-alias-state-warn-label,var(--dsw-alias-state-warn-primary))}
.tx-groupState[data-state=all]{color:var(--dsw-alias-label-secondary)}
.tx-toolList{display:flex;flex-direction:column;margin:0 0 8px 63px}
.tx-toolRow{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 0;border-top:.5px solid var(--dsw-alias-border-l2)}
.tx-toolRow:first-child{border-top:none}
.tx-toolText{display:flex;flex-direction:column;gap:1px;min-width:0}
.tx-toolName{font-family:var(--ds-font-family-code);font-size:12px;line-height:19px;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.tx-toolDesc{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
.tx-toolProvider{display:flex;align-items:center;gap:5px;min-width:0}
.tx-toolProvider>.tx-pluginImage{width:14px;height:14px;flex:none;border-radius:3px}
.tx-toolProvider>.tx-toolDesc{display:block;white-space:nowrap;text-overflow:ellipsis}
.tx-toolEmpty{padding:10px 0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.tx-switch{box-sizing:border-box;position:relative;flex:0 0 auto;width:36px;height:20px;padding:2px;border:0;border-radius:999px;corner-shape:round;background:var(--dsw-alias-border-l3);cursor:pointer}
.tx-switch[aria-checked=true]{background:var(--dsw-alias-brand-primary)}
.tx-switch[data-mixed=true]{background:var(--dsw-alias-state-warn-primary)}
.tx-switch:disabled{cursor:default;opacity:.5}
.tx-switchThumb{display:block;width:16px;height:16px;border-radius:50%;corner-shape:round;background:var(--dsw-alias-label-primary-foreground);transition:transform 120ms ease}
.tx-switch[aria-checked=false] .tx-switchThumb{background:var(--dsw-alias-switch-thumb)}
.tx-switch[aria-checked=true] .tx-switchThumb{transform:translateX(16px)}
.tx-switch[data-mixed=true] .tx-switchThumb{transform:translateX(8px)}
.tx-disclosure{appearance:none;font:inherit;text-align:left;cursor:pointer;display:inline-flex;align-items:center;gap:6px;padding:0;border:none;background:transparent;color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:22px;align-self:flex-start}
.tx-disclosure:hover{color:var(--dsw-alias-brand-primary)}
.tx-disclosure:focus-visible{outline-offset:3px}
.tx-effective{display:grid;grid-template-columns:1fr 1fr;gap:16px;padding:8px 0}
.tx-effectiveCol{display:flex;flex-direction:column;gap:6px;min-width:0}
.tx-effectiveHead{color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500;line-height:18px}
.tx-chips{display:flex;flex-wrap:wrap;gap:4px;margin:0;padding:0;list-style:none}
.tx-chip{border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);font-family:var(--ds-font-family-code);font-size:11px;line-height:18px;padding:0 7px;overflow-wrap:anywhere}
.tx-chipOff{opacity:.6;text-decoration:line-through}
.tx-manage{display:flex;flex-direction:column;gap:16px;padding:0}
.tx-manageRow{display:grid;grid-template-columns:auto minmax(0,1fr) minmax(0,1.4fr) auto;gap:10px;align-items:end;padding-top:10px;border-top:.5px solid var(--dsw-alias-border-l1)}
.tx-manageRow:first-of-type{border-top:none;padding-top:0}
.tx-groupId{color:var(--dsw-alias-label-tertiary);font-family:var(--ds-font-family-code);font-size:11px;line-height:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:110px}
.tx-rename{display:flex;align-items:center;gap:4px;min-width:0}
.tx-renameInput{width:110px}
.tx-field{display:flex;flex-direction:column;gap:4px;min-width:0}
.tx-fieldLabel{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px}
.tx-input{box-sizing:border-box;width:100%;min-width:0;height:32px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;outline:none}
.tx-input:focus{border-color:var(--dsw-alias-state-business-primary);box-shadow:inset 0 0 0 .5px var(--dsw-alias-state-business-primary)}
.tx-input:disabled{opacity:.6}
.tx-manageFoot{display:flex;align-items:center;gap:8px;justify-content:flex-end}
.tx-addForm{display:flex;flex-direction:column;gap:12px;padding:16px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2)}
.tx-addTitle{color:var(--dsw-alias-label-primary);font-size:12px;font-weight:500;line-height:18px}
.tx-addGrid{display:grid;grid-template-columns:minmax(0,.8fr) minmax(0,1fr) minmax(0,1.4fr);gap:10px}
.tx-addActions{display:flex;gap:8px}
.tx-errorCard{border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg,10px);background:var(--dsw-alias-bg-layer-1);padding:16px;display:flex;flex-direction:column;gap:8px;align-items:flex-start}
.tx-errorTitle{font-size:14px;font-weight:500;line-height:20px;color:var(--dsw-alias-state-error-primary)}
.tx-errorText{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.tx-errorHint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
@container tool-exposure (max-width:980px){.tx-workspace{grid-template-columns:minmax(0,1fr);gap:28px}.tx-rolePanel{position:static;max-height:none}.tx-roleGrid{display:flex;overflow-x:auto;scroll-snap-type:x proximity;padding-bottom:6px}.tx-roleCard{flex:0 0 224px;scroll-snap-align:start}}
html[data-platform=darwin] .tx-head{padding-top:calc(28px + var(--dsh-frame-top-clearance,0px))}
html[data-platform=darwin] .tx-topbar{padding-top:calc(10px + var(--dsh-frame-top-clearance,0px))}
@media (max-width:767px){.tx-shell{--tx-page-inset:20px}}
@container tool-exposure (max-width:620px){.tx-filterHint{display:none}}
@container tool-exposure (max-width:620px){.tx-head{grid-template-columns:minmax(0,1fr);padding-bottom:24px}.tx-page{padding-top:0}.tx-workspace{gap:24px}.tx-roleCard{flex-basis:208px}.tx-roleIdentity{gap:4px 10px}.tx-stats{gap:6px 16px}.tx-toolControls{grid-template-columns:minmax(0,1fr)}.tx-toolControls>.tx-seg{justify-content:stretch}.tx-toolControls .tx-segBtn{flex:1}.tx-row{align-items:flex-start;flex-wrap:wrap;gap:12px}.tx-detailHead{flex-wrap:wrap}.tx-groupEnd{gap:6px}.tx-groupState{display:none}.tx-groupRow{gap:8px}.tx-groupIcon{width:36px;height:36px}.tx-groupIcon>.tx-icon{width:18px;height:18px}.tx-groupMain{gap:12px}.tx-groupMeta{font-size:11px;gap:4px}.tx-toolList{margin-inline-start:48px}.tx-draftHint{display:none}.tx-effective{grid-template-columns:1fr}.tx-manageRow,.tx-addGrid{grid-template-columns:1fr}.tx-manageFoot{justify-content:flex-start}.tx-rename{flex-wrap:wrap}.tx-chip{max-width:100%;box-sizing:border-box}}
@media (hover:hover){.tx-btn:hover:not(:disabled),.tx-groupRow:hover,.tx-roleCard:hover:not([data-active=true]){background:var(--dsw-alias-interactive-bg-hover)}.tx-btnPrimary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}.tx-segBtn:hover:not(:disabled){color:var(--dsw-alias-label-primary)}.tx-search:hover:not(:focus-within){border-color:var(--dsw-alias-border-l2)}}
@media (pointer:coarse){.tx-search input,.tx-input{font-size:16px}.tx-btn{min-height:38px}}
@media (prefers-reduced-motion:reduce){.tx-roleCard,.tx-chevron,.tx-switchThumb,.tx-segIndicator,.tx-segBtn{transition:none}.tx-notice,.tx-toolbar .tx-btn[aria-busy=true]>.tx-icon{animation:none}}
`;

    /* ------------------------------------------------------------------ */
    /* 插件入口                                                             */
    /* ------------------------------------------------------------------ */

    function apply(ctx) {
      if (typeof ctx.locale?.register === 'function') {
        ctx.effect(() => ctx.locale.register(NS, { en: DICT.en, zh: DICT.zh }), 'tool-exposure: dictionaries');
      }
      let bound = null;
      if (typeof ctx.locale?.bind === 'function') {
        try {
          bound = ctx.locale.bind(NS);
        } catch {
          bound = null;
        }
      }
      translateFn = makeTranslate(bound);
      try { presetTranslateFn = ctx.locale?.bind?.('settings.agentPreset') || null; }
      catch { presetTranslateFn = null; }
      resolvePackageText = (text) => ctx.locale?.resolveText?.(text);

      ctx.effect(() => {
        const tag = document.createElement('style');
        tag.dataset.plugin = 'dsh-tool-exposure';
        tag.textContent = CSS;
        document.head.appendChild(tag);
        return () => {
          tag.remove();
        };
      }, 'tool-exposure: stylesheet');

      const memory = { snapshot: null, pendingSave: null, awaitingSnapshot: null };
      ctx.slots.inject('main', () =>
        ctx.slots.register(
          {
            name: 'main',
            key: PANEL_ID,
            locale: NS,
            inject: () => ({ memory, onReturn: () => ctx.layout.selectPanel(null) }),
          },
          ToolExposurePage,
        ),
      );
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist', id: PANEL_ID, order: 35, locale: NS, label: () => t('nav'),
      }, ToolExposureIcon));
      ctx.effect(() => {
        const beforeUnload = (event) => {
          if (!memory.snapshot?.dirty) return;
          event.preventDefault();
          event.returnValue = '';
        };
        window.addEventListener?.('beforeunload', beforeUnload);
        return () => window.removeEventListener?.('beforeunload', beforeUnload);
      }, 'tool-exposure: draft navigation');
      ctx.effect(() => () => {
        let layout;
        try { layout = typeof ctx.get === 'function' ? ctx.get('layout') : ctx.layout; }
        catch { return; /* The layout service already disposed. */ }
        if (layout?.panelInfo.getSnapshot().activePanelId === PANEL_ID) layout.selectPanel(null);
      }, 'tool-exposure: leave owned panel');
    }

    return {
      inject: ['slots', 'locale', 'layout'],
      apply,
    };
  },
});
