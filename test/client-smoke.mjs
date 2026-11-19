/**
 * Smoke test for tool-exposure/client.js — loads the real bundle under a stub
 * module loader, a mini React hooks runtime, and a fake fetch, then renders the
 * standalone page and exercises the core interactions.
 *
 * Run: node this-file.mjs
 */
import { readFileSync } from 'node:fs';

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { __test as Host } from '../index.js';
const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT = join(HERE, '..', 'client.js');
const source = readFileSync(CLIENT, 'utf8');

/* ----------------------------- stubs ----------------------------- */

const styleTags = [];
globalThis.document = {
  documentElement: { lang: 'zh-CN' },
  createElement: () => ({ dataset: {}, textContent: '', remove() {} }),
  head: { appendChild(tag) { styleTags.push(tag); } },
  querySelector: () => null,
};
// Node 24 exposes a read-only global `navigator`; the page reads
// document.documentElement.lang first, so no navigator stub is needed.
Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true });

let moduleDef = null;
const windowListeners = new Map();
globalThis.window = {
  __ModuleLoader__: { load(def) { moduleDef = def; } },
  confirm: () => true,
  addEventListener(name, listener) { windowListeners.set(name, listener); },
  removeEventListener(name, listener) { if (windowListeners.get(name) === listener) windowListeners.delete(name); },
};

const INVENTORY = {
  ok: true,
  rowId: 'tool-exposure',
  unlisted: 'open',
  sources: [
    { id: 'fofatoto', label: 'FOFA 测绘', match: ['fofa_*'], toolCount: 2 },
    { id: 'hdc', label: '鸿蒙设备与 DevEco', match: ['hdc_*', 'hms_*'], toolCount: 2 },
  ],
  roles: [
    {
      id: 'asset-expert', name: '资产专家', description: '企业互联网资产与关联图谱', isDefault: false, broken: null,
      configured: true, mode: 'allow', groups: { fofatoto: 'on' }, tools: {}, managed: 4, visible: 2, hidden: 2,
    },
    {
      id: 'standard', name: 'standard', description: '', isDefault: true, broken: null,
      configured: false, mode: 'open', groups: {}, tools: {}, managed: 4, visible: 4, hidden: 0,
    },
  ],
  orphanRoles: {
    ghost: { mode: 'open', groups: { hdc: 'off' }, tools: { hms_build: 'on', session_search: 'off' } },
  },
  tools: [
    { name: 'fofa_account', source: 'fofatoto', description: '查询 FOFA 额度' },
    { name: 'fofa_search', source: 'fofatoto', description: '执行查询' },
    { name: 'hdc_shell', source: 'hdc', description: '设备 shell' },
    { name: 'hms_build', source: 'hdc', description: 'DevEco 构建' },
    { name: 'session_search', source: null, description: '未归组工具' },
  ],
  managed: 4,
  ungrouped: ['session_search'],
  diagnostics: [],
  editable: true,
  editableHint: null,
  generatedAt: Date.now(),
};

const fetchCalls = [];
let currentInventory = INVENTORY;
let inventoryShouldFail = false;
let inventoryGate = null;
let saveGate = null;
let saveResult = null;
globalThis.fetch = async (url, init) => {
  fetchCalls.push({ url, init });
  const json = (payload, status = 200) => ({ ok: status < 400, status, json: async () => payload });
  if (String(url).endsWith('/inventory')) {
    if (inventoryShouldFail) return json({ ok: false, error: 'boom' }, 500);
    const pendingInventory = inventoryGate;
    if (pendingInventory) return json(await pendingInventory);
    return json(currentInventory);
  }
  if (String(url).endsWith('/save')) {
    if (saveGate) await saveGate;
    if (saveResult) return json(saveResult.body, saveResult.status);
    return json({ ok: true, saved: true, appliedTo: 'new-sessions' });
  }
  if (String(url).endsWith('/reset')) return json({ ok: true, lifted: 2 });
  return json({ ok: false, error: 'not found' }, 404);
};

/* ------------------------- mini React ---------------------------- */

const hookSlots = [];
let hookCursor = 0;
let dirty = false;
let pendingEffects = [];

function sameDeps(a, b) {
  if (a === undefined || b === undefined) return false;
  if (a === null || b === null) return a === b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (!Object.is(a[i], b[i])) return false;
  return true;
}

const React = {
  Fragment: Symbol('Fragment'),
  createElement(type, props, ...children) {
    return { type, props: props || {}, children: children.flat(Infinity) };
  },
  useState(initial) {
    const index = hookCursor++;
    if (!(index in hookSlots)) {
      hookSlots[index] = { kind: 'state', value: typeof initial === 'function' ? initial() : initial };
    }
    const slot = hookSlots[index];
    return [
      slot.value,
      (next) => {
        const value = typeof next === 'function' ? next(slot.value) : next;
        if (!Object.is(value, slot.value)) {
          slot.value = value;
          dirty = true;
        }
      },
    ];
  },
  useRef(initial) {
    const index = hookCursor++;
    if (!(index in hookSlots)) hookSlots[index] = { kind: 'ref', current: initial };
    return hookSlots[index];
  },
  useMemo(fn, deps) {
    const index = hookCursor++;
    const slot = hookSlots[index];
    if (slot && slot.kind === 'memo' && sameDeps(slot.deps, deps)) return slot.value;
    const value = fn();
    hookSlots[index] = { kind: 'memo', value, deps };
    return value;
  },
  useCallback(fn, deps) {
    const index = hookCursor++;
    const slot = hookSlots[index];
    if (slot && slot.kind === 'callback' && sameDeps(slot.deps, deps)) return slot.value;
    hookSlots[index] = { kind: 'callback', value: fn, deps };
    return fn;
  },
  useEffect(fn, deps) {
    const index = hookCursor++;
    const slot = hookSlots[index];
    const changed = !slot || !sameDeps(slot.deps, deps);
    if (changed) {
      if (slot && typeof slot.cleanup === 'function') {
        try { slot.cleanup(); } catch { /* ignore */ }
      }
      pendingEffects.push({ index, fn, deps });
    }
    hookSlots[index] = { kind: 'effect', deps, cleanup: slot ? slot.cleanup : undefined };
  },
  useId() {
    const index = hookCursor++;
    return `id-${index}`;
  },
};

/* --------------------- fake module + context --------------------- */

function loadModule() {
  // eslint-disable-next-line no-new-func
  new Function('window', source)(globalThis.window);
  if (!moduleDef || moduleDef.id !== 'dsh-tool-exposure') throw new Error('module id mismatch: ' + (moduleDef && moduleDef.id));
  const required = [];
  const exportsObj = moduleDef.factory((name) => {
    required.push(name);
    if (name === 'react') return React;
    throw new Error('unexpected require: ' + name);
  });
  if (!exportsObj || typeof exportsObj.apply !== 'function') throw new Error('factory did not return apply');
  return { exports: exportsObj, required };
}

