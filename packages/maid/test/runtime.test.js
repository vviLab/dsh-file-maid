/**
 * Runtime registry and projection (`R-*`): catalog states, baseline scans,
 * and the `status.json` the card reads.
 * @module file-maid/test/runtime
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { nameViolations, place } from '../src/runtime/place.js';
import { createRoots } from '../src/runtime/roots.js';
import { snapshotFromIndex } from '../src/runtime/scan.js';
import * as store from '../src/state/store.js';
import { catalogDocument, seed } from './helpers.js';

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
 * Create a disposable root with the four directories.
 * @returns {Promise<string>} absolute root.
 */
async function makeRoot() {
  const root = await mkdtemp(join(tmpdir(), 'maid-runtime-'));
  for (const name of ['00-Specs', '10-Projects', '30-Media', '80-Outputs']) {
    await mkdir(join(root, name), { recursive: true });
  }
  return root;
}

/**
 * Build one agent bound to a root.
 * @param {string} root - controlled root.
 * @returns {object} the agent.
 */
function makeAgent(root) {
  return { id: `session-${Math.random().toString(36).slice(2)}`, session: { header: { cwd: root } } };
}

test('R-10 a root without a catalog is UNINITIALIZED', async (t) => {
  const root = await makeRoot();
  const roots = createRoots({ ctx: stubContext() });
  const agent = makeAgent(root);
  t.after(async () => {
    roots.disposeAll();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  const entry = roots.acquire(agent);
  await roots.load(entry);
  assert.equal(roots.status(entry).catalogState, 'UNINITIALIZED');
  assert.equal(roots.view(agent), undefined);
});

test('R-11 a broken catalog is ERROR and carries the reason', async (t) => {
  const root = await makeRoot();
  const roots = createRoots({ ctx: stubContext() });
  const agent = makeAgent(root);
  t.after(async () => {
    roots.disposeAll();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  await mkdir(join(root, '.maid'), { recursive: true });
  await writeFile(join(root, '.maid', 'catalog.yml'), 'version: 2\n');
  const entry = roots.acquire(agent);
  await roots.load(entry);
  const status = roots.status(entry);
  assert.equal(status.catalogState, 'ERROR');
  assert.ok(status.errors.length > 0);
});

test('R-12 the first scan is a baseline and the projection says so', async (t) => {
  const root = await makeRoot();
  const roots = createRoots({ ctx: stubContext() });
  const agent = makeAgent(root);
  t.after(async () => {
    roots.disposeAll();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  await seed(roots, agent);
  const status = JSON.parse(await readFile(join(root, '.maid', 'status.json'), 'utf8'));
  assert.equal(status.schemaVersion, '2');
  assert.equal(status.catalog.state, 'MANAGED');
  assert.equal(status.scan.baseline, true);
  assert.deepEqual(status.catalog.dirs.map((dir) => dir.path), ['00-Specs', '10-Projects', '30-Media', '80-Outputs']);
  assert.equal(status.catalog.dirs[0].purpose.length > 0, true);
  assert.ok(Array.isArray(status.routes));
  assert.equal(status.reconcile.baseline, true);
});

test('R-13 a second scan reconciles against the stored baseline', async (t) => {
  const root = await makeRoot();
  const roots = createRoots({ ctx: stubContext() });
  const agent = makeAgent(root);
  const { entry } = await seed(roots, agent);
  t.after(async () => {
    roots.disposeAll();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  await writeFile(join(root, '30-Media', 'pic.png'), 'x');
  const outcome = await roots.scan(entry, 'test');
  assert.equal(outcome.baseline, false);
  assert.equal(outcome.reconcile.new_files, 1);
  assert.equal(outcome.reconcile.top_dirs[0].dir, '30-Media');

  const index = JSON.parse(await readFile(join(root, '.maid', 'index.json'), 'utf8'));
  assert.equal(index.files, 1);
  assert.deepEqual(snapshotFromIndex(index), { files: 1, dirs: { '00-Specs': 0, '10-Projects': 0, '30-Media': 1, '80-Outputs': 0 } });
});

test('R-14 the catalog is re-read on every tool call, never cached across edits', async (t) => {
  const root = await makeRoot();
  const roots = createRoots({ ctx: stubContext() });
  const agent = makeAgent(root);
  const { entry } = await seed(roots, agent);
  t.after(async () => {
    roots.disposeAll();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  const changed = catalogDocument();
  changed.root_default = '30-Media';
  await store.writeCatalog(root, store.serializeCatalog((await import('../src/core/catalog.js')).validateCatalog(changed).catalog, { root }));
  await roots.load(entry);
  assert.equal(roots.view(agent).rootDefault, '30-Media');
});

test('R-15 starting a session counts the root once so the card has numbers', async (t) => {
  const root = await makeRoot();
  const { ctx } = { ctx: stubContext() };
  const roots = createRoots({ ctx });
  const agent = { id: 'session-count', session: { id: 'session-count', header: { cwd: root } } };
  await seed(roots, agent);
  const entry = roots.acquire(agent);
  t.after(async () => {
    roots.disposeAll();
    await rm(root, { recursive: true, force: true });
  });

  await roots.start(entry);
  // The count runs behind the reply; one short wait is enough for a tiny tree.
  await new Promise((resolve) => setTimeout(resolve, 120));

  const status = JSON.parse(await readFile(join(root, '.maid', 'status.json'), 'utf8'));
  const counted = status.catalog.dirs.filter((dir) => typeof dir.files === 'number');
  assert.ok(counted.length > 0, 'at least one directory is counted');
  assert.ok(counted.every((dir) => dir.files >= 0));
});

test('R-16 a projection with no scan outcome carries no scan block', async (t) => {
  const root = await makeRoot();
  const roots = createRoots({ ctx: stubContext() });
  t.after(async () => {
    roots.disposeAll();
    await rm(root, { recursive: true, force: true });
  });
  const catalog = {
    rootDefault: '80-Outputs',
    dirs: [
      { path: '00-Specs', purpose: '规范', excludes: '', examples: [], index: 0 },
      { path: '80-Outputs', purpose: '输出', excludes: '', examples: [], index: 1 },
    ],
    rules: [],
  };
  await store.writeCatalog(root, store.serializeCatalog(catalog, { root }));

  await roots.projectRoot(root);
  const status = JSON.parse(await readFile(join(root, '.maid', 'status.json'), 'utf8'));
  assert.equal(Object.prototype.hasOwnProperty.call(status, 'scan'), false, 'an unrun scan is absent, not zero');
  assert.equal(status.catalog.dirs.every((dir) => dir.files === null || typeof dir.files === 'number'), true);
});

test('R-32 the leak entry carries rich fields, and the projection strips them', async (t) => {
  const root = await makeRoot();
  const roots = createRoots({ ctx: stubContext() });
  const agent = makeAgent(root);
  const { entry } = await seed(roots, agent);
  t.after(async () => {
    roots.disposeAll();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  await writeFile(join(root, '30-Media', 'clu.png'), 'x'.repeat(40));
  const outcome = await roots.scan(entry, 'test');
  const leak = outcome.reconcile.missing.find((item) => item.path === '30-Media/clu.png');
  assert.ok(leak !== undefined, 'the outside write shows up as a leak');
  assert.equal(leak.size, 40);
  assert.equal(leak.kind, 'file');
  assert.ok(Number.isFinite(leak.ctime), 'the reviewer can sort and confirm by ctime');

  // The card reads six pages of 400 lines, so the projection keeps only what the two
  // pages render: where it is, who owns it, when it appeared, whether it was accepted.
  // Size and kind stay in the review reply.
  const status = JSON.parse(await readFile(join(root, '.maid', 'status.json'), 'utf8'));
  const projected = status.reconcile.missing.find((item) => item.path === '30-Media/clu.png');
  assert.deepEqual(Object.keys(projected).sort(), ['acknowledged', 'ctime', 'dir', 'path']);
  assert.ok(Number.isFinite(projected.ctime), 'the timeline needs the same clock as the routes');
  assert.equal(projected.acknowledged, false);
});

test('R-39 a name that only works on one platform is refused with a reason', () => {
  const bad = {
    'a/b.md': 'E_MAID_NAME_CHAR',
    'a:b.md': 'E_MAID_NAME_CHAR',
    'q?.md': 'E_MAID_NAME_CHAR',
    'end.': 'E_MAID_NAME_TRAILING',
    'end ': 'E_MAID_NAME_TRAILING',
    CON: 'E_MAID_NAME_DEVICE',
    'con.txt': 'E_MAID_NAME_DEVICE',
    '': 'E_MAID_NAME_EMPTY',
    '..': 'E_MAID_NAME_RESERVED',
  };
  for (const [name, code] of Object.entries(bad)) {
    const violations = nameViolations(name);
    assert.ok(violations.length > 0, `${name} must be refused`);
    assert.ok(violations.some((item) => item.code === code), `${name} → ${code}`);
    assert.ok(violations.every((item) => item.message.length > 0), 'every refusal explains itself');
  }
  for (const name of ['周报.md', '2026-11-07 会议记录.txt', '.hidden', 'conclusion.md', 'a.b.c.md']) {
    assert.deepEqual(nameViolations(name), [], `${name} must pass`);
  }
});

test('R-40 the naming refusal reaches the caller as a list', async (t) => {
  const root = await makeRoot();
  const roots = createRoots({ ctx: stubContext() });
  const agent = makeAgent(root);
  const { entry } = await seed(roots, agent);
  t.after(async () => {
    roots.disposeAll();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  await roots.ready(entry);
  const placed = await place({ root, dir: '80-Outputs', name: 'a:b?.md', content: 'x' });
  assert.equal(placed.ok, false);
  assert.equal(placed.code, 'E_MAID_NAME_CHAR');
  assert.ok(placed.violations.length >= 2, 'both bad characters are named');
  assert.equal(await readdir(join(root, '80-Outputs')).then((list) => list.length).catch(() => 0), 0, 'nothing was written');
});
