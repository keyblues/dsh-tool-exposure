/**
 * dsh-tool-exposure — Client half.
 *
 * Settings →「工具暴露」：按角色（agent preset）管理第三方插件工具的暴露面。
 *
 * 布局沿用 Host 自带设置页的设计语言（参照 ui-settings-general / ui-agent-preset /
 * ui-plugin-manager 的实测样式）：
 *   - 页面：标题 18/600 + 说明 13/tertiary，区块间距 20，行分隔用 .5px border-l2；
 *   - 角色用卡片网格（border .5 settings-card-stroke，radius-xl，选中 bg-module-platform）；
 *   - 开关 36×20、按钮 28/36 高、输入框 32 高，全部走 --dsw-* token。
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
    const NOTICE_TTL_MS = 6000;

    const DICT = {
      en: {
        nav: 'Tool Exposure',
        title: 'Tool Exposure',
        intro:
          'Choose which tools registered by third-party plugins each role (agent preset) can see. Saving is a snapshot: it applies to sessions created afterwards, while existing sessions keep the tool surface they were created with.',
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
        baselineTitle: 'Baseline',
        baselineDescOpen: 'Open by default: every managed tool is visible unless this role turns it off.',
        baselineDescAllow: 'Allow-list: no managed tool is visible unless this role turns it on.',
        modeOpen: 'Open by default',
        modeAllow: 'Allow-list',
        groupsTitle: 'Tool groups',
        groupTools: '{count} tools',
        groupPartial: 'partly visible',
        groupNoTools: 'no matching tools',
        expand: 'Expand',
        collapse: 'Collapse',
        toolVisible: 'visible',
        toolHidden: 'hidden',
        ungroupedTitle: 'Ungrouped tools',
        ungroupedHint: 'These global tools match no tool group, so this policy never touches them.',
        ungroupedEmpty: 'No ungrouped tool.',
        globalTitle: 'Global',
        unlistedLabel: 'Roles without their own entry',
        unlistedOpen: 'Unrestricted',
        unlistedClosed: 'No managed tools',
        unlistedHint: 'Applies to roles that have no entry of their own.',
        manageTitle: 'Manage tool groups',
        manageHint: 'A group matches tools by wildcard (* and ?). First matching group wins.',
        manageAdd: 'Add tool group',
        manageEmpty: 'No tool group yet.',
        manageLabel: 'Label',
        manageMatch: 'Match',
        manageMatchHint: 'fofa_*, hms_*',
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
        rescan: 'Rescan',
        rescanning: 'Scanning…',
        lift: 'Lift live sessions',
        lifting: 'Lifting…',
        liftConfirm: 'Lift every restriction this plugin applied to live sessions?',
        liftYes: 'Confirm',
        liftNo: 'Cancel',
        liftDone: 'Lifted the policy on {count} live session(s).',
        liftDesc: 'Only lifts the masks already applied to live sessions; the saved configuration is unchanged, and those sessions keep their current tool surface.',
        saved: 'Saved; new sessions pick it up.',
        unsaved: 'Unsaved changes',
        saveFailed: 'Save failed: {error}',
        saveFailedShort: 'Save failed',
        rescanFailed: 'Rescan failed: {error}',
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
          '按角色（agent preset）管理第三方插件注册工具的可见面。保存是快照：只对之后新建的会话生效，已有会话保持创建时的工具面。',
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
        baselineTitle: '基线',
        baselineDescOpen: '默认开放：受管工具默认全部可见，本角色只关掉不需要的。',
        baselineDescAllow: '白名单：受管工具默认全部隐藏，本角色只打开需要的。',
        modeOpen: '默认开放',
        modeAllow: '白名单',
        groupsTitle: '工具组',
        groupTools: '{count} 个工具',
        groupPartial: '部分可见',
        groupNoTools: '没有匹配到工具',
        expand: '展开',
        collapse: '收起',
        toolVisible: '可见',
        toolHidden: '隐藏',
        ungroupedTitle: '未归组工具',
        ungroupedHint: '这些全局工具没有被任何工具组匹配，不受本策略影响。',
        ungroupedEmpty: '没有未归组的工具。',
        globalTitle: '全局',
        unlistedLabel: '没有单独配置的角色',
        unlistedOpen: '不限制',
        unlistedClosed: '看不到受管工具',
        unlistedHint: '没有单独条目的角色继承此设置。',
        manageTitle: '管理工具组',
        manageHint: '工具组用通配符匹配工具名（* 与 ?），按顺序取第一个匹配的组。',
        manageAdd: '添加工具组',
        manageEmpty: '还没有工具组。',
        manageLabel: '名称',
        manageMatch: '匹配',
        manageMatchHint: 'fofa_*, hms_*',
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
        rescan: '重新扫描',
        rescanning: '扫描中…',
        lift: '解除现有会话策略',
        lifting: '解除中…',
        liftConfirm: '确定解除本插件在所有现有会话上注册的工具限制吗？',
        liftYes: '确认解除',
        liftNo: '取消',
        liftDone: '已解除 {count} 个现有会话上的策略。',
        liftDesc: '只解除已应用到现有会话上的掩码，不改变保存的配置；这些会话保持当前工具面。',
        saved: '已保存，新建会话生效。',
        unsaved: '有未保存的修改',
        saveFailed: '保存失败：{error}',
        saveFailedShort: '保存失败',
        rescanFailed: '重新扫描失败：{error}',
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

    function isObject(value) {
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    }

    function errorTextOf(error) {
      return error instanceof Error && error.message !== '' ? error.message : String(error);
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
        throw new Error(detail);
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
      return { unlisted: payload.unlisted === 'closed' ? 'closed' : 'open', sources, roles };
    }

    function buildLocalIndex(sources, names) {
      const groups = [];
      for (const id of Object.keys(sources)) {
        const source = sources[id];
        const match = splitMatch(source.match);
        groups.push({
          id,
          label: asText(source.label) === '' ? id : asText(source.label),
          match,
          matchers: match.map(globToRegExp),
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
        if (hit === null) ungrouped.push(name);
        else {
          hit.tools.push(name);
          owner.set(name, hit.id);
        }
      }
      const managed = names.filter((name) => owner.has(name));
      return { groups, owner, ungrouped, managed };
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
      for (const roleId of Object.keys(draft.roles)) {
        const role = draft.roles[roleId];
        if (!isObject(role) || role.configured !== true) continue;
        roles[roleId] = {
          mode: role.mode === 'allow' ? 'allow' : 'open',
          groups: copyOverrides(role.groups),
          tools: copyOverrides(role.tools),
        };
      }
      return { unlisted: draft.unlisted === 'closed' ? 'closed' : 'open', sources, roles };
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
    /* 基础控件（按 Host primitives 的实测样式实现）                        */
    /* ------------------------------------------------------------------ */

    /** 36×20 开关，对应 Host primitives 的 switch。 */
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

    /** 二选一分段控件（用于基线模式 / 未配置角色策略）。 */
    function Segmented(props) {
      return h(
        'div',
        { className: 'tx-seg', role: 'group', 'aria-label': props.ariaLabel },
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

    function Notice(props) {
      if (props.notice === null || props.notice === undefined) return null;
      const tone = props.notice.tone === 'error' ? 'error' : props.notice.tone === 'ok' ? 'ok' : 'info';
      return h(
        'div',
        { className: 'tx-notice', 'data-tone': tone, role: tone === 'error' ? 'alert' : 'status' },
        props.notice.text,
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

    /* ------------------------------------------------------------------ */
    /* 页面                                                                */
    /* ------------------------------------------------------------------ */

    function ToolExposurePage() {
      const [phase, setPhase] = React.useState('loading');
      const [inventory, setInventory] = React.useState(null);
      const [draft, setDraft] = React.useState(null);
      // 最近一次“已保存/已加载”的草稿快照，用于脏检测与放弃修改。
      // 保存成功后立即更新它：即使随后的重扫失败（Host 热重载窗口），界面也不该同时
      // 显示“已保存”和“有未保存的修改”。
      const [baseline, setBaseline] = React.useState(null);
      const [busy, setBusy] = React.useState('');
      const [notice, setNotice] = React.useState(null);
      const [errorText, setErrorText] = React.useState('');
      const [selectedRole, setSelectedRole] = React.useState('');
      const [expanded, setExpanded] = React.useState({});
      const [manageOpen, setManageOpen] = React.useState(false);
      const [addForm, setAddForm] = React.useState(null);
      const [liftConfirm, setLiftConfirm] = React.useState(false);
      const [showEffective, setShowEffective] = React.useState(false);
      const [renameForm, setRenameForm] = React.useState(null);
      const mounted = React.useRef(true);
      const seq = React.useRef(0);
      const draftRef = React.useRef(null);
      const savingRef = React.useRef(false);
      draftRef.current = draft;

      React.useEffect(() => {
        mounted.current = true;
        return () => {
          mounted.current = false;
          seq.current += 1;
        };
      }, []);

      const applyInventory = React.useCallback((payload) => {
        const nextDraft = draftFromInventory(payload);
        const roleIds = (Array.isArray(payload.roles) ? payload.roles : [])
          .filter((role) => isObject(role) && typeof role.id === 'string' && role.id !== '')
          .map((role) => role.id);
        setInventory(payload);
        setDraft(nextDraft);
        setBaseline(draftFromInventory(payload));
        setAddForm(null);
        setSelectedRole((current) => (roleIds.includes(current) ? current : roleIds[0] || ''));
        setPhase('ready');
        setErrorText('');
      }, []);

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
        void load();
      }, [load]);

      // 成功提示自动消失；错误保留到下一次操作。
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
        async (postedSnapshot) => {
          for (let attempt = 0; attempt < RESCAN_RETRIES + 1; attempt += 1) {
            await wait(attempt === 0 ? SAVE_RESCAN_DELAY_MS : RESCAN_RETRY_MS);
            if (!mounted.current) return;
            const token = ++seq.current;
            try {
              const payload = await requestJson(ROUTE_INVENTORY);
              if (!mounted.current || token !== seq.current) return;
              const serverSnapshot = stableSnapshot(serializeDraft(draftFromInventory(payload)));
              if (serverSnapshot !== postedSnapshot) continue;
              // 后台重扫期间用户又改了草稿：不能用服务端状态覆盖。
              if (draftRef.current === null || stableSnapshot(serializeDraft(draftRef.current)) !== postedSnapshot) return;
              applyInventory(payload);
              return;
            } catch {
              if (!mounted.current) return;
            }
          }
        },
        [applyInventory],
      );

      /* --------------------------- 草稿修改 --------------------------- */

      const updateDraft = (updater) => {
        setDraft((current) => {
          if (current === null) return current;
          const next = updater(current);
          return isObject(next) ? next : current;
        });
        setNotice((current) => (current !== null && current.tone === 'error' ? null : current));
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
        const label = source !== undefined && asText(source.label) !== '' ? asText(source.label) : id;
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
          // 删除工具组后，原本属于它的工具会变成「未归组」；顺手清掉这些工具上的
          // 单工具例外，避免留下指向未受管工具的死配置（Host 会对此发警告）。
          const remaining = Object.keys(sources).map((groupId) => ({
            id: groupId,
            matchers: splitMatch(sources[groupId].match).map(globToRegExp),
          }));
          const groupAfter = (name) => {
            for (const group of remaining) {
              if (group.matchers.some((matcher) => matcher.test(name))) return group.id;
            }
            return null;
          };
          const toolNames = (Array.isArray(inventory && inventory.tools) ? inventory.tools : [])
            .filter((tool) => isObject(tool) && typeof tool.name === 'string' && tool.name !== '')
            .map((tool) => tool.name);
          const roles = {};
          for (const roleId of Object.keys(current.roles)) {
            const role = current.roles[roleId];
            const groups = { ...role.groups };
            delete groups[id];
            const tools = { ...role.tools };
            for (const name of toolNames) {
              if (groupAfter(name) === null) delete tools[name];
            }
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
        updateDraft((current) => ({
          ...current,
          sources: { ...current.sources, [id]: { label: label === '' ? id : label, match: match.join(', ') } },
        }));
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
        setExpanded((current) => {
          const next = { ...current };
          if (next[groupId] === true) delete next[groupId];
          else next[groupId] = true;
          return next;
        });
      };

      /* --------------------------- 派生数据 --------------------------- */

      const view = React.useMemo(() => {
        if (inventory === null || draft === null) return null;
        const tools = (Array.isArray(inventory.tools) ? inventory.tools : []).filter(
          (tool) => isObject(tool) && typeof tool.name === 'string' && tool.name !== '',
        );
        const names = tools.map((tool) => tool.name);
        let index;
        try {
          index = buildLocalIndex(draft.sources, names);
        } catch {
          // 匹配器异常不应打崩整页：降级为空索引并让用户从管理面板修。
          index = { groups: [], owner: new Map(), ungrouped: [], managed: [], registered: new Set() };
        }
        const fallbackMode = draft.unlisted === 'closed' ? 'allow' : 'open';
        const roleViews = {};
        for (const role of Array.isArray(inventory.roles) ? inventory.roles : []) {
          if (!isObject(role) || typeof role.id !== 'string' || role.id === '') continue;
          const stored = draft.roles[role.id];
          const configured = isObject(stored) && stored.configured === true;
          const mode = configured ? (stored.mode === 'allow' ? 'allow' : 'open') : fallbackMode;
          const overrides = configured ? stored : { groups: {}, tools: {} };
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
            mode,
            configured,
            visible,
            visibleList: index.managed.filter((name) => visible.has(name)),
            hiddenList: index.managed.filter((name) => !visible.has(name)),
            groupState,
          };
        }
        const descriptions = new Map();
        for (const tool of tools) descriptions.set(tool.name, typeof tool.description === 'string' ? tool.description : '');
        return { index, roles: roleViews, descriptions };
      }, [inventory, draft]);

      const draftSnapshot = React.useMemo(() => (draft === null ? '' : stableSnapshot(draft)), [draft]);
      const baselineSnapshot = React.useMemo(() => (baseline === null ? '' : stableSnapshot(baseline)), [baseline]);
      const dirty = draftSnapshot !== '' && baselineSnapshot !== '' && draftSnapshot !== baselineSnapshot;
      const editable = inventory !== null && inventory.editable !== false;
      const locked = busy !== '' || !editable;
      const problems = draft === null ? '' : draftProblemOf(draft);
      const roles = (inventory !== null && Array.isArray(inventory.roles) ? inventory.roles : []).filter(
        (role) => isObject(role) && typeof role.id === 'string' && role.id !== '',
      );
      const diagnostics = inventory !== null && Array.isArray(inventory.diagnostics) ? inventory.diagnostics : [];
      const activeRole = selectedRole !== '' ? roles.find((role) => role.id === selectedRole) || null : null;
      const activeView = activeRole !== null && view !== null ? view.roles[activeRole.id] || null : null;

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
        try {
          const payload = await requestJson(ROUTE_SAVE, { method: 'POST', body: JSON.stringify(serializeDraft(draft)) });
          if (!mounted.current) return;
          if (payload.saved !== true) {
            throw new Error(
              typeof payload.error === 'string' && payload.error !== '' ? payload.error : t('saveFailedShort'),
            );
          }
          setNotice({ tone: 'ok', text: t('saved') });
          // 配置已写盘：先把当前草稿记为新的基线，再后台重扫（重扫失败也不影响脏状态，
          // 且不长时间锁住整页交互）。
          setBaseline(JSON.parse(JSON.stringify(draft)));
          void refreshAfterSave(stableSnapshot(serializeDraft(draft)));
        } catch (error) {
          if (!mounted.current) return;
          setNotice({ tone: 'error', text: fill(t('saveFailed'), { error: errorTextOf(error) }) });
        } finally {
          savingRef.current = false;
          if (mounted.current) setBusy('');
        }
      }, [busy, draft, editable, problems, dirty, refreshAfterSave]);

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
          applyInventory(payload);
        } catch (error) {
          if (!mounted.current || token !== seq.current) return;
          setNotice({ tone: 'error', text: fill(t('rescanFailed'), { error: errorTextOf(error) }) });
        } finally {
          if (mounted.current) setBusy('');
        }
      }, [busy, dirty, applyInventory]);

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
        setNotice(null);
        setAddForm(null);
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

      if (phase === 'loading' && inventory === null) {
        return h('div', { className: 'tx-page' }, h('p', { className: 'tx-state' }, t('loading')));
      }

      if (phase === 'error' || inventory === null || draft === null || view === null) {
        return h(
          'div',
          { className: 'tx-page' },
          h(
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
          ),
        );
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

      const roleCards = roles.map((role) => {
        const roleView = view.roles[role.id] || { mode: 'open', configured: false, visibleList: [], hiddenList: [] };
        const roleName = asText(role.name) === '' ? role.id : asText(role.name);
        const modeLabel = roleView.mode === 'allow' ? t('modeAllow') : t('modeOpen');
        const meta = fill(t('roleMeta'), {
          mode: modeLabel,
          visible: String(roleView.visibleList.length),
          managed: String(view.index.managed.length),
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
            h('span', { className: 'tx-roleName' }, roleName),
            role.isDefault === true ? h('span', { className: 'tx-tag' }, t('roleDefault')) : null,
            roleView.configured ? null : h('span', { className: 'tx-tag tx-tagMuted' }, t('roleUnconfigured')),
            role.broken ? h('span', { className: 'tx-tag tx-tagDanger', title: role.broken }, t('roleBroken')) : null,
          ),
          h('span', { className: 'tx-roleDesc' }, asText(role.description) !== '' ? asText(role.description) : role.id),
          h('span', { className: 'tx-roleMeta' }, meta),
        );
      });

      const groupRows = view.index.groups.map((group) => {
        const isOpen = expanded[group.id] === true;
        const stats = activeView !== null ? activeView.groupState[group.id] : { visible: 0, total: 0 };
        const state = stats === undefined || stats.total === 0 ? 'none' : stats.visible === 0 ? 'none' : stats.visible === stats.total ? 'all' : 'partial';
        const stateLabel =
          stats === undefined || stats.total === 0
            ? '—'
            : state === 'all'
              ? t('toolVisible')
              : state === 'partial'
                ? t('groupPartial')
                : t('toolHidden');
        return h(
          React.Fragment,
          { key: group.id },
          h(
            'div',
            { className: 'tx-groupRow' },
            h(
              'button',
              {
                type: 'button',
                className: 'tx-groupMain',
                'aria-expanded': isOpen,
                onClick: () => toggleExpanded(group.id),
              },
              h(Chevron, { open: isOpen }),
              h(
                'span',
                { className: 'tx-groupText' },
                h('span', { className: 'tx-groupName' }, group.label),
                h(
                  'span',
                  { className: 'tx-groupMeta' },
                  group.match.length > 0 ? group.match.join(' · ') : '—',
                  h('span', { className: 'tx-dot' }, '·'),
                  fill(t('groupTools'), { count: String(group.tools.length) }),
                  group.tools.length === 0 ? h('span', { className: 'tx-warnInline' }, t('groupNoTools')) : null,
                ),
              ),
            ),
            h(
              'span',
              { className: 'tx-groupEnd' },
              h('span', { className: 'tx-groupState', 'data-state': state }, stateLabel),
              h(Switch, {
                checked: state === 'all',
                mixed: state === 'partial',
                disabled: locked || activeRole === null || group.tools.length === 0,
                label: `${group.label} · ${activeRole === null ? '' : asText(activeRole.name) || activeRole.id}`,
                onChange: () => {
                  if (activeRole !== null) toggleGroup(activeRole.id, group.id, group.tools);
                },
              }),
            ),
          ),
          isOpen
            ? h(
                'div',
                { className: 'tx-toolList' },
                group.tools.length === 0
                  ? h('div', { className: 'tx-toolEmpty' }, t('groupNoTools'))
                  : group.tools.map((name) =>
                      h(
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
                        ),
                        h(Switch, {
                          checked: activeView !== null && activeView.visible.has(name),
                          disabled: locked || activeRole === null,
                          label: name,
                          onChange: () => {
                            if (activeRole !== null) toggleTool(activeRole.id, group.id, name);
                          },
                        }),
                      ),
                    ),
              )
            : null,
        );
      });

      const ungrouped = view.index.ungrouped;

      const activeName = activeRole === null ? '' : asText(activeRole.name) === '' ? activeRole.id : asText(activeRole.name);
      const activeMode = activeView === null ? 'open' : activeView.mode;

      return h(
        'div',
        { className: 'tx-page' },
        h(
          'header',
          { className: 'tx-head' },
          h(
            'div',
            { className: 'tx-headText' },
            h('h2', { className: 'tx-title' }, t('title')),
            h('p', { className: 'tx-intro' }, t('intro')),
          ),
          h(
            'div',
            { className: 'tx-toolbar' },
            dirty ? h('span', { className: 'tx-unsaved' }, t('unsaved')) : null,
            h(
              'button',
              { type: 'button', className: 'tx-btn tx-btnSm', disabled: locked, onClick: () => void rescan() },
              busy === 'rescan' ? t('rescanning') : t('rescan'),
            ),
            h(
              'button',
              { type: 'button', className: 'tx-btn tx-btnSm', disabled: locked || !dirty, onClick: discard },
              t('discard'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'tx-btn tx-btnSm tx-btnPrimary',
                // 有校验问题时不禁用保存：点击后把问题以提示条显示出来，比一个
                // 只能 hover 才看到原因的禁用按钮更可诊断。
                disabled: locked || !dirty || !editable,
                title: !editable ? t('readonlyHint') : problems !== '' ? problems : undefined,
                onClick: () => void save(),
              },
              busy === 'save' ? t('saving') : t('save'),
            ),
          ),
        ),

        h(Notice, { notice }),
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

        // 角色卡片
        h(
          'section',
          { className: 'tx-section' },
          h(
            'div',
            { className: 'tx-sectionHead' },
            h('h3', { className: 'tx-sectionTitle' }, t('rolesTitle')),
            h('span', { className: 'tx-sectionMeta' }, `${roles.length}`),
          ),
          h('p', { className: 'tx-sectionIntro' }, t('rolesIntro')),
          roles.length === 0
            ? h('p', { className: 'tx-empty' }, t('roleEmpty'))
            : h('div', { className: 'tx-roleGrid' }, roleCards),
        ),

        // 选中角色详情
        activeRole === null
          ? h('p', { className: 'tx-hint' }, t('editHint'))
          : h(
              'section',
              { className: 'tx-section' },
              h(
                'div',
                { className: 'tx-detailHead' },
                h('h3', { className: 'tx-sectionTitle' }, activeName),
                h(
                  'span',
                  { className: 'tx-detailActions' },
                  h('span', { className: 'tx-sectionMeta' }, `${activeView.visibleList.length}/${view.index.managed.length}`),
                  activeView.configured
                    ? h(
                        'button',
                        {
                          type: 'button',
                          className: 'tx-btn tx-btnSm',
                          disabled: locked,
                          title: t('roleResetHint'),
                          onClick: () => resetRole(activeRole.id),
                        },
                        t('roleReset'),
                      )
                    : null,
                ),
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
              h('div', { className: 'tx-groups' }, groupRows),

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
        h(
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
        ),

        // 全局
        h(
          'section',
          { className: 'tx-section' },
          h('div', { className: 'tx-sectionHead' }, h('h3', { className: 'tx-sectionTitle' }, t('globalTitle'))),
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
                        value: source.label,
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
                          'aria-label': fill(t('manageRemoveLabel'), { label: asText(source.label) === '' ? id : asText(source.label) }),
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
      );
    }

    /* ------------------------------------------------------------------ */
    /* 样式（全部走 --dsw-* token，前缀 tx-）                               */
    /* ------------------------------------------------------------------ */

    const CSS = `
.tx-page{box-sizing:border-box;width:100%;max-width:720px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:20px;font-size:13px;line-height:20px}
.tx-state{color:var(--dsw-alias-label-tertiary);margin:0;padding:24px 0}
.tx-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap}
.tx-headText{min-width:0;display:flex;flex-direction:column;gap:4px}
.tx-title{margin:0;font-size:18px;font-weight:600;line-height:26px}
.tx-intro{margin:0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}
.tx-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end}
.tx-unsaved{color:var(--dsw-alias-state-warn-label,var(--dsw-alias-state-warn-primary));font-size:12px;line-height:18px}
.tx-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;height:32px;padding:0 12px;border:none;border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;cursor:pointer}
.tx-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.tx-btn:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active)}
.tx-btn:disabled{opacity:.4;cursor:not-allowed}
.tx-btn:focus-visible,.tx-segBtn:focus-visible,.tx-switch:focus-visible,.tx-roleCard:focus-visible,.tx-groupMain:focus-visible,.tx-disclosure:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.tx-btnSm{height:28px;padding:0 10px;font-size:12px;line-height:18px;border-radius:var(--dsw-radius-sm)}
.tx-btnPrimary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.tx-btnPrimary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.tx-btnOutline{border:.5px solid var(--dsw-alias-border-l3)}
.tx-btnDanger{color:var(--dsw-alias-state-error-primary)}
.tx-notice{margin:0;padding:8px 12px;border-radius:var(--dsw-radius-md);font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l2)}
.tx-notice[data-tone=ok]{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb, var(--dsw-alias-state-success-primary) 30%, transparent);background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 8%, transparent)}
.tx-notice[data-tone=error]{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary) 30%, transparent);background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent)}
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
.tx-detailActions{display:flex;align-items:center;gap:8px;flex:none}
.tx-subHead{color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:600;line-height:18px;letter-spacing:.04em;text-transform:uppercase;margin-top:2px}
.tx-roleGrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:8px}
.tx-roleCard{appearance:none;font:inherit;text-align:left;cursor:pointer;display:flex;flex-direction:column;gap:4px;min-width:0;padding:12px 14px;border:.5px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l2));border-radius:var(--dsw-radius-lg,10px);background:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-label-primary);transition:border-color .16s,background .16s}
.tx-roleCard:hover:not([data-active=true]){background:var(--dsw-alias-interactive-bg-hover)}
.tx-roleCard[data-active=true]{background:var(--dsw-alias-bg-module-platform,var(--dsw-alias-bg-layer-2));border-color:var(--dsw-static-neutral-bluish-400,var(--dsw-alias-brand-primary))}
.tx-roleHead{display:flex;align-items:center;gap:6px;min-width:0;flex-wrap:wrap}
.tx-roleName{font-size:15px;font-weight:600;line-height:22px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.tx-roleDesc{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tx-roleMeta{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;margin-top:2px}
.tx-tag{flex:none;border-radius:999px;background:var(--dsw-alias-fill-tsp-secondary,var(--dsw-alias-bg-layer-3));color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:17px;padding:0 7px}
.tx-tagMuted{background:transparent;border:.5px solid var(--dsw-alias-border-l2)}
.tx-tagDanger{background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent);color:var(--dsw-alias-label-error,var(--dsw-alias-state-error-primary))}
.tx-row{display:flex;align-items:center;justify-content:space-between;gap:24px;padding:14px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.tx-rowText{min-width:0;display:flex;flex-direction:column;gap:4px}
.tx-rowTitle{font-size:14px;line-height:20px}
.tx-rowDesc{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.tx-rowActions{display:flex;align-items:center;gap:8px;flex:none}
.tx-seg{display:inline-flex;align-items:center;gap:2px;padding:2px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);flex:none}
.tx-segBtn{appearance:none;font:inherit;font-size:12px;line-height:18px;height:24px;padding:0 10px;border:none;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;white-space:nowrap}
.tx-segBtn:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
.tx-segBtn[data-active=true]{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-elevation-soft,none)}
.tx-segBtn:disabled{opacity:.5;cursor:default}
.tx-groups{border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg,10px);background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.tx-groupRow{display:flex;align-items:center;gap:12px;padding:0 12px 0 4px;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.tx-groupRow:last-child{border-bottom:none}
.tx-groupMain{appearance:none;font:inherit;text-align:left;cursor:pointer;display:flex;align-items:center;gap:8px;min-width:0;flex:1;padding:12px 8px;background:transparent;border:none;color:var(--dsw-alias-label-primary);border-radius:var(--dsw-radius-sm)}
.tx-groupMain:hover{background:var(--dsw-alias-interactive-bg-hover)}
.tx-chevron{flex:none;color:var(--dsw-alias-label-tertiary);transition:transform .16s}
.tx-chevron[data-open=true]{transform:rotate(90deg)}
.tx-groupText{display:flex;flex-direction:column;gap:2px;min-width:0}
.tx-groupName{font-size:14px;line-height:20px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tx-groupMeta{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tx-dot{opacity:.6}
.tx-warnInline{color:var(--dsw-alias-state-warn-label,var(--dsw-alias-state-warn-primary))}
.tx-groupEnd{display:flex;align-items:center;gap:10px;flex:none}
.tx-groupState{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;white-space:nowrap}
.tx-groupState[data-state=partial]{color:var(--dsw-alias-state-warn-label,var(--dsw-alias-state-warn-primary))}
.tx-groupState[data-state=all]{color:var(--dsw-alias-label-secondary)}
.tx-toolList{display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-2);border-bottom:.5px solid var(--dsw-alias-border-l2)}
.tx-toolRow{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:8px 12px 8px 28px;border-top:.5px solid var(--dsw-alias-border-l1)}
.tx-toolRow:first-child{border-top:none}
.tx-toolText{display:flex;flex-direction:column;gap:1px;min-width:0}
.tx-toolName{font-family:var(--dsw-font-mono,ui-monospace,Consolas,monospace);font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tx-toolDesc{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tx-toolEmpty{padding:10px 12px 10px 28px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.tx-switch{box-sizing:border-box;position:relative;flex:none;width:36px;height:20px;padding:2px;border:0;border-radius:999px;background:var(--dsw-alias-state-idle-primary,var(--dsw-alias-border-l3));cursor:pointer}
.tx-switch[aria-checked=true]{background:var(--dsw-alias-brand-primary)}
.tx-switch[data-mixed=true]{background:var(--dsw-alias-state-warn-primary)}
.tx-switch:disabled{cursor:default;opacity:.5}
.tx-switchThumb{display:block;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-switch-thumb,var(--dsw-alias-label-primary-foreground));box-shadow:0 1px 2px var(--dsw-alias-border-l2);transition:transform .16s}
.tx-switch[aria-checked=true] .tx-switchThumb{transform:translateX(16px)}
.tx-switch[data-mixed=true] .tx-switchThumb{transform:translateX(8px)}
.tx-disclosure{appearance:none;font:inherit;text-align:left;cursor:pointer;display:inline-flex;align-items:center;gap:6px;padding:0;border:none;background:transparent;color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:22px;align-self:flex-start}
.tx-disclosure:hover{color:var(--dsw-alias-brand-primary)}
.tx-disclosure:focus-visible{outline-offset:3px}
.tx-effective{display:grid;grid-template-columns:1fr 1fr;gap:16px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg,10px);background:var(--dsw-alias-bg-layer-1);padding:12px}
.tx-effectiveCol{display:flex;flex-direction:column;gap:6px;min-width:0}
.tx-effectiveHead{color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500;line-height:18px}
.tx-chips{display:flex;flex-wrap:wrap;gap:4px;margin:0;padding:0;list-style:none}
.tx-chip{border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);font-family:var(--dsw-font-mono,ui-monospace,Consolas,monospace);font-size:11px;line-height:18px;padding:0 7px;overflow-wrap:anywhere}
.tx-chipOff{opacity:.6;text-decoration:line-through}
.tx-manage{display:flex;flex-direction:column;gap:10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg,10px);background:var(--dsw-alias-bg-layer-1);padding:12px}
.tx-manageRow{display:grid;grid-template-columns:auto minmax(0,1fr) minmax(0,1.4fr) auto;gap:10px;align-items:end;padding-top:10px;border-top:.5px solid var(--dsw-alias-border-l1)}
.tx-manageRow:first-of-type{border-top:none;padding-top:0}
.tx-groupId{color:var(--dsw-alias-label-tertiary);font-family:var(--dsw-font-mono,ui-monospace,Consolas,monospace);font-size:11px;line-height:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:110px}
.tx-rename{display:flex;align-items:center;gap:4px;min-width:0}
.tx-renameInput{width:110px}
.tx-field{display:flex;flex-direction:column;gap:4px;min-width:0}
.tx-fieldLabel{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px}
.tx-input{box-sizing:border-box;width:100%;min-width:0;height:32px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;outline:none}
.tx-input:focus{border-color:var(--dsw-alias-state-business-primary);box-shadow:inset 0 0 0 .5px var(--dsw-alias-state-business-primary)}
.tx-input:disabled{opacity:.6}
.tx-manageFoot{display:flex;align-items:center;gap:8px;justify-content:flex-end}
.tx-addForm{display:flex;flex-direction:column;gap:8px;padding:10px;border:1px dashed var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2)}
.tx-addTitle{color:var(--dsw-alias-label-primary);font-size:12px;font-weight:500;line-height:18px}
.tx-addGrid{display:grid;grid-template-columns:minmax(0,.8fr) minmax(0,1fr) minmax(0,1.4fr);gap:10px}
.tx-addActions{display:flex;gap:8px}
.tx-errorCard{border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg,10px);background:var(--dsw-alias-bg-layer-1);padding:16px;display:flex;flex-direction:column;gap:8px;align-items:flex-start}
.tx-errorTitle{font-size:14px;font-weight:500;line-height:20px;color:var(--dsw-alias-state-error-primary)}
.tx-errorText{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.tx-errorHint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
@media (max-width:720px){.tx-effective{grid-template-columns:1fr}.tx-manageRow,.tx-addGrid{grid-template-columns:1fr}.tx-manageFoot{justify-content:flex-start}}
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

      ctx.effect(() => {
        const tag = document.createElement('style');
        tag.dataset.plugin = 'dsh-tool-exposure';
        tag.textContent = CSS;
        document.head.appendChild(tag);
        return () => {
          tag.remove();
        };
      }, 'tool-exposure: stylesheet');

      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'tool-exposure',
            order: 25,
            label: () => t('nav'),
          },
          ToolExposurePage,
        ),
      );
    }

    return {
      inject: ['slots', 'locale'],
      apply,
    };
  },
});