const registrations = [];
const panelSelections = [];
let activePanelId = 'dsh-tool-exposure';
function makeContext() {
  const dictionaries = {};
  const layout = {
    panelInfo: { getSnapshot: () => ({ activePanelId }) },
    selectPanel(id) { activePanelId = id; panelSelections.push(id); },
  };
  return {
    layout,
    get(name) { return name === 'layout' ? layout : undefined; },
    effect(fn, label) {
      const cleanup = fn();
      if (typeof cleanup === 'function') cleanups.push(cleanup);
      return cleanup;
    },
    locale: {
      register(ns, dicts) {
        dictionaries[ns] = dicts;
        return () => {};
      },
      bind(ns) {
        return (key) => {
          const dict = dictionaries[ns];
          const language = document.documentElement.lang.startsWith('zh') ? 'zh' : 'en';
          if (dict && dict[language] && typeof dict[language][key] === 'string') return dict[language][key];
          return key;
        };
      },
    },
    slots: {
      inject(key, callback) {
        callback();
        return () => {};
      },
      register(options, Component) {
        registrations.push({ options, Component });
        return () => {};
      },
    },
  };
}
const cleanups = [];

/* --------------------------- renderer ---------------------------- */

let component = null;
let tree = null;
let componentProps = {};

function renderOnce() {
  dirty = false;
  hookCursor = 0;
  pendingEffects = [];
  tree = component(componentProps);
  for (const effect of pendingEffects) {
    const slot = hookSlots[effect.index];
    try {
      const cleanup = effect.fn();
      if (slot) slot.cleanup = typeof cleanup === 'function' ? cleanup : undefined;
    } catch (error) {
      throw new Error('effect failed: ' + (error && error.stack ? error.stack : error));
    }
  }
  return tree;
}

async function settleLong(ms = 1100) {
  await new Promise((resolve) => setTimeout(resolve, ms));
  await settle();
}

async function settle(rounds = 40) {
  let idle = 0;
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (dirty) {
      idle = 0;
      renderOnce();
    } else {
      idle += 1;
      if (idle >= 5) return;
    }
  }
  throw new Error('did not settle');
}

function walk(node, visit) {
  if (node === null || node === undefined || node === false || node === true) return;
  if (typeof node === 'string' || typeof node === 'number') {
    visit({ text: String(node) });
    return;
  }
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (typeof node !== 'object') return;
  // Expand stateless function components (Switch/Segmented/Notice/Chevron) so the
  // rendered DOM-like tree is what the assertions see.
  if (typeof node.type === 'function') {
    walk(node.type(node.props), visit);
    return;
  }
  if (node.type === React.Fragment) {
    for (const child of node.children || []) walk(child, visit);
    return;
  }
  visit({ node });
  for (const child of node.children || []) walk(child, visit);
}

function texts() {
  const out = [];
  walk(tree, (item) => {
    if (item.text !== undefined) out.push(item.text);
  });
  return out;
}

function nodesBy(predicate) {
  const out = [];
  walk(tree, (item) => {
    if (item.node && predicate(item.node)) out.push(item.node);
  });
  return out;
}

function classNameOf(node) {
  return node.props && typeof node.props.className === 'string' ? node.props.className : '';
}

/** Exact class-token match (avoids tx-switch matching tx-switchThumb). */
function hasClass(node, name) {
  return classNameOf(node).split(/\s+/).includes(name);
}

function click(node) {
  if (!node || !node.props || typeof node.props.onClick !== 'function') throw new Error('node has no onClick');
  node.props.onClick({ stopPropagation() {}, preventDefault() {}, target: { value: '' } });
}

/* ---------------------------- run ------------------------------- */

const failures = [];
function check(name, fn) {
  try {
    fn();
    console.log('PASS', name);
  } catch (error) {
    failures.push({ name, error });
    console.log('FAIL', name, '->', error && error.message ? error.message : error);
  }
}

const { exports } = loadModule();
const ctx = makeContext();
exports.apply(ctx);

check('registration: matching main panel and native left-sidebar entry', () => {
  if (registrations.length !== 2) throw new Error('expected main and sidebar registrations');
  const { options } = registrations[0];
  const navigation = registrations[1].options;
  if (options.name !== 'main' || options.key !== 'dsh-tool-exposure') throw new Error('main panel missing');
  if (navigation.name !== 'sidebar.panellist' || navigation.id !== options.key) throw new Error('sidebar does not target panel');
  if (typeof navigation.label !== 'function' || navigation.label() !== '工具暴露') throw new Error('sidebar label missing');
  if (typeof options.inject().onReturn !== 'function' || !options.inject().memory) throw new Error('page navigation and draft storage missing');
  if (registrations.some((entry) => entry.options.name === 'settings.section')) throw new Error('old settings entry remains');
  if (typeof registrations[0].Component !== 'function') throw new Error('no component');
});

check('stylesheet injected', () => {
  if (styleTags.length !== 1) throw new Error('expected 1 style tag, got ' + styleTags.length);
  if (!styleTags[0].textContent.includes('.tx-page')) throw new Error('css missing .tx-page');
});

component = registrations[0].Component;
componentProps = { onReturn: registrations[0].options.inject().onReturn };

const loadingTree = renderOnce();
check('initial render shows loading', () => {
  const list = texts();
  if (!list.includes('加载中…')) throw new Error('missing loading text: ' + JSON.stringify(list));
});

await settle();

check('ready render: title/roles/groups/ungrouped present', () => {
  const list = texts();
  for (const needle of ['工具暴露', '角色', '资产专家', 'standard', '工具组', 'FOFA 测绘', '鸿蒙设备与 DevEco', '未归组工具', 'session_search', '全局', '管理工具组']) {
    if (!list.includes(needle)) throw new Error('missing text: ' + needle + ' in ' + JSON.stringify(list.slice(0, 40)));
  }
});

check('inventory fetched exactly once with guard header', () => {
  const calls = fetchCalls.filter((item) => String(item.url).endsWith('/inventory'));
  if (calls.length !== 1) throw new Error('expected exactly 1 inventory call before save, got ' + calls.length);
  const call = calls[0];
  if (call.init.headers['x-dsh-tool-exposure-plugin'] !== '1') throw new Error('missing guard header');
  if (call.init.cache !== 'no-store') throw new Error('missing cache no-store');
});

