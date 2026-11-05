/**
 * Read-only status projection and the client bundle contract (`UI-*`).
 *
 * The panel is a browser-side reader of `status.json`, so its field names are a
 * contract between two sides that never run together. These tests pin the
 * document shape here, where it can be built, and pin the client bundle's
 * registration form, where it can be read.
 * @module file-maid/test/ui
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createRoots } from '../src/runtime/roots.js';
import { seed } from './helpers.js';

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Build a context stub with the services this plugin reads.
 * @returns {object} the stub context.
 */
function stubContext() {
  return {
    get(name) {
      if (name === 'workingDirectory') return { get: (session) => session?.header?.cwd };
      if (name === 'permissionPresets') return { current: () => 'workspace-write' };
      return undefined;
    },
    tools: { register: () => () => {} },
    systemPrompt: { context: () => () => {} },
    on: () => () => {},
    effect: (fn) => fn(),
    sessions: { get: () => ({ deriveMessages: () => [] }) },
  };
}

/**
 * Create a workspace-shaped root.
 * @returns {Promise<string>} absolute root.
 */
async function makeRoot() {
  const root = await mkdtemp(join(tmpdir(), 'maid-ui-'));
  for (const name of ['00-Specs', '10-Projects', '30-Media', '80-Outputs']) {
    await mkdir(join(root, name), { recursive: true });
  }
  return root;
}

