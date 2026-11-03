/**
 * Static consistency checks for the tool-exposure bundle.
 *
 * Catches the boring-but-real class of bugs that unit tests miss:
 *   - locale keys used in code but missing from one language
 *   - CSS classes referenced by the component but never defined (unstyled UI)
 *   - CSS classes defined but unreachable from the component (dead styles)
 *   - accidental JSX / extra requires / literal colors / missing guard headers
 *   - Host manifest shape (apply/inject/name, __test surface)
 *
 * Run: node test/static-checks.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const clientSource = readFileSync(join(ROOT, 'client.js'), 'utf8');
const hostSource = readFileSync(join(ROOT, 'index.js'), 'utf8');

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
function ok(condition, label) {
  if (!condition) throw new Error(label || 'assertion failed');
}
function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label || 'value'}: got ${a}, want ${b}`);
}

/* --------------------------- client: locale ---------------------------- */

function dictKeys(source, lang) {
  const start = source.indexOf('const DICT = {');
  const end = source.indexOf('\n    };', start);
  ok(start >= 0 && end > start, 'DICT block not found');
  const body = source.slice(start, end);
  const marker = `\n      ${lang}: {`;
  const langStart = body.indexOf(marker);
  ok(langStart >= 0, `${lang} dict block not found`);
  const after = body.slice(langStart + marker.length);
  // stop at the next language section, so a key missing from one language is detected
  const nextLang = after.search(/\n      [a-z]{2}: \{/);
  const section = nextLang >= 0 ? after.slice(0, nextLang) : after;
  const keys = new Set();
  for (const match of section.matchAll(/^        ([A-Za-z0-9_]+):/gm)) keys.add(match[1]);
  return keys;
}

const usedKeys = new Set([...clientSource.matchAll(/\bt\('([^']+)'\)/g)].map((match) => match[1]));
const enKeys = dictKeys(clientSource, 'en');
const zhKeys = dictKeys(clientSource, 'zh');

check('locale: every t() key exists in en and zh', () => {
  const missingEn = [...usedKeys].filter((key) => !enKeys.has(key));
  const missingZh = [...usedKeys].filter((key) => !zhKeys.has(key));
  ok(missingEn.length === 0, `missing en: ${missingEn.join(', ')}`);
  ok(missingZh.length === 0, `missing zh: ${missingZh.join(', ')}`);
});

check('locale: en and zh define the same key set', () => {
  const onlyEn = [...enKeys].filter((key) => !zhKeys.has(key));
  const onlyZh = [...zhKeys].filter((key) => !enKeys.has(key));
  ok(onlyEn.length === 0, `only en: ${onlyEn.join(', ')}`);
  ok(onlyZh.length === 0, `only zh: ${onlyZh.join(', ')}`);
});

/* ---------------------------- client: CSS ----------------------------- */

const cssStart = clientSource.indexOf('const CSS = `');
const cssEnd = clientSource.indexOf('`;', cssStart);
ok(cssStart >= 0 && cssEnd > cssStart, 'CSS template not found');
const css = clientSource.slice(cssStart, cssEnd);
const cssClasses = new Set([...css.matchAll(/\.(tx-[a-zA-Z0-9_-]+)/g)].map((match) => match[1]));

const jsClasses = new Set();
for (const match of clientSource.matchAll(/className: '([^']+)'/g)) {
  for (const token of match[1].split(/\s+/)) if (token.startsWith('tx-')) jsClasses.add(token);
}

check('css: every class used by the component is defined', () => {
  const missing = [...jsClasses].filter((name) => !cssClasses.has(name));
  ok(missing.length === 0, `unstyled classes: ${missing.join(', ')}`);
});

check('css: no dead tx- classes', () => {
  const dead = [...cssClasses].filter((name) => !jsClasses.has(name));
  ok(dead.length === 0, `unused css classes: ${dead.join(', ')}`);
});

check('css: no literal colors (theme tokens only)', () => {
  const literals = [...css.matchAll(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/g)].map((match) => match[0]);
  ok(literals.length === 0, `literal colors: ${literals.join(', ')}`);
});

/* ------------------------ client: module contract ---------------------- */

check('client: module loader id matches the package', () => {
  ok(clientSource.includes("window.__ModuleLoader__.load({"), 'missing module loader');
  ok(clientSource.includes("id: 'dsh-tool-exposure'"), 'module id mismatch');
});

check('client: no JSX and only react is required', () => {
  ok(!/<[A-Z][A-Za-z]+[\s/>]/.test(clientSource), 'JSX found');
  const requires = [...clientSource.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((match) => match[1]);
  ok(requires.length === 1 && requires[0] === 'react', `requires: ${requires.join(', ')}`);
});

check('client: every request carries the guard header', () => {
  ok(clientSource.includes("'x-dsh-tool-exposure-plugin'"), 'guard header missing');
  ok(clientSource.includes("cache: 'no-store'"), 'cache no-store missing');
});

check('client: settings.section registration options', () => {
  ok(clientSource.includes("name: 'settings.section'"), 'slot name');
  ok(clientSource.includes("id: 'tool-exposure'"), 'slot id');
  ok(clientSource.includes('order: 25'), 'slot order');
  ok(clientSource.includes("label: () => t('nav')"), 'slot label');
});

check('client: exposes no global state outside the module wrapper', () => {
  ok(!/globalThis\.[A-Za-z]+\s*=/.test(clientSource), 'global assignment found');
  ok(!/document\.body/.test(clientSource), 'document.body usage found');
});

/* -------------------------- host: manifest ----------------------------- */

check('host: plugin export shape', () => {
  ok(hostSource.includes('export function apply('), 'apply export');
  ok(hostSource.includes("export const inject = ['tools']"), 'inject export');
  ok(hostSource.includes('export const name ='), 'name export');
});

check('host: __test surface covers the tested helpers', () => {
  for (const key of [
    'applyAgentPolicy',
    'buildInventory',
    'liftAllRestrictions',
    'normalizeDraft',
    'resolveRolePolicy',
    'resyncUnstarted',
  ]) {
    ok(hostSource.includes(key), `__test missing ${key}`);
  }
});

check('host: no accidental process/session mutations', () => {
  ok(!/process\.exit/.test(hostSource), 'process.exit found');
  ok(!/session\.append|sessions\.create/.test(hostSource), 'session mutation found');
});

/* ------------------------- manifest / parity --------------------------- */

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const patchText = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8');

check('manifest: package.json declares the bundle and client halves', () => {
  eq(pkg.name, 'dsh-tool-exposure', 'package name');
  eq(pkg.exports['.'], './index.js', 'host export');
  eq(pkg.exports['./client'], './client.js', 'client export');
  eq(pkg.dsh.bundle.patch, './cordis.patch.yml', 'bundle patch');
  eq(pkg.dsh.client.platform, 'web', 'client platform');
  ok(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-settings-general'), 'settings inject');
});

check('manifest: cordis.patch.yml row matches the package', () => {
  ok(patchText.includes('id: tool-exposure'), 'row id');
  ok(patchText.includes("name: 'dsh-tool-exposure'"), 'row name');
  ok(patchText.includes('unlisted: open'), 'default unlisted');
  ok(patchText.includes('fofa_*'), 'default sources');
});

check('contract parity: route prefix / guard / source-id pattern / match limits', () => {
  const prefix = hostSource.match(/const ROUTE_PREFIX = '([^']+)'/);
  const guard = hostSource.match(/const GUARD_HEADER = '([^']+)'/);
  ok(prefix !== null && guard !== null, 'host constants found');
  ok(clientSource.includes(`'${prefix[1]}/inventory'`), 'client inventory route');
  ok(clientSource.includes(`'${prefix[1]}/save'`), 'client save route');
  ok(clientSource.includes(`'${prefix[1]}/reset'`), 'client reset route');
  ok(clientSource.includes(guard[1]), 'client guard header');
  const sourceId = '/^[a-z][a-z0-9-]{0,31}$/';
  ok(hostSource.includes(`SOURCE_ID_PATTERN = ${sourceId}`), 'host source id pattern');
  ok(clientSource.includes(`SOURCE_ID_PATTERN = ${sourceId}`), 'client source id pattern');
  const limits = (source) => ({
    item: source.match(/MAX_MATCH_ITEM_LENGTH = (\d+)/)?.[1],
    total: source.match(/MAX_MATCH_TOTAL_LENGTH = (\d+)/)?.[1],
  });
  eq(limits(hostSource), limits(clientSource), 'match limits parity');
  ok(limits(hostSource).item !== undefined, 'match limits found');
});

/* ------------------------------- result -------------------------------- */

console.log('---');
console.log('locale keys:', usedKeys.size, '| css classes:', cssClasses.size, '| js classes:', jsClasses.size);
if (failures > 0) {
  console.log(failures + ' FAILURE(S)');
  process.exitCode = 1;
} else {
  console.log('ALL STATIC CHECKS PASSED');
}