check('default preset shows the default badge', () => {
  const badge = nodesBy(
    (node) => hasClass(node, 'tx-tag') && Array.isArray(node.children) && node.children.includes('默认'),
  );
  if (badge.length === 0) throw new Error('default badge missing');
});

check('role cards: 2 cards, active is first role', () => {
  const cards = nodesBy((node) => hasClass(node, 'tx-roleCard'));
  if (cards.length !== 2) throw new Error('expected 2 role cards, got ' + cards.length);
  if (cards[0].props['data-active'] !== 'true') throw new Error('first card not active');
  if (cards[0].props['aria-pressed'] !== true) throw new Error('first card aria-pressed wrong');
});

check('switches: group switches reflect allow-list mode (hdc off)', () => {
  const switches = nodesBy((node) => hasClass(node, 'tx-switch'));
  if (switches.length !== 3) throw new Error('expected 2 group switches and discovery, got ' + switches.length);
  const checked = switches.map((node) => node.props['aria-checked']);
  if (checked[0] !== true) throw new Error('fofa group should be on, got ' + checked[0]);
  if (checked[1] !== false) throw new Error('hdc group should be off, got ' + checked[1]);
});

// expand the first group (FOFA) to reveal tool rows
const groupMains = nodesBy((node) => hasClass(node, 'tx-groupMain'));
check('group main buttons present', () => {
  if (groupMains.length !== 2) throw new Error('expected 2 group mains, got ' + groupMains.length);
});
click(groupMains[0]);
renderOnce();

check('expanded group renders tool rows with switches', () => {
  const names = texts();
  if (!names.includes('fofa_account')) throw new Error('fofa_account missing after expand');
  const switches = nodesBy((node) => hasClass(node, 'tx-switch'));
  if (switches.length !== 5) throw new Error('expected 4 tool/group switches and discovery, got ' + switches.length);
});

// toggle the hdc group switch (found by its aria-label) on -> draft becomes dirty
const hdcGroupSwitch = nodesBy((node) => hasClass(node, 'tx-switch') && String(node.props['aria-label'] || '').includes('鸿蒙设备'))[0];
if (!hdcGroupSwitch) throw new Error('hdc group switch not found');
click(hdcGroupSwitch);
renderOnce();

check('toggling hdc group marks draft dirty and turns it on', () => {
  const list = texts();
  if (!list.includes('有未保存的修改')) throw new Error('unsaved indicator missing');
  const hdcSwitch = nodesBy((node) => hasClass(node, 'tx-switch') && String(node.props['aria-label'] || '').includes('鸿蒙设备'))[0];
  if (!hdcSwitch) throw new Error('hdc group switch missing after toggle');
  if (hdcSwitch.props['aria-checked'] !== true) throw new Error('hdc group still off');
});

// save
const saveButton = nodesBy((node) => typeof node.children !== 'undefined' && node.type === 'button' && node.children && node.children.includes('保存'))
  .find((node) => hasClass(node, 'tx-btnPrimary'));
check('save button found and enabled after edit', () => {
  if (!saveButton) throw new Error('save button not found');
  if (saveButton.props.disabled === true) throw new Error('save button disabled');
});
click(saveButton);
await settleLong();

check('save posted serialized draft with role entries', () => {
  const call = fetchCalls.find((item) => String(item.url).endsWith('/save'));
  if (!call) throw new Error('save not called');
  const body = JSON.parse(call.init.body);
  if (body.unlisted !== 'open') throw new Error('bad unlisted: ' + body.unlisted);
  if (!body.sources.fofatoto || body.sources.fofatoto.match[0] !== 'fofa_*') throw new Error('bad sources');
  const role = body.roles['asset-expert'];
  if (!role || role.mode !== 'allow') throw new Error('bad role mode: ' + JSON.stringify(role));
  if (role.groups.hdc !== 'on') throw new Error('hdc group not saved on: ' + JSON.stringify(role));
  if (role.groups.fofatoto !== 'on') throw new Error('fofatoto group not kept on: ' + JSON.stringify(role));
  if (body.roles.standard !== undefined) throw new Error('unconfigured role should not be submitted');
  const ghost = body.roles.ghost;
  if (!ghost) throw new Error('orphan role entry was dropped from the save payload');
  if (ghost.mode !== 'open' || ghost.groups.hdc !== 'off' || ghost.tools.hms_build !== 'on') {
    throw new Error('orphan role entry changed: ' + JSON.stringify(ghost));
  }
});

check('success notice after save', () => {
  const list = texts();
  if (!list.includes('已保存，新建会话生效。')) throw new Error('missing saved notice: ' + JSON.stringify(list.filter((item) => item.includes('保存'))));
});

/* ---------------- manage tool groups: delete cleanup ---------------- */

// After the save, the page rescanned the (static) fixture, so the draft is back to
// asset-expert: allow-list with the FOFA group on. Create one tool override first,
// then delete the group and verify both the group reference and the now-orphaned
// tool override are gone from the next save payload.

const manageButton = nodesBy((node) => node.type === 'button' && Array.isArray(node.children) && node.children.includes('管理工具组'))[0];
check('manage tool groups disclosure found', () => {
  if (!manageButton) throw new Error('manage disclosure not found');
});
click(manageButton);
renderOnce();

const groupMains2 = nodesBy((node) => hasClass(node, 'tx-groupMain'));
let toolSwitch = nodesBy((node) => hasClass(node, 'tx-switch') && String(node.props['aria-label'] || '') === 'fofa_account')[0];
if (!toolSwitch && groupMains2[0]) {
  click(groupMains2[0]);
  renderOnce();
  toolSwitch = nodesBy((node) => hasClass(node, 'tx-switch') && String(node.props['aria-label'] || '') === 'fofa_account')[0];
}
check('per-tool override can be created before deleting the group', () => {
  if (!toolSwitch) throw new Error('fofa_account switch not found');
  click(toolSwitch);
  renderOnce();
  const list = texts();
  if (!list.includes('有未保存的修改')) throw new Error('override did not mark the draft dirty');
});

const deleteButton = nodesBy(
  (node) => node.type === 'button' && hasClass(node, 'tx-btnDanger') && Array.isArray(node.children) && node.children.includes('删除'),
)[0];
check('group delete button found in manage panel', () => {
  if (!deleteButton) throw new Error('delete button not found');
});
click(deleteButton);
renderOnce();

check('deleted group disappears from matrix and manage list', () => {
  const list = texts();
  if (list.includes('FOFA 测绘')) throw new Error('deleted group still rendered');
  if (list.includes('fofa_account') === false) throw new Error('fofa_account should surface as an ungrouped chip');
});

