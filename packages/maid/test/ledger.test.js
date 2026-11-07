/**
 * Write ledger and candidate reconciliation (`L-*`, `C-*`, `R-2*`, `M-20`, `UI-11`).
 * @module file-maid/test/ledger
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { apply } from '../src/plugin.js';
import { reconcile } from '../src/core/reconcile.js';
import { CANDIDATE_LIMIT, scanManaged } from '../src/runtime/scan.js';
import { createRoots } from '../src/runtime/roots.js';
import { createManageSurface } from '../src/surfaces/manage.js';
import * as store from '../src/state/store.js';
import { catalogDocument, validCatalog } from './helpers.js';

/**
 * Create a workspace-shaped root with a catalog.
 * @returns {Promise<string>} the absolute root.
 */
async function makeRoot() {
  const root = await mkdtemp(join(tmpdir(), 'maid-ledger-'));
  await mkdir(join(root, '00-Specs'), { recursive: true });
  await mkdir(join(root, '80-Outputs'), { recursive: true });
  await store.writeCatalog(root, store.serializeCatalog(validCatalog(catalogDocument()), { root }));
  return root;
}

/**
 * Capture the handlers and read-only switch one mount needs.
 * @param {{ readOnly?: boolean }} [options] - session switches.
 * @returns {{ ctx: object, handlers: Map<string, Function> }} the stub.
 */