test('UI-01 a managed scan writes the v2 status document the panel reads', async (t) => {
  const root = await makeRoot();
  const roots = createRoots({ ctx: stubContext() });
  const agent = { id: 's1', session: { header: { cwd: root } } };
  await seed(roots, agent);
  t.after(async () => {
    roots.disposeAll();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  const document = JSON.parse(await readFile(join(root, '.maid', 'status.json'), 'utf8'));
  assert.equal(document.schemaVersion, '2');
  assert.equal(document.root, root);
  assert.equal(document.catalog.state, 'MANAGED');
  assert.equal(typeof document.catalog.rootDefault, 'string');
  const first = document.catalog.dirs[0];
  assert.equal(typeof first.path, 'string');
  assert.equal(typeof first.purpose, 'string');
  assert.equal(typeof first.excludes, 'string');
  assert.equal(typeof first.excludes, 'string');
  assert.equal(typeof first.files, 'number');
  assert.equal(document.scan.baseline, true);
  assert.ok('reconcile' in document);
  assert.ok(Array.isArray(document.routes));
});

test('UI-02 an uninitialized root still projects its state', async (t) => {
  const root = await makeRoot();
  const roots = createRoots({ ctx: stubContext() });
  const agent = { id: 's2', session: { header: { cwd: root } } };
  const entry = roots.acquire(agent);
  await roots.load(entry);
  await roots.project(entry, undefined);
  t.after(async () => {
    roots.disposeAll();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  const document = JSON.parse(await readFile(join(root, '.maid', 'status.json'), 'utf8'));
  assert.equal(document.catalog.state, 'UNINITIALIZED');
  assert.deepEqual(document.catalog.dirs, []);
  assert.equal(document.routes.length, 0);
});

test('UI-03 the decision ledger reaches the panel, newest last', async (t) => {
  const root = await makeRoot();
  const roots = createRoots({ ctx: stubContext() });
  const agent = { id: 's3', session: { header: { cwd: root } } };
  const { entry } = await seed(roots, agent);
  const { appendLog } = await import('../src/state/store.js');
  await appendLog(root, 'decisions', { name: 'a.md', dir: '80-Outputs', decided_by: 'default', intent_source: 'none', overridden: false });
  await appendLog(root, 'decisions', { name: 'b.md', dir: '00-Specs', decided_by: 'rule', intent_source: 'param', overridden: true });
  await roots.project(entry, entry.lastScan);
  t.after(async () => {
    roots.disposeAll();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  const document = JSON.parse(await readFile(join(root, '.maid', 'status.json'), 'utf8'));
  assert.equal(document.routes.length, 2);
  assert.equal(document.routes[0].name, 'a.md');
  assert.equal(document.routes[1].decided_by, 'rule');
  assert.equal(document.routes[1].intent_source, 'param');
});

test('UI-04 the status file is owner-only data', async (t) => {
  const root = await makeRoot();
  const roots = createRoots({ ctx: stubContext() });
  const agent = { id: 's4', session: { header: { cwd: root } } };
  await seed(roots, agent);
  t.after(async () => {
    roots.disposeAll();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  const info = await stat(join(root, '.maid', 'status.json'));
  assert.equal(info.mode & 0o777, 0o600);
});

test('UI-05 the client bundle registers one sidebar panel under the package id', async () => {
  const body = await readFile(join(packageDir, 'src', 'client.js'), 'utf8');
  const manifest = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'));

  assert.equal(manifest.dsh.client.platform, 'web');
  assert.equal(manifest.dsh.client.immediately, true);
  assert.deepEqual(manifest.dsh.client.inject, ['@deepseek-ai/dsh-client-ui-conversation']);
  assert.equal(manifest.exports['./client'], './src/client.js');
  assert.match(body, /window\.__ModuleLoader__\.load\(\{/u);
  assert.ok(body.includes(`id: '${manifest.name}'`), 'the module id must equal the package name');
  assert.match(body, /const PANEL_ID = 'file-maid'/u);
  assert.match(body, /ctx\.slots\.inject\('main'/u);
  assert.match(body, /SegmentedTabs/u);
  assert.match(body, /data-file-maid/u);
  assert.match(body, /const NS = 'dsh-file-maid'/u);
  assert.match(body, /ctx\.locale\.register\(NS, 'zh'/u);
  assert.match(body, /ctx\.locale\.register\(NS, 'en'/u);
  assert.doesNotMatch(body, /^\s*(import|export)\s/mu, 'a client bundle is a classic script');
  assert.doesNotMatch(body, /createRoot\(\s*document\.body/u, 'the panel never mounts a root on document.body');
});

test('UI-06 the card reads the v2 projection and maps it onto its own fields', async () => {
  const body = await readFile(join(packageDir, 'src', 'client.js'), 'utf8');
  assert.match(body, /function adaptStatus\(/u);
  assert.match(body, /schemaVersion !== '2'/u);
  assert.match(body, /about: dir\.purpose/u);
  assert.match(body, /misplaced: routes\.map/u);
  assert.match(body, /loadStatus\(/u, 'the reader is still the one entry point');
});

test('UI-07 the card mounts the management endpoints', async () => {
  const body = await readFile(join(packageDir, 'src', 'client.js'), 'utf8');
  assert.match(body, /descriptorOf\('pick', \['root', 'sessionId'\]\)/u);
  assert.match(body, /descriptorOf\('save', \['root', 'sessionId', 'payload'\]\)/u);
  assert.match(body, /descriptors: MANAGE_DESCRIPTORS/u, 'the card mounts the manager');
  assert.doesNotMatch(body, /descriptorOf\('form'/u, 'the question form is gone');
  assert.doesNotMatch(body, /descriptorOf\('preview'/u);
  assert.doesNotMatch(body, /descriptorOf\('apply'/u);
  assert.match(body, /callRemote\('save'/u, 'the manager calls the one endpoint');
});

test('UI-08 the three pages are 目录 / 日志 / 扫描 in both locales', async () => {
  const body = await readFile(join(packageDir, 'src', 'client.js'), 'utf8');
  assert.match(body, /'view\.dirs': '目录'/u);
  assert.match(body, /'view\.misplaced': '日志'/u);
  assert.match(body, /'view\.scan': '扫描'/u);
  assert.match(body, /'view\.dirs': 'Directories'/u);
  assert.match(body, /'view\.misplaced': 'Log'/u);
  assert.match(body, /'section\.reconcile': '对账'/u);
  assert.match(body, /'k\.gap': '差额'/u);
});

test('UI-09 the tablist and its panel stay adjacent in the card', async () => {
  const body = await readFile(join(packageDir, 'src', 'client.js'), 'utf8');
  assert.match(body, /'role': 'tablist'|role: 'tablist'/u);
  assert.match(body, /role: 'tabpanel'/u);
});

test('UI-10 no hook selector uses prefix or substring matching', async () => {
  const body = await readFile(join(packageDir, 'src', 'client.js'), 'utf8');
  assert.doesNotMatch(body, /\[data-file-maid[\^*$~|]=/u, 'no prefix/substring attribute selector: hooks are exact tokens');
});

test('UI-32 a directory row keeps its actions inside the head line', async () => {
  const body = await readFile(join(packageDir, 'src', 'client.js'), 'utf8');
  // The actions belong to the row they change, and live on the same line as the
  // count axis instead of owning a line under the purpose.
  assert.match(body, /'data-file-maid': 'rowhead'/u);
  assert.match(body, /'data-file-maid': 'rowacts'/u);
  assert.match(body, /'data-file-maid': 'rowact'/u);
  assert.match(body, /'data-file-maid': 'rowpath'/u);
  const detail = body.slice(body.indexOf("'data-file-maid': 'tabdetail'"), body.indexOf("'data-file-maid': 'tabdetail'") + 900);
  assert.doesNotMatch(detail, /manageactions/u, 'the expanded block no longer carries the action row');
});

test('UI-33 the purpose only offers "expand" when it really overflows', async () => {
  const body = await readFile(join(packageDir, 'src', 'client.js'), 'utf8');
  assert.match(body, /-webkit-line-clamp:2/u, 'the clamped state is two lines');
  assert.match(body, /clippedDir === dir\.path && !expanded/u, 'the control is conditional on a measured overflow');
  assert.match(body, /scrollHeight - node\.clientHeight > 1/u);
  assert.match(body, /ResizeObserver/u, 'a width change re-measures');
});

test('UI-34 the count and the actions share the right edge', async () => {
  const body = await readFile(join(packageDir, 'src', 'client.js'), 'utf8');
  assert.match(body, /\[data-file-maid="rowhead"\]\{[^}]*min-width:0;/u);
  assert.match(body, /\[data-file-maid="tabcount"\]\{margin-left:auto;/u);
  assert.match(body, /\[data-file-maid="rowacts"\]\{[^}]*flex:0 0 auto;/u);
});

test('UI-35 opening the form closes the expanded row', async () => {
  const body = await readFile(join(packageDir, 'src', 'client.js'), 'utf8');
  const opener = body.slice(body.indexOf('const openManage'), body.indexOf('const openManage') + 400);
  assert.match(opener, /setOpenDir\(''\)/u);
  assert.match(opener, /setPurposeOpen\(''\)/u);
});

test('UI-36 the directory page has no native title tooltips', async () => {
  const body = await readFile(join(packageDir, 'src', 'client.js'), 'utf8');
  const card = body.slice(body.indexOf('const compactRows'), body.indexOf('const table ='));
  assert.doesNotMatch(card, /title:/u, 'the card row must not fall back to the native tooltip');
  assert.match(body, /'data-file-maid': 'morebar'/u, 'the row-count control is its own bar');
  assert.match(body, /'data-file-maid': 'ghostbutton'/u, 'the create action is a framed control');
});

test('UI-37 every t() key is present in both dictionaries', async () => {
  const body = await readFile(join(packageDir, 'src', 'client.js'), 'utf8');
  const used = new Set([...body.matchAll(/\bt\('([a-zA-Z][\w.]*)'\)/gu)].map((match) => match[1]));
  const missing = [];
  for (const key of used) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const hits = body.match(new RegExp(`(?:'${escaped}'|\\b${escaped}):`, 'gu'))?.length ?? 0;
    if (hits < 2) missing.push(`${key} (${hits})`);
  }
  assert.deepEqual(missing, [], 'a key used by the renderer must exist in zh and en');
});

test('UI-40 an unset root renders the setup entry instead of an empty body', async () => {
  const body = await readFile(join(packageDir, 'src', 'client.js'), 'utf8');
  assert.match(body, /const setupEntry = !viewsEnabled && embedded && state\.phase === 'ok' && catalogState === 'UNINITIALIZED'/u);
  assert.match(body, /viewsEnabled \|\| !embedded \|\| setupLayer !== null/u, 'the body gate must let the setup layer through');
});

test('UI-41 the add button waits for a path, a purpose and a clean check', async () => {
  const body = await readFile(join(packageDir, 'src', 'client.js'), 'utf8');
  assert.match(body, /const setupFormReady = setupPath !== '' && setupPurpose !== '' && setup\?\.problem == null && !setupDuplicate/u);
  assert.match(body, /disabled: !setupFormReady/u);
  assert.match(body, /'setup\.needFields'/u, 'the reason names the missing fields');
});

test('UI-42 a duplicate row is refused before any request', async () => {
  const body = await readFile(join(packageDir, 'src', 'client.js'), 'utf8');
  assert.match(body, /const setupDuplicate = \(setup\?\.dirs \?\? \[\]\)\.some/u);
  assert.match(body, /t\('setup\.dup'\)/u);
});

test('UI-43 the confirm screen lists the rows and states the promise', async () => {
  const body = await readFile(join(packageDir, 'src', 'client.js'), 'utf8');
  const confirm = body.slice(body.indexOf("if (step === 'confirm')"), body.indexOf("if (step === 'form')"));
  assert.match(confirm, /setupconfirmrow/u);
  assert.match(confirm, /setup\.confirmPromise/u);
  assert.match(confirm, /t\('setup\.write'\)/u);
});

test('UI-44 an existing table counts as success on the second attempt', async () => {
  const body = await readFile(join(packageDir, 'src', 'client.js'), 'utf8');
  assert.match(body, /if \(code === 'E_MAID_EXISTS'\)/u);
  assert.match(body, /step: 'done'/u);
});

test('UI-45 the setup layer closes back into the directory view', async () => {
  const body = await readFile(join(packageDir, 'src', 'client.js'), 'utf8');
  assert.match(body, /setSetup\(undefined\);\n\s+setView\('dirs'\);/u);
  assert.match(body, /setRevision\(\(count\) => count \+ 1\)/u);
});

test('UI-46 every setup hook in the renderer is also styled', async () => {
  const body = await readFile(join(packageDir, 'src', 'client.js'), 'utf8');
  const produced = new Set([...body.matchAll(/'data-file-maid': '(setup[a-z]+)'/gu)].map((match) => match[1]));
  const styled = new Set([...body.matchAll(/\[data-file-maid="(setup[a-z]+)"\]/gu)].map((match) => match[1]));
  const unstyles = [...produced].filter((hook) => !styled.has(hook));
  assert.deepEqual(unstyles, [], `hooks rendered without a rule: ${unstyles.join(', ')}`);
});

test('UI-47 the panel only uses host colour tokens', async () => {
  const body = await readFile(join(packageDir, 'src', 'client.js'), 'utf8');
  const forbidden = ['label-error', 'text-tertiary', 'state-warning-primary', 'state-focus-ring'];
  const found = forbidden.filter((name) => body.includes(`--dsw-alias-${name}`));
  assert.deepEqual(found, [], `tokens the host does not define: ${found.join(', ')}`);
});

test('UI-48 the card carries no native title on the tab strip', async () => {
  const body = await readFile(join(packageDir, 'src', 'client.js'), 'utf8');
  assert.doesNotMatch(body, /'data-file-maid': 'viewlabel', title:/u);
  const slot = body.slice(body.indexOf("'data-file-maid': 'viewslot'"), body.indexOf("'data-file-maid': 'viewslot'") + 220);
  assert.doesNotMatch(slot, /title:/u, 'the strip explains itself through its labels, not a tooltip');
});

test('UI-49 disabled tabs leave the tab order', async () => {
  const body = await readFile(join(packageDir, 'src', 'client.js'), 'utf8');
  assert.match(body, /\.\.\.\(viewsEnabled \? \{\} : \{ inert: '' \}\)/u, 'the strip is inert while the root is not managed');
  assert.doesNotMatch(body, /viewslot"\]\[data-disabled="true"\]\{[^}]*saturate/u, 'disabled tabs keep their colour, only dimmed');
});

test('UI-50 every styled hook is rendered and every rendered hook is styled', async () => {
  const body = await readFile(join(packageDir, 'src', 'client.js'), 'utf8');
  // Hooks produced by an expression, not by a literal, and the sheet's own element.
  const dynamic = new Set(['cardslot', 'page', 'tabpage', 'page-style']);
  const styled = new Set([...body.matchAll(/\[data-file-maid="([\w-]+)"\]/gu)].map((m) => m[1]));
  const rendered = new Set([...body.matchAll(/'data-file-maid': '([\w-]+)'/gu)].map((m) => m[1]));
  const deadRules = [...styled].filter((hook) => !rendered.has(hook) && !dynamic.has(hook));
  const unstyled = [...rendered].filter((hook) => !styled.has(hook) && !dynamic.has(hook));
  assert.deepEqual(deadRules, [], 'a rule without a renderer is dead weight');
  assert.deepEqual(unstyled, [], 'a rendered hook without a rule is invisible debt');
});

test('UI-51 the metrics come from the five size tiers, not from literals', async () => {
  const body = await readFile(join(packageDir, 'src', 'client.js'), 'utf8');
  const styles = body.slice(body.indexOf('const styles = h('), body.indexOf('const applyPanelLayout'));
  const literals = [...styles.matchAll(/font-size:(\d+(?:\.\d+)?px)/gu)].map((m) => m[1]);
  // The wide page keeps one 14px title on purpose; everything else rides a tier.
  assert.deepEqual(literals.filter((size) => size !== '14px'), []);
  const heights = [...styles.matchAll(/line-height:(\d+(?:\.\d+)?);/gu)].map((m) => m[1]);
  assert.deepEqual([...new Set(heights)].filter((value) => !['1', '1.3', '1.4', '1.45'].includes(value)), []);
});

test('UI-52 every disclosure controls the node it opens, and errors announce themselves', async () => {
  const body = await readFile(join(packageDir, 'src', 'client.js'), 'utf8');
  const expands = [...body.matchAll(/aria-expanded/gu)];
  const controls = [...body.matchAll(/aria-controls/gu)];
  assert.ok(controls.length >= expands.length, 'each aria-expanded names the node it toggles');
  assert.match(body, /role: 'tabpanel',\s*\n\s*'aria-labelledby'/u, 'the panel is named by its tab, not repeated');
  assert.match(body, /role: 'alert'/u, 'an error is announced rather than only painted');
  assert.doesNotMatch(body, /label\.startsWith\(t\('setup\./u, 'required flags are explicit, not guessed from a label');
});

test('UI-53 a long workspace name truncates instead of running under the badge', async () => {
  const body = await readFile(join(packageDir, 'src', 'client.js'), 'utf8');
  // Three things must hold together: the title can shrink, it clips with an ellipsis,
  // and the toggle cannot paint over its siblings.
  assert.match(body, /\[data-file-maid="cardtitle"\]\{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;\}/u);
  assert.match(body, /\[data-file-maid="cardsuffix"\]\{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;/u);
  assert.match(body, /\[data-file-maid="cardtoggle"\]\{[^}]*overflow:hidden;/u);
  assert.match(body, /\[data-file-maid="statetip"\]\{[^}]*flex:0 1 auto;[^}]*max-width:50%;/u);
  const header = body.slice(body.indexOf("'data-file-maid': 'cardhead'"), body.indexOf("'data-file-maid': 'cardbody'"));
  assert.doesNotMatch(header, /title:/u, 'no native tooltip in the header');
});

test('UI-54 the rescan control looks pressable, not like a caption', async () => {
  const body = await readFile(join(packageDir, 'src', 'client.js'), 'utf8');
  const rule = body.slice(body.indexOf('[data-file-maid="scanact"]{'), body.indexOf('[data-file-maid="scanact"]:hover'));
  assert.match(rule, /border:1px solid/u, 'it has an edge');
  assert.match(rule, /border-radius:6px/u);
  assert.match(rule, /background:var\(--dsw-alias-bg-layer-1/u, 'it has a surface');
  assert.match(rule, /min-height:24px/u, 'it meets the 24px hit target');
});

test('UI-55 every interactive control shares one hit height', async () => {
  const body = await readFile(join(packageDir, 'src', 'client.js'), 'utf8');
  const controls = ['linkbutton', 'rowact', 'ghostbutton', 'scanact', 'purposemore', 'morebar'];
  for (const hook of controls) {
    const at = body.indexOf(`'[data-file-maid="${hook}"]{`);
    assert.ok(at > 0, `${hook} has a base rule`);
    const rule = body.slice(at, body.indexOf('}', at));
    assert.match(rule, /min-height:24px/u, `${hook} is 24px tall`);
  }
  const head = body.slice(body.indexOf('[data-file-maid="sectionhead"]{'));
  assert.match(head.slice(0, head.indexOf('}')), /align-items:center/u, 'section heads centre their controls');
});

test('UI-56 every page keeps the same rhythm under its section head', async () => {
  const body = await readFile(join(packageDir, 'src', 'client.js'), 'utf8');
  const at = body.indexOf('-maid-gap-head:');
  assert.match(body.slice(at, at + 20), /-maid-gap-head:8px/u, 'heads sit 8px above their content');
  const scanrows = body.slice(body.indexOf("'[data-file-maid=\"scanrows\"]{"), body.indexOf("'[data-file-maid=\"scanrows\"]{") + 160);
  assert.match(scanrows, /margin-top:0/u, 'the scan rows do not add their own gap');
  const list = body.slice(body.indexOf("'[data-file-maid=\"list\"]{"), body.indexOf("'[data-file-maid=\"list\"]{") + 120);
  assert.match(list, /margin:0/u, 'the log list does not add its own gap');
  const head = body.slice(body.indexOf("'[data-file-maid=\"sectionhead\"]{"), body.indexOf("'[data-file-maid=\"sectionhead\"]{") + 260);
  assert.match(head, /min-height:24px/u);
  assert.match(head, /align-items:center/u);
});

test('UI-57 a long folder name truncates, and expanding the row reveals it', async () => {
  const body = await readFile(join(packageDir, 'src', 'client.js'), 'utf8');
  const path = body.slice(body.indexOf("'[data-file-maid=\"rowpath\"]{"), body.indexOf("'[data-file-maid=\"rowpath\"]{") + 160);
  assert.match(path, /min-width:0/u);
  assert.match(path, /text-overflow:ellipsis/u);
  assert.match(body, /'data-file-maid': 'pathline'/u, 'the expanded block names the folder in full');
  assert.match(body, /\[data-file-maid="pathline"\]\{[^}]*overflow-wrap:anywhere;/u, 'a long path wraps instead of overflowing');
  const logRows = body.slice(body.indexOf('const misplacedRow'), body.indexOf('const misplacedList'));
  assert.doesNotMatch(logRows, /title:/u, 'the log rows carry no native tooltip');
});

test('UI-58 a long file or folder name in the log truncates on each axis', async () => {
  const body = await readFile(join(packageDir, 'src', 'client.js'), 'utf8');
  const rule = (hook) => {
    const at = body.indexOf(`'[data-file-maid="${hook}"]{`);
    assert.ok(at > 0, `${hook} has a rule`);
    return body.slice(at, body.indexOf('}', at));
  };
  for (const hook of ['itemname', 'itemtarget']) {
    const text = rule(hook);
    assert.match(text, /min-width:0/u, `${hook} can shrink`);
    assert.match(text, /text-overflow:ellipsis/u, `${hook} truncates`);
    assert.match(text, /white-space:nowrap/u, `${hook} stays on one line`);
  }
  assert.match(rule('itemhead'), /overflow:hidden/u, 'the line clips its children');
  assert.match(rule('itemtarget'), /max-width:40%/u, 'the target cannot eat the whole line');
  assert.match(rule('pathline'), /overflow-wrap:anywhere/u, 'the expanded path wraps instead of truncating');
});

test('UI-59 a log row expands to name its full path', async () => {
  const body = await readFile(join(packageDir, 'src', 'client.js'), 'utf8');
  const row = body.slice(body.indexOf('const misplacedRow'), body.indexOf('const misplacedList'));
  assert.match(row, /'data-file-maid': 'itemtoggle'/u, 'the row head is the control');
  assert.match(row, /'aria-expanded': open/u);
  assert.match(row, /'aria-controls': id/u);
  assert.match(row, /'data-file-maid': 'itemdetail'/u, 'the expanded block exists');
  assert.match(row, /path === '' \? '—' : path/u, 'it prints the whole path, not the name');
  assert.match(row, /getFullYear\(\)/u, 'it prints an absolute timestamp');
  assert.match(body, /const \[openLog, setOpenLog\]/u, 'the open row is tracked');
});

test('UI-60 the expanded log row labels its facts and prints a stable local stamp', async () => {
  const body = await readFile(join(packageDir, 'src', 'client.js'), 'utf8');
  const row = body.slice(body.indexOf('const misplacedRow'), body.indexOf('const misplacedList'));
  assert.match(row, /'data-file-maid': 'itemfactlabel'/u, 'each fact carries a label');
  assert.match(row, /t\('misplaced\.pathLabel'\)/u);
  assert.match(row, /getFullYear\(\)/u, 'the stamp is built from local parts');
  assert.doesNotMatch(row, /toLocaleString\(/u, 'no locale-dependent formatting');
  const rule = body.slice(body.indexOf("'[data-file-maid=\"itemfactlabel\"]{"));
  assert.match(rule.slice(0, 220), /flex:0 0 32px/u, 'the labels line up in a column');
  assert.match(rule.slice(0, 220), /white-space:nowrap/u, 'a label never wraps');
});

test('UI-61 the expanded directory block labels its facts and drops the duplicate path', async () => {
  const body = await readFile(join(packageDir, 'src', 'client.js'), 'utf8');
  const block = body.slice(body.indexOf("'data-file-maid': 'tabdetail'"), body.indexOf("const table ="));
  assert.doesNotMatch(block, /'data-file-maid': 'pathline'/u, 'the path is no longer repeated under the row');
  assert.match(block, /t\('dir\.purposeLabel'\)/u);
  assert.match(block, /t\('detail\.excludesLabel'\)/u, 'the label carries no colon');
  assert.doesNotMatch(block, /t\('detail\.excludes'\)/u, 'the colon form is for sentences, not labels');
  assert.match(block, /t\('detail\.landedLabel'\)/u);
  assert.match(body, /\[data-file-maid="tabrow"\]\[data-open="true"\] \[data-file-maid="rowpath"\]\{white-space:normal/u, 'an open row may wrap a long name instead');
  assert.doesNotMatch(body, /metastrip/u, 'the merged strip is gone');
});