const saveButton2 = nodesBy(
  (node) => node.type === 'button' && Array.isArray(node.children) && node.children.includes('保存'),
).find((node) => hasClass(node, 'tx-btnPrimary'));
check('save button available after deleting a group', () => {
  if (!saveButton2) throw new Error('save button not found');
  if (saveButton2.props.disabled === true) throw new Error('save button disabled');
});
click(saveButton2);
await settleLong();

check('save after delete: group, role reference and orphaned tool override are all cleaned', () => {
  const calls = fetchCalls.filter((item) => String(item.url).endsWith('/save'));
  const body = JSON.parse(calls[calls.length - 1].init.body);
  if (body.sources.fofatoto !== undefined) throw new Error('group not removed from sources');
  const role = body.roles['asset-expert'];
  if (role.groups.fofatoto !== undefined) throw new Error('group reference not removed: ' + JSON.stringify(role.groups));
  if (role.tools.fofa_account !== undefined) throw new Error('orphaned tool override not cleaned: ' + JSON.stringify(role.tools));
  if (body.roles.ghost === undefined) throw new Error('orphan role entry lost after the second save');
  if (body.roles.ghost.tools.session_search !== 'off') throw new Error('unrelated ungrouped tool override was removed');
});

/* ------- save success + failed rescan must not look unsaved ------- */

inventoryShouldFail = true;
const hdcSwitch3 = nodesBy(
  (node) => hasClass(node, 'tx-switch') && String(node.props['aria-label'] || '').includes('鸿蒙设备'),
)[0];
check('final scenario: edit before saving', () => {
  if (!hdcSwitch3) throw new Error('hdc group switch not found');
  click(hdcSwitch3);
  renderOnce();
  if (!texts().includes('有未保存的修改')) throw new Error('edit did not mark the draft dirty');
});

const saveButton3 = nodesBy(
  (node) => node.type === 'button' && Array.isArray(node.children) && node.children.includes('保存'),
).find((node) => hasClass(node, 'tx-btnPrimary'));
check('final scenario: save button available', () => {
  if (!saveButton3) throw new Error('save button not found');
  if (saveButton3.props.disabled === true) throw new Error('save button disabled');
});
click(saveButton3);
await settleLong(3600);

check('save success + failed rescan: saved state wins, no unsaved marker, save disabled', () => {
  const list = texts();
  if (!list.includes('已保存，新建会话生效。')) throw new Error('missing saved notice');
  if (list.includes('有未保存的修改')) throw new Error('contradictory unsaved marker after a successful save');
  const save = nodesBy(
    (node) => node.type === 'button' && Array.isArray(node.children) && node.children.includes('保存'),
  ).find((node) => hasClass(node, 'tx-btnPrimary'));
  if (save && save.props.disabled !== true) throw new Error('save button should be disabled after a successful save');
});
inventoryShouldFail = false;

/* ---------- total match length is validated before POST ---------- */

const matchInput = nodesBy(
  (node) => node.type === 'input' && node.props && node.props.placeholder === '工具名或通配符（*）',
)[0];
check('final scenario: manage match input found', () => {
  if (!matchInput) throw new Error('manage match input not found');
});
if (matchInput) {
  const hugeMatch = Array.from({ length: 17 }, () => 'a'.repeat(250)).join(',');
  matchInput.props.onChange({ target: { value: hugeMatch } });
  renderOnce();
}
const savesBefore = fetchCalls.filter((item) => String(item.url).endsWith('/save')).length;
const saveButton4 = nodesBy(
  (node) => node.type === 'button' && Array.isArray(node.children) && node.children.includes('保存'),
).find((node) => hasClass(node, 'tx-btnPrimary'));
check('final scenario: oversized total match blocks the save with an inline reason', () => {
  if (!saveButton4) throw new Error('save button not found');
  click(saveButton4);
  renderOnce();
  const list = texts();
  if (!list.some((text) => text.includes('匹配项过长'))) throw new Error('missing match-length notice');
  const savesAfter = fetchCalls.filter((item) => String(item.url).endsWith('/save')).length;
  if (savesAfter !== savesBefore) throw new Error('oversized match should not be POSTed');
});

/* --------------------- automatic provider groups --------------------- */

async function mountInventory(payload) {
  for (const slot of hookSlots) if (typeof slot?.cleanup === 'function') slot.cleanup();
  hookSlots.length = 0;
  currentInventory = payload;
  inventoryShouldFail = false;
  renderOnce();
  await settle();
}

const automaticCatalogs = {
  reviewer: [
    { name: 'read', description: 'Read documents', provider: { plugin: '@deepseek-ai/dsh-tool-files', official: true } },
    { name: 'write', description: 'Write documents', provider: { plugin: '@deepseek-ai/dsh-tool-edit', official: true } },
    { name: 'same_prefix_a', description: 'Notes', provider: { plugin: '@vendor/notes', official: false } },
    { name: 'same_prefix_b', description: 'Calendar', provider: { plugin: '@vendor/calendar', official: false } },
    { name: 'unattributed', description: 'No Loader identity', provider: null },
  ],
  researcher: [
    { name: 'read', description: 'Other implementation', provider: { plugin: '@vendor/notes', official: false } },
  ],
};
async function automaticInventory(catalogs, config = Host.normalizeConfig({})) {
  const presets = { list: async () => Object.keys(catalogs).map((id, order) => ({ id, order, name: id === 'reviewer' ? '审阅者' : '研究员' })) };
  return Host.buildInventory({
    tools: { toolCatalog: () => [], presetToolCatalog: async (_presets, id) => catalogs[id] },
    get(name) {
      if (name === 'agentPresets') return presets;
      if (name === 'configEditor') return { edit() {} };
      return undefined;
    },
  }, config);
}
function groupNames() {
  return nodesBy((node) => hasClass(node, 'tx-groupName')).map((node) => node.children.join(''));
}
function namedSwitch(label) {
  return nodesBy((node) => hasClass(node, 'tx-switch') && String(node.props['aria-label'] || '').startsWith(label))[0];
}
function currentSaveButton() {
  return nodesBy((node) => node.type === 'button' && hasClass(node, 'tx-btnPrimary') && node.children.includes('保存'))[0];
}
function lastSavedDraft() {
  const calls = fetchCalls.filter((call) => String(call.url).endsWith('/save'));
  return JSON.parse(calls[calls.length - 1].init.body);
}