function stubContext(options = {}) {
  const handlers = new Map();
  const ctx = {
    logger: () => ({ debug() {}, warn() {} }),
    get(id) {
      if (id === 'workingDirectory') return { get: (session) => session?.header?.cwd };
      if (id === 'permissionPresets') return { current: () => (options.readOnly === true ? 'read-only' : 'workspace-write') };
      if (id === 'fs') return { processPath: (target) => target?.targetKey ?? target?.displayPath };
      if (id === 'sessions') return { get: () => ({ deriveMessages: () => [] }) };
      return undefined;
    },
    sessions: { get: () => ({ deriveMessages: () => [] }) },
    tools: { register: () => () => {} },
    systemPrompt: { context: () => () => {} },
    on(event, handler) {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
    effect: (fn) => fn(),
  };
  return { ctx, handlers };
}

/**
 * Read the ledger straight off disk.
 * @param {string} root - absolute root.
 * @returns {Promise<object[]>} records, oldest first.
 */
async function ledger(root) {
  const path = join(root, '.maid', 'writes.jsonl');
  const text = await readFile(path, 'utf8').catch(() => undefined);
  if (text === undefined) return [];
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

/**
 * Wait for the fire-and-forget ledger append to land.
 * @param {string} root - absolute root.
 * @param {number} count - record count to wait for.
 * @returns {Promise<object[]>} the records.
 */
async function settledLedger(root, count) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const records = await ledger(root);
    if (records.length >= count) return records;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return ledger(root);
}

test('L-01 a write observation lands in the ledger', async (t) => {
  const root = await makeRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const { ctx, handlers } = stubContext();
  apply(ctx);
  const observed = handlers.get('fs/observed');
  assert.equal(typeof observed, 'function', 'the plugin subscribes to fs/observed');

  const exec = { name: 'write', agent: { session: { header: { cwd: root }, id: 's1' } } };
  observed({ targetKey: join(root, '80-Outputs', 'a.md') }, { kind: 'present' }, exec);
  const records = await settledLedger(root, 2);
  assert.equal(records[0].kind, 'init', 'the first record marks the ledger start');
  assert.equal(records[1].tool, 'write');
  assert.equal(records[1].path, '80-Outputs/a.md');
  assert.equal(records[1].kind, 'present');
});

test('L-02 and L-03 read observations stay out of the ledger', async (t) => {
  const root = await makeRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const { ctx, handlers } = stubContext();
  apply(ctx);
  const observed = handlers.get('fs/observed');
  const exec = { name: 'read', agent: { session: { header: { cwd: root }, id: 's1' } } };
  observed({ targetKey: join(root, '80-Outputs', 'a.md') }, { kind: 'present' }, exec);
  observed({ targetKey: join(root, '80-Outputs', 'gone.md') }, { kind: 'absent' }, exec);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.deepEqual(await ledger(root), []);
});

test('L-04 a read-only session records nothing', async (t) => {
  const root = await makeRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const { ctx, handlers } = stubContext({ readOnly: true });
  apply(ctx);
  handlers.get('fs/observed')({ targetKey: join(root, '80-Outputs', 'a.md') }, { kind: 'present' }, {
    name: 'write',
    agent: { session: { header: { cwd: root }, id: 's1' } },
  });
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.deepEqual(await ledger(root), []);
});

test('L-05 a path outside the root is not recorded', async (t) => {
  const root = await makeRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const { ctx, handlers } = stubContext();
  apply(ctx);
  handlers.get('fs/observed')({ targetKey: '/etc/hosts' }, { kind: 'present' }, {
    name: 'write',
    agent: { session: { header: { cwd: root }, id: 's1' } },
  });
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.deepEqual(await ledger(root), []);
});

test('C-01 a scan keeps only files whose ctime is inside the window', async (t) => {
  const root = await makeRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const { writeFile } = await import('node:fs/promises');
  await writeFile(join(root, '80-Outputs', 'a.md'), 'a');
  const catalog = catalogDocument();
  const future = await scanManaged({ root, catalog, since: Date.now() + 60_000 });
  assert.equal(future.candidates.length, 0);
  const all = await scanManaged({ root, catalog, since: 0 });
  assert.equal(all.candidates.length, 1);
  assert.equal(all.candidates[0].path, '80-Outputs/a.md');
  assert.equal(all.candidates[0].dir, '80-Outputs');
});

test('C-02 the candidate list stops at the limit and says so', async (t) => {
  const root = await makeRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const { writeFile } = await import('node:fs/promises');
  for (let index = 0; index < CANDIDATE_LIMIT + 5; index += 1) {
    await writeFile(join(root, '80-Outputs', `f${index}.md`), 'x');
  }
  const result = await scanManaged({ root, catalog: catalogDocument(), since: 0 });
  assert.equal(result.candidates.length, CANDIDATE_LIMIT);
  assert.equal(result.candidatesTruncated, true);
});

test('R-20 the four quantities add up', () => {
  const result = reconcile({
    before: { files: 10, dirs: { '80-Outputs': 10 } },
    after: { files: 16, dirs: { '80-Outputs': 16 } },
    recorded: 2,
    ledger: 2,
    recordedPaths: new Set(['80-Outputs/p1.md', '80-Outputs/p2.md']),
    ledgerPaths: new Set(['80-Outputs/w1.md', '80-Outputs/w2.md']),
    candidates: [
      { path: '80-Outputs/p1.md', dir: '80-Outputs' },
      { path: '80-Outputs/p2.md', dir: '80-Outputs' },
      { path: '80-Outputs/w1.md', dir: '80-Outputs' },
      { path: '80-Outputs/w2.md', dir: '80-Outputs' },
      { path: '80-Outputs/lost1.md', dir: '80-Outputs' },
    ],
  });
  assert.equal(result.new_files, 6);
  assert.equal(result.missing.length, 1);
  assert.equal(result.residual, 1);
  assert.equal(result.new_files, result.recorded + result.ledger + result.missing.length + result.residual);
});

test('R-21 one path written twice is named once', () => {
  const result = reconcile({
    before: { files: 1, dirs: { '80-Outputs': 1 } },
    after: { files: 3, dirs: { '80-Outputs': 3 } },
    recorded: 0,
    ledger: 0,
    candidates: [
      { path: '80-Outputs/a.md', dir: '80-Outputs' },
      { path: '80-Outputs/a.md', dir: '80-Outputs' },
    ],
  });
  assert.equal(result.missing.length, 1);
  assert.equal(result.residual, 1);
});

test('L-07 the init marker dates the ledger without counting as a write', async (t) => {
  const root = await makeRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const roots = createRoots({ ctx: stubContext().ctx });
  await roots.scanRoot(root);
  await new Promise((resolve) => setTimeout(resolve, 15));
  await store.appendLog(root, 'writes', { kind: 'init' });
  await store.appendLog(root, 'writes', { tool: 'write', path: '80-Outputs/b.md', kind: 'present' });
  const { writeFile } = await import('node:fs/promises');
  await writeFile(join(root, '80-Outputs', 'b.md'), 'b');

  const outcome = await roots.scanRoot(root);
  assert.equal(outcome.reconcile.ledger, 1, 'only the record that names a path counts');
  assert.equal(outcome.reconcile.new_files, 1);
  assert.equal(outcome.reconcile.missing.length, 0, 'the ledger covers the file it names');
  // The ledger was born inside this window, so the remainder is unknowable here.
  assert.equal(outcome.reconcile.residual, null);
});

test('R-22 a ledger that starts late marks the window incomplete', async (t) => {
  const root = await makeRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const { writeFile } = await import('node:fs/promises');
  await writeFile(join(root, '80-Outputs', 'a.md'), 'a');
  const roots = createRoots({ ctx: stubContext().ctx });
  await roots.projectRoot(root);
  const first = await roots.scanRoot(root);
  assert.equal(first.reconcile.baseline, true);
  // A ledger created after the baseline cannot explain the window, and the
  // reconciler says so instead of printing a false list of blind spots.
  await new Promise((resolve) => setTimeout(resolve, 15));
  await store.appendLog(root, 'writes', { kind: 'init' });
  const second = await roots.scanRoot(root);
  assert.equal(second.reconcile.ledger_incomplete, true, 'a ledger born after the window start cannot cover it');
});

test('R-26 a window with a coverage hole reports counts but no names', () => {
  const result = reconcile({
    before: { files: 10, dirs: { '80-Outputs': 10 } },
    after: { files: 12, dirs: { '80-Outputs': 12 } },
    recorded: 1,
    ledger: 0,
    recordedPaths: new Set(['80-Outputs/a.md']),
    candidates: [
      { path: '80-Outputs/a.md', dir: '80-Outputs' },
      { path: '80-Outputs/stray.md', dir: '80-Outputs' },
    ],
    ledgerIncomplete: true,
  });
  assert.deepEqual(result.missing, [], 'a hole in the window forbids naming files');
  assert.equal(result.new_files, 2);
  assert.equal(result.residual, null, 'the remainder is unknowable too, not zero');
  assert.equal(result.ledger_incomplete, true);
});

test('R-23 a rotation inside the window makes both channels incomplete', async (t) => {
  const root = await makeRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const roots = createRoots({ ctx: stubContext().ctx });
  await roots.scanRoot(root);
  await new Promise((resolve) => setTimeout(resolve, 15));
  await store.markRotation(root, 'decisions');
  await store.markRotation(root, 'writes');
  const outcome = await roots.scanRoot(root);
  assert.equal(outcome.reconcile.recorded_incomplete, true, 'a rotated decision log cannot cover the window');
  assert.equal(outcome.reconcile.ledger_incomplete, true, 'a rotated write ledger cannot cover the window');
});

test('R-24 a rotation before the window leaves coverage intact', async (t) => {
  const root = await makeRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const roots = createRoots({ ctx: stubContext().ctx });
  await store.markRotation(root, 'decisions');
  await store.markRotation(root, 'writes');
  await new Promise((resolve) => setTimeout(resolve, 15));
  await roots.scanRoot(root);
  const outcome = await roots.scanRoot(root);
  assert.equal(outcome.reconcile.recorded_incomplete, false);
  assert.equal(outcome.reconcile.ledger_incomplete, false);
});

test('R-25 a stream past the byte budget rotates and records when', async (t) => {
  const root = await makeRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const { writeFile, readFile } = await import('node:fs/promises');
  const target = join(root, '.maid', 'writes.jsonl');
  const filler = `${JSON.stringify({ at: new Date().toISOString(), tool: 'write', path: '80-Outputs/x.md', kind: 'present' })}\n`;
  await writeFile(target, filler.repeat(Math.ceil((1024 * 1024 + 1024) / filler.length)), { mode: 0o600 });
  await store.appendLog(root, 'writes', { kind: 'init' });
  const marks = await store.readRotation(root);
  assert.equal(typeof marks.writes, 'string', 'rotation must be dated');
  const rotated = await readFile(join(root, '.maid', 'writes.1.jsonl'), 'utf8');
  assert.ok(rotated.length > 0, 'the base file moved aside');
});

test('M-20 the scan endpoint answers with the reconciliation', async (t) => {
  const root = await makeRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const surface = createManageSurface({
    ctx: stubContext().ctx,
    roots: {
      projectRoot: async () => {},
      scanRoot: async () => ({ files: 2, dirs: 1, elapsed: 3, baseline: false, reconcile: { ledger: 1, missing: [{ path: '80-Outputs/x.md', dir: '80-Outputs' }] } }),
    },
  });
  const sessionId = 'session-1';
  const ctx = stubContext().ctx;
  ctx.sessions.get = () => ({ header: { cwd: root } });
  const scoped = createManageSurface({ ctx, roots: { projectRoot: async () => {}, scanRoot: async () => ({ files: 2, dirs: 1, elapsed: 3, reconcile: { ledger: 1, missing: [] } }) } });
  const result = await scoped.service.scan(root, sessionId);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.value.files, 2);
  assert.equal(result.value.ledger, 1);
  assert.ok(Array.isArray(result.value.missing));
  assert.ok(surface.descriptors.some((item) => item.id === 'fileMaid/scan'));
});

