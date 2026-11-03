/**
 * Smoke test for tool-exposure/client.js — loads the real bundle under a stub
 * module loader, a mini React hooks runtime, and a fake fetch, then renders the
 * settings page and exercises the core interactions.
 *
 * Run: node this-file.mjs
 */
import { readFileSync } from 'node:fs';

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
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
globalThis.window = {
  __ModuleLoader__: { load(def) { moduleDef = def; } },
  confirm: () => true,
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
    ghost: { mode: 'open', groups: { hdc: 'off' }, tools: { hms_build: 'on' } },
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
let inventoryShouldFail = false;
globalThis.fetch = async (url, init) => {
  fetchCalls.push({ url, init });
  const json = (payload, status = 200) => ({ ok: status < 400, status, json: async () => payload });
  if (String(url).endsWith('/inventory')) {
    if (inventoryShouldFail) return json({ ok: false, error: 'boom' }, 500);
    return json(INVENTORY);
  }
  if (String(url).endsWith('/save')) return json({ ok: true, saved: true, appliedTo: 'new-sessions' });
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
function makeContext() {
  const dictionaries = {};
  return {
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
          if (dict && dict.zh && typeof dict.zh[key] === 'string') return dict.zh[key];
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

function renderOnce() {
  dirty = false;
  hookCursor = 0;
  pendingEffects = [];
  tree = component({});
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

check('registration: one settings.section entry with id/order/label', () => {
  if (registrations.length !== 1) throw new Error('expected 1 registration, got ' + registrations.length);
  const { options } = registrations[0];
  if (options.name !== 'settings.section') throw new Error('bad slot name: ' + options.name);
  if (options.id !== 'tool-exposure') throw new Error('bad id: ' + options.id);
  if (options.order !== 25) throw new Error('bad order: ' + options.order);
  if (typeof options.label !== 'function' || options.label() !== '工具暴露') throw new Error('bad label: ' + options.label());
  if (typeof registrations[0].Component !== 'function') throw new Error('no component');
});

check('stylesheet injected', () => {
  if (styleTags.length !== 1) throw new Error('expected 1 style tag, got ' + styleTags.length);
  if (!styleTags[0].textContent.includes('.tx-page')) throw new Error('css missing .tx-page');
});

component = registrations[0].Component;

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
  // baseline segmented has no switches; group rows have 2 switches + global none + manage none
  if (switches.length !== 2) throw new Error('expected 2 switches, got ' + switches.length);
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
  if (switches.length !== 4) throw new Error('expected 4 switches after expand, got ' + switches.length);
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
  (node) => node.type === 'input' && node.props && node.props.placeholder === 'fofa_*, hms_*',
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