await mountInventory(await automaticInventory(automaticCatalogs));
check('automatic: one official group, distinct actual plugins, and an honest unknown group', () => {
  const names = groupNames();
  if (JSON.stringify(names) !== JSON.stringify(['官方工具', '@vendor/calendar', '@vendor/notes', '来源未知'])) {
    throw new Error('wrong automatic groups: ' + JSON.stringify(names));
  }
  if (currentSaveButton().props.disabled !== true) throw new Error('fresh installation should not be dirty');
  if (!namedSwitch('按提供插件自动分组').props['aria-checked']) throw new Error('automatic discovery should be on');
  if (!texts().some((text) => text.includes('可见 5/5'))) throw new Error('reviewer count wrong');
  if (!texts().some((text) => text.includes('可见 1/1'))) throw new Error('other role count wrong');
});
click(nodesBy((node) => hasClass(node, 'tx-groupMain'))[0]);
renderOnce();
check('automatic: official tool rows show their individual providing plugins', () => {
  const list = texts();
  if (!list.includes('read') || !list.includes('write')) throw new Error('official tools missing');
  for (const label of ['提供插件：@deepseek-ai/dsh-tool-files', '提供插件：@deepseek-ai/dsh-tool-edit']) {
    if (!list.includes(label)) throw new Error('missing source label: ' + label);
  }
});
click(namedSwitch('官方工具 ·'));
renderOnce();
const otherCard = nodesBy((node) => hasClass(node, 'tx-roleCard'))[1];
click(otherCard);
renderOnce();
check('automatic: switching presets changes same-named tool ownership without leaking other tools', () => {
  if (JSON.stringify(groupNames()) !== JSON.stringify(['@vendor/notes'])) throw new Error('other role groups are wrong');
  if (texts().includes('write')) throw new Error('other preset tool leaked');
});
click(nodesBy((node) => hasClass(node, 'tx-roleCard'))[0]);
renderOnce();
click(currentSaveButton());
await settle();
check('automatic: save persists stable group policies without freezing discovered tool lists', () => {
  const body = lastSavedDraft();
  if (body.discovery !== true) throw new Error('discovery flag missing');
  if (Object.keys(body.sources).length !== 0) throw new Error('automatic groups must not become custom sources');
  if (body.roles.reviewer.groups['@official'] !== 'off') throw new Error('official group policy lost');
  if (body.roles.researcher !== undefined) throw new Error('untouched preset policy materialized');
});

const manageAutomatic = nodesBy((node) => node.type === 'button' && node.children.includes('管理工具组'))[0];
click(manageAutomatic);
renderOnce();
function addCustomGroup(id, label, pattern) {
  click(nodesBy((node) => node.type === 'button' && node.children.includes('添加工具组'))[0]);
  renderOnce();
  const form = nodesBy((node) => node.type === 'form' && hasClass(node, 'tx-addForm'))[0];
  const inputs = [];
  walk(form, (item) => { if (item.node?.type === 'input') inputs.push(item.node); });
  for (const [index, value] of [id, label, pattern].entries()) inputs[index].props.onChange({ target: { value } });
  renderOnce();
  const readyForm = nodesBy((node) => node.type === 'form' && hasClass(node, 'tx-addForm'))[0];
  readyForm.props.onSubmit({ preventDefault() {} });
  renderOnce();
}
addCustomGroup('all', '自定义全部', '*');
check('automatic: a custom wildcard keeps official tools in their dedicated group', () => {
  if (JSON.stringify(groupNames()) !== JSON.stringify(['官方工具', '自定义全部'])) throw new Error('wildcard swallowed official group');
});
click(nodesBy((node) => hasClass(node, 'tx-groupMain'))[1]);
renderOnce();
click(namedSwitch('same_prefix_a'));
renderOnce();
addCustomGroup('subset', '子集', 'same_prefix_a');
click(currentSaveButton());
await settle();
check('automatic: adding a custom group before a wildcard matches the Host policy', () => {
  const body = lastSavedDraft();
  if (JSON.stringify(Object.keys(body.sources)) !== JSON.stringify(['subset', 'all'])) throw new Error('new group hidden behind wildcard');
  const config = Host.normalizeConfig(body);
  const catalog = automaticCatalogs.reviewer;
  const index = Host.buildToolIndex(config, catalog.map((tool) => tool.name), catalog);
  const policy = Host.resolveRolePolicy(config, 'reviewer', index);
  if (JSON.stringify([...policy.hidden]) !== JSON.stringify(['read', 'write', 'same_prefix_a'])) {
    throw new Error('Host/client policies differ: ' + JSON.stringify([...policy.hidden]));
  }
});
click(nodesBy((node) => node.type === 'button' && node.props['aria-label'] === '删除工具组 子集')[0]);
renderOnce();
click(nodesBy((node) => node.type === 'button' && node.props['aria-label'] === '删除工具组 自定义全部')[0]);
renderOnce();
click(currentSaveButton());
await settle();
check('automatic: removing custom groups preserves per-tool restrictions in detected groups', () => {
  const body = lastSavedDraft();
  if (Object.keys(body.sources).length !== 0) throw new Error('custom groups were not removed');
  if (body.roles.reviewer.tools.same_prefix_a !== 'off') throw new Error('per-tool policy was widened during regrouping');
  if (!groupNames().includes('@vendor/notes')) throw new Error('provider group did not return');
});

await mountInventory(await automaticInventory({ reviewer: [] }));
check('automatic: an empty installation has a normal empty state and no invented tools', () => {
  if (groupNames().length !== 0) throw new Error('invented groups in empty installation');
  if (!texts().includes('此角色暂无可管理的工具。')) throw new Error('empty state missing');
  if (currentInventory.diagnostics.length !== 0) throw new Error('empty installation should not warn');
  if (currentSaveButton().props.disabled !== true) throw new Error('empty initial page is dirty');
});

await mountInventory(await automaticInventory(automaticCatalogs, Host.normalizeConfig({
  discovery: false, sources: {}, roles: { reviewer: { mode: 'allow' } },
})));
check('scope preview: legacy mode starts with the global-only catalog', () => {
  if (groupNames().length !== 0) throw new Error('preset tools should not be managed in manual mode');
});
click(namedSwitch('按提供插件自动分组'));
renderOnce();
check('scope preview: enabling discovery shows inherited official tools before saving', () => {
  if (!groupNames().includes('官方工具')) throw new Error('inherited tools missing before save');
  if (namedSwitch('官方工具 ·').props['aria-checked'] !== false) throw new Error('allow-list preview should show official tools hidden');
  if (!texts().some((text) => text.includes('可见 0/5'))) throw new Error('newly managed tools absent from preview count');
});
click(namedSwitch('按提供插件自动分组'));
renderOnce();
check('scope preview: disabling discovery removes inherited tools before saving', () => {
  if (groupNames().length !== 0) throw new Error('inherited tools leaked into global-only preview');
  if (currentSaveButton().props.disabled !== true) throw new Error('round trip should return to clean state');
});

/* -------------------- preset display copy and stable ids -------------------- */

