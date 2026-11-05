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

test('UI-10 every data-file-maid hook a CSS rule styles is produced by the renderer', async () => {
  const body = await readFile(join(packageDir, 'src', 'client.js'), 'utf8');
  assert.doesNotMatch(body, /\[data-file-maid[\^*$~|]=/u, 'no prefix/substring attribute selector: hooks are exact tokens');
});