test('UI-11 the scan page offers a rerun button and a blind-spot list', async () => {
  const body = await readFile(join(import.meta.dirname, '..', 'src', 'client.js'), 'utf8');
  assert.match(body, /'scan\.rerun': '重新扫描'/u);
  assert.match(body, /callRemote\('scan'/u);
  assert.match(body, /descriptorOf\('scan', \['root', 'sessionId', 'payload'\]\)/u, 'the card must mount the scan descriptor');
  assert.doesNotMatch(body, /'scanactions'/u, 'the action must not own a row of its own');
  assert.match(body, /'scan\.scanNow': '立即扫描'/u, 'the empty state offers a scan');
  assert.match(body, /'scan\.leakCount': '\{n\} 个改动没被记账'/u, 'the leak count belongs to the reconcile head');
  assert.match(body, /'k\.ledger': '经工具写盘'/u);
});


test('R-27 the two channels report files, so the card can add them up', async () => {
  const before = { files: 10, dirs: { '80-Outputs': 5 }, roots: { '80-Outputs': { files: 5 } } };
  const after = { files: 11, dirs: { '80-Outputs': 6 }, roots: { '80-Outputs': { files: 6 } } };
  // One file written twice through the ledger: two records, one file.
  const ledgerPaths = new Set(['80-Outputs/once.md']);
  const recordedPaths = new Set();
  const result = reconcile({
    before,
    after,
    recorded: 0,
    ledger: 2,
    recordedPaths,
    ledgerPaths,
    candidates: [{ path: '80-Outputs/once.md', dir: '80-Outputs' }],
  });
  assert.equal(result.new_files, 1);
  assert.equal(result.ledger_files, 1, 'two records of one file count once');
  assert.equal(result.recorded_files, 0);
  assert.equal(result.missing.length, 0);
  assert.equal(result.residual, 0);
});