const displayRoster = [
  { id: 'standard', order: 1 }, { id: 'ptc', order: 2 }, { id: 'minimal', order: 3 }, { id: 'cordis', order: 4 },
  { id: 'custom-expert', order: 5, name: '自定义专家', description: '用户自己编写的说明' },
];
const displayInventory = await Host.buildInventory({
  tools: { toolCatalog: () => [], presetToolCatalog: async () => [
    { name: 'read', provider: { plugin: '@deepseek-ai/dsh-tool-fs', official: true } },
  ] },
  get(name) {
    if (name === 'agentPresets') return { list: async () => displayRoster };
    if (name === 'configEditor') return { edit() {} };
  },
}, Host.normalizeConfig({}));
await mountInventory(displayInventory);
check('preset display: localized built-in names and descriptions keep every preset id visible', () => {
  const labels = nodesBy((node) => hasClass(node, 'tx-roleName')).map((node) => node.children.join(''));
  if (JSON.stringify(labels) !== JSON.stringify(['标准模式', 'PTC 模式', '极简模式', '创造模式', '自定义专家'])) {
    throw new Error('wrong display names: ' + JSON.stringify(labels));
  }
  const ids = nodesBy((node) => node.type === 'code' && hasClass(node, 'tx-roleId')).map((node) => node.children.join(''));
  for (const { id } of displayRoster) if (!ids.includes(id)) throw new Error('preset id is hidden: ' + id);
  if (!texts().some((value) => value.startsWith('用对话定制 DSH'))) throw new Error('localized description is missing');
  if (!texts().includes('用户自己编写的说明')) throw new Error('custom description was replaced');
  const description = nodesBy((node) => hasClass(node, 'tx-roleDesc') && node.children.includes('用户自己编写的说明'))[0];
  if (description?.props.title !== '用户自己编写的说明') throw new Error('role descriptions lost their full tooltip');
  if (currentSaveButton().props.disabled !== true) throw new Error('display localization changed the saved policy');
});
const roleSearchInput = () => nodesBy((node) => node.type === 'input' && node.props.placeholder === '查找角色')[0];
roleSearchInput().props.onChange({ target: { value: '创造模式' } });
renderOnce();
check('preset display: search matches the localized name and raw preset id', () => {
  if (nodesBy((node) => hasClass(node, 'tx-roleCard')).length !== 1 || !texts().includes('cordis')) {
    throw new Error('localized search did not find the creator preset');
  }
  roleSearchInput().props.onChange({ target: { value: 'ptc' } });
  renderOnce();
  if (nodesBy((node) => hasClass(node, 'tx-roleCard')).length !== 1 || !texts().includes('PTC 模式')) {
    throw new Error('id search did not find PTC');
  }
});
roleSearchInput().props.onChange({ target: { value: '' } });
renderOnce();
ctx.locale.register('settings.agentPreset', { zh: {
  presetStandardName: '宿主标准名称', presetStandardDescription: '宿主提供的模式说明',
} });
renderOnce();
check('preset display: prefer the Host locale dictionary and retain user-authored overrides', () => {
  if (!texts().includes('宿主标准名称') || !texts().includes('宿主提供的模式说明')) {
    throw new Error('Host display copy was not used');
  }
  const override = { ...displayInventory, roles: displayInventory.roles.map((role) => role.id === 'standard'
    ? { ...role, name: '团队标准', description: '团队自定义的标准预设' } : role) };
  currentInventory = override;
});
await mountInventory(currentInventory);
check('preset display: an explicit name owns its copy even for a built-in id', () => {
  if (!texts().includes('团队标准') || !texts().includes('团队自定义的标准预设')) throw new Error('authored display copy was lost');
  if (texts().includes('宿主标准名称')) throw new Error('built-in translation overwrote a custom name');
});
await mountInventory(displayInventory);
document.documentElement.lang = 'en';
renderOnce();
check('preset display: language changes localize built-ins while custom metadata stays verbatim', () => {
  const list = texts();
  for (const label of ['Standard mode', 'PTC mode', 'Minimal mode', 'Creator mode', '自定义专家', '用户自己编写的说明']) {
    if (!list.includes(label)) throw new Error('missing localized/custom text: ' + label);
  }
  if (!groupNames().includes('Official tools') || groupNames().includes('官方工具')) {
    throw new Error('automatic group names did not follow the locale change');
  }
});
document.documentElement.lang = 'zh-CN';

componentProps = registrations[0].options.inject();
componentProps.memory.snapshot = null;
componentProps.memory.awaitingSnapshot = null;
const artworkInventory = await automaticInventory(automaticCatalogs);
const pluginIcon = 'data:image/png;base64,iVBORw0KGgo=';
artworkInventory.providerMetadata = [
  { title: { en: 'Shared notes', zh: '共享笔记' }, icon: pluginIcon },
  { title: { en: 'File reader', zh: '文件读取' }, icon: pluginIcon },
];
for (const tools of Object.values(artworkInventory.roleTools)) {
  for (const tool of tools) {
    if (tool.provider?.plugin === '@vendor/notes') tool.provider = { ...tool.provider, packageMeta: 0 };
    if (tool.provider?.plugin === '@deepseek-ai/dsh-tool-files') tool.provider = { ...tool.provider, packageMeta: 1 };
  }
}
await mountInventory(artworkInventory);
const noteGroup = () => nodesBy((node) => hasClass(node, 'tx-groupMain')).find((node) =>
  node.children.some((child) => child?.children?.some((item) => item?.children?.includes('共享笔记'))));
check('provider display: group uses the plugin title and icon with a package fallback', () => {
  if (!groupNames().includes('共享笔记') || !groupNames().includes('@vendor/calendar')) throw new Error('incorrect display or fallback');
  const images = [];
  walk(noteGroup(), ({ node }) => { if (node?.type === 'img') images.push(node); });
  if (images.length !== 1 || images[0].props.src !== pluginIcon || images[0].props.alt !== '') throw new Error('group artwork missing');
  if (currentSaveButton().props.disabled !== true) throw new Error('display metadata changed the policy');
});
click(nodesBy((node) => hasClass(node, 'tx-groupMain'))[0]);
renderOnce();
check('provider display: official tools keep their own localized provider underneath the aggregate', () => {
  if (!texts().includes('官方工具') || !texts().includes('提供插件：文件读取')) throw new Error('official tool provider missing');
});
nodesBy((node) => node.type === 'input' && node.props.placeholder === '搜索工具、插件或描述')[0]
  .props.onChange({ target: { value: '共享笔记' } });
renderOnce();
check('provider display: localized names are searchable alongside stable package ids', () => {
  if (JSON.stringify(groupNames()) !== JSON.stringify(['共享笔记'])) throw new Error('localized plugin search did not match the group');
  const search = nodesBy((node) => node.type === 'input' && node.props.placeholder === '搜索工具、插件或描述')[0];
  search.props.onChange({ target: { value: '@vendor/notes' } });
  renderOnce();
  if (JSON.stringify(groupNames()) !== JSON.stringify(['共享笔记'])) throw new Error('package id is no longer searchable');
});
document.documentElement.lang = 'en';
renderOnce();
check('provider display: an installed plugin title follows the UI language', () => {
  if (!groupNames().includes('Shared notes')) throw new Error('provider title did not change with the locale');
});
document.documentElement.lang = 'zh-CN';

/* ---------------- sidebar navigation, filters, and in-flight saves ---------------- */

componentProps = registrations[0].options.inject();
componentProps.memory.snapshot = null;
await mountInventory(await automaticInventory(automaticCatalogs));
const queryInput = () => nodesBy((node) => node.type === 'input' && node.props.placeholder === '搜索工具、插件或描述')[0];
const officialDisclosure = () => nodesBy((node) => hasClass(node, 'tx-groupMain'))[0];
click(officialDisclosure());
renderOnce();
queryInput().props.onChange({ target: { value: 'read' } });
renderOnce();
click(officialDisclosure());
renderOnce();
queryInput().props.onChange({ target: { value: '' } });
renderOnce();
check('search: clearing the filter restores the unfiltered group expansion', () => {
  if (officialDisclosure().props['aria-expanded'] !== true || !texts().includes('write')) {
    throw new Error('the temporary collapse replaced the unfiltered expansion');
  }
});
queryInput().props.onChange({ target: { value: 'read' } });
renderOnce();
check('search: matching tools are shown without changing the policy', () => {
  if (!texts().includes('read') || texts().includes('write')) throw new Error('tool search did not narrow the rows');
  if (currentSaveButton().props.disabled !== true) throw new Error('search made the policy dirty');
  if (!texts().includes('匹配 1 个工具')) throw new Error('matching count is wrong');
});
click(namedSwitch('官方工具 ·'));
renderOnce();
check('search: a group switch still changes every tool in the group', () => {
  if (!texts().some((value) => value.includes('可见 3/5'))) throw new Error('group toggle affected only the filtered tool');
  if (!texts().includes('整组开关作用于全组')) throw new Error('operation scope is not explained');
});
const readsBeforeReturn = fetchCalls.filter((call) => String(call.url).endsWith('/inventory')).length;
click(nodesBy((node) => node.type === 'button' && node.children.includes('返回会话'))[0]);
await mountInventory(currentInventory);
check('navigation: returning to the conversation and reopening keeps the draft and search', () => {
  if (panelSelections.at(-1) !== null) throw new Error('return did not select the conversation');
  if (queryInput().props.value !== 'read') throw new Error('search was not restored');
  if (!texts().includes('有未保存的修改')) throw new Error('unsaved draft was lost');
  if (namedSwitch('官方工具 ·').props['aria-checked'] !== false) throw new Error('group policy was lost');
  if (fetchCalls.filter((call) => String(call.url).endsWith('/inventory')).length !== readsBeforeReturn) {
    throw new Error('reopening replaced the unsaved draft with an inventory fetch');
  }
});

let releaseSave;
saveGate = new Promise((resolve) => { releaseSave = resolve; });
click(currentSaveButton());
await settle();
click(nodesBy((node) => node.type === 'button' && node.children.includes('返回会话'))[0]);
await mountInventory(currentInventory);
check('navigation: reopening during a save keeps the pending request locked', () => {
  const saving = currentSaveButton();
  if (saving?.props.disabled !== true || saving.props['aria-busy'] !== true || !texts().includes('保存中…')) {
    throw new Error('pending save is not represented with the original action label');
  }
});
releaseSave();
saveGate = null;
await settle();
check('navigation: a save completed after leaving settles the reopened page correctly', () => {
  if (texts().includes('有未保存的修改')) throw new Error('completed save still shows a dirty draft');
  if (!texts().includes('已保存，新建会话生效。')) throw new Error('save feedback was lost');
  if (nodesBy((node) => hasClass(node, 'tx-feedback')).length !== 1) throw new Error('feedback is not outside the scrolling workspace');
  if (!nodesBy((node) => hasClass(node, 'tx-notice') && node.props['data-tone'] === 'ok').length) {
    throw new Error('success toast is missing');
  }
  if (currentSaveButton().props.disabled !== true) throw new Error('save did not become clean');
  const config = Host.normalizeConfig(lastSavedDraft());
  const catalog = automaticCatalogs.reviewer;
  const index = Host.buildToolIndex(config, catalog.map((tool) => tool.name), catalog);
  if (JSON.stringify([...Host.resolveRolePolicy(config, 'reviewer', index).hidden]) !== JSON.stringify(['read', 'write'])) {
    throw new Error('saved group restriction differs from the complete group');
  }
});

componentProps.memory.snapshot = null;
componentProps.memory.awaitingSnapshot = null;
await mountInventory(await automaticInventory(automaticCatalogs));
click(namedSwitch('官方工具 ·'));
renderOnce();
saveGate = new Promise((resolve) => { releaseSave = resolve; });
click(currentSaveButton());
await settle();
click(nodesBy((node) => node.type === 'button' && node.children.includes('返回会话'))[0]);
for (const slot of hookSlots) if (typeof slot?.cleanup === 'function') slot.cleanup();
hookSlots.length = 0;
releaseSave();
saveGate = null;
await settle();
const readsBeforeCompletedReturn = fetchCalls.filter((call) => String(call.url).endsWith('/inventory')).length;
await mountInventory(currentInventory);
await settleLong(900);
check('navigation: reopening after a save completed rejects old Host inventory', () => {
  if (componentProps.memory.pendingSave) throw new Error('save should already have completed');
  if (!componentProps.memory.awaitingSnapshot) throw new Error('unconfirmed saved version was discarded');
  if (namedSwitch('官方工具 ·').props['aria-checked'] !== false) throw new Error('old inventory reverted the saved group policy');
  if (texts().includes('有未保存的修改')) throw new Error('confirmed write should remain clean');
  if (fetchCalls.filter((call) => String(call.url).endsWith('/inventory')).length <= readsBeforeCompletedReturn) {
    throw new Error('reopening did not retry the Host read');
  }
});
click(nodesBy((node) => node.type === 'button' && node.children.includes('重新扫描'))[0]);
await settle();
check('navigation: a manual rescan cannot revert an unconfirmed saved snapshot', () => {
  if (!componentProps.memory.awaitingSnapshot) throw new Error('old rescan unexpectedly confirmed the saved version');
  if (namedSwitch('官方工具 ·').props['aria-checked'] !== false) throw new Error('manual rescan reverted the saved policy');
  if (texts().includes('有未保存的修改')) throw new Error('manual rescan made the saved policy dirty');
});
currentInventory = await automaticInventory(automaticCatalogs, Host.normalizeConfig(lastSavedDraft()));
await settleLong(960);
check('navigation: a matching Host revision confirms the saved snapshot', () => {
  if (componentProps.memory.awaitingSnapshot !== null) throw new Error('matching Host revision was not confirmed');
  if (namedSwitch('官方工具 ·').props['aria-checked'] !== false) throw new Error('confirmed group policy changed');
  if (texts().includes('有未保存的修改')) throw new Error('matching refresh made the policy dirty');
});
queryInput().props.onChange({ target: { value: 'read' } });
renderOnce();
click(namedSwitch('read'));
renderOnce();
check('navigation: unsaved drafts warn before closing the entire browser page', () => {
  let prevented = false;
  const event = { preventDefault() { prevented = true; }, returnValue: undefined };
  windowListeners.get('beforeunload')?.(event);
  if (!prevented || event.returnValue !== '') throw new Error('draft close warning missing');
});

componentProps.memory.snapshot = null;
componentProps.memory.awaitingSnapshot = null;
const startingInventory = await automaticInventory(automaticCatalogs);
await mountInventory(startingInventory);
click(namedSwitch('官方工具 ·'));
renderOnce();
const savedInventory = await automaticInventory(automaticCatalogs, Host.normalizeConfig({
  roles: { reviewer: { mode: 'open', groups: { '@official': 'off' } } },
}));
saveResult = { status: 200, body: { ok: true, saved: true, configVersion: savedInventory.configVersion } };
click(currentSaveButton());
await settle();
check('saving: a version-aware draft submits the revision it was based on', () => {
  if (lastSavedDraft().configVersion !== startingInventory.configVersion) throw new Error('base revision missing');
});

let releaseInventory;
inventoryGate = new Promise((resolve) => { releaseInventory = resolve; });
click(nodesBy((node) => node.type === 'button' && node.children.includes('重新扫描'))[0]);
await settleLong(960);
inventoryGate = null;
const refreshed = { ...savedInventory, roles: savedInventory.roles.toReversed() };
releaseInventory(refreshed);
await settle();
check('saving: a background confirmation cannot cancel a later manual rescan', () => {
  if (componentProps.memory.awaitingSnapshot !== null) throw new Error('manual rescan did not confirm the saved revision');
  if (componentProps.memory.snapshot.inventory !== refreshed) throw new Error('manual inventory response was ignored');
  if (!texts().includes('工具清单已更新。')) throw new Error('rescan completion feedback missing');
});

click(namedSwitch('官方工具 ·'));
renderOnce();
saveResult = { status: 409, body: { ok: false, code: 'config_conflict', error: 'conflict' } };
click(currentSaveButton());
await settle();
check('saving: conflicts preserve the draft and explain how to recover', () => {
  if (lastSavedDraft().configVersion !== savedInventory.configVersion) throw new Error('last successful revision was lost');
  if (!texts().includes('有未保存的修改')) throw new Error('the conflicting draft was discarded');
  if (!texts().some((value) => value.includes('配置已在别处更新'))) throw new Error('conflict notice missing');
  if (namedSwitch('官方工具 ·').props['aria-checked'] !== true) throw new Error('conflicting edit was reverted');
});
const dismissError = nodesBy((node) => node.type === 'button' && node.props['aria-label'] === '关闭提示')[0];
click(dismissError);
renderOnce();
check('feedback: dismissing an error keeps the draft available', () => {
  if (nodesBy((node) => hasClass(node, 'tx-notice')).length !== 0) throw new Error('notice was not dismissed');
  if (currentSaveButton().props.disabled || !texts().includes('有未保存的修改')) throw new Error('dismissing the error changed the draft');
});
saveResult = null;
componentProps.memory.snapshot = null;
componentProps.memory.awaitingSnapshot = null;
const mcpBridge = { plugin: '@deepseek-ai/dsh-mcp-client', official: true };
const mcpCatalog = [
  { name: 'read', provider: { plugin: '@deepseek-ai/dsh-tool-files', official: true } },
  { name: 'mcp__ida__lookup', provider: { ...mcpBridge, mcpServer: 'ida' } },
  { name: 'mcp__notes__lookup', provider: { ...mcpBridge, mcpServer: 'notes' } },
];
await mountInventory(await automaticInventory({ reviewer: mcpCatalog }, Host.normalizeConfig({
  roles: { reviewer: { groups: { '@official': 'off' } } },
})));
check('global MCP: each server has its own visible switch', () => {
  if (JSON.stringify(groupNames()) !== JSON.stringify(['官方工具', 'ida', 'notes'])) throw new Error('server groups are missing');
  if (namedSwitch('官方工具 ·').props['aria-checked'] !== false) throw new Error('official tools should be hidden');
  if (namedSwitch('ida ·').props['aria-checked'] !== true || namedSwitch('notes ·').props['aria-checked'] !== true) {
    throw new Error('server switches did not use the role baseline');
  }
});
click(namedSwitch('ida ·'));
renderOnce();
click(currentSaveButton());
await settle();
check('global MCP: saving one server switch only affects tools in that group', () => {
  const body = lastSavedDraft();
  if (body.roles.reviewer.groups['@mcp/ida'] !== 'off' || body.roles.reviewer.groups['@mcp/notes'] !== undefined) {
    throw new Error('wrong server group overrides');
  }
  if (namedSwitch('notes ·').props['aria-checked'] !== true) throw new Error('another server changed');
});
for (const slot of hookSlots) if (typeof slot?.cleanup === 'function') slot.cleanup();
activePanelId = 'dsh-tool-exposure';
for (const cleanup of cleanups.toReversed()) cleanup();
check('disposal: unloading closes the owned panel and removes navigation listeners', () => {
  if (activePanelId !== null) throw new Error('unloading left a blank active panel');
  if (windowListeners.size !== 0) throw new Error('navigation listeners leaked');
});

/* ---------------------------- result ---------------------------- */

console.log('---');
console.log('style tags:', styleTags.length, '| fetch calls:', fetchCalls.length);
if (failures.length > 0) {
  console.log(failures.length + ' FAILURE(S)');
  for (const failure of failures) console.log(' *', failure.name, '->', failure.error && failure.error.stack ? failure.error.stack : failure.error);
  process.exitCode = 1;
} else {
  console.log('ALL CHECKS PASSED');
}
