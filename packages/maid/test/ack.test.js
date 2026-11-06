/**
 * Acknowledgement: the file, the arithmetic, and the end-to-end toggle (`AK-*`, `R-33..R-36`).
 * @module file-maid/test/ack
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ACK_MAX_AGE_MS, ackKey, ackSet, pruneAcks } from '../src/core/ack.js';
import { reconcile } from '../src/core/reconcile.js';
import { createRoots } from '../src/runtime/roots.js';
import * as store from '../src/state/store.js';
import { seed } from './helpers.js';

async function makeRoot() {
  const root = await mkdtemp(join(tmpdir(), 'maid-ack-'));
  for (const name of ['00-Specs', '10-Projects', '30-Media', '80-Outputs']) {
    await mkdir(join(root, name), { recursive: true });
  }
  return root;
}

const ctx = {
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

test('AK-01 a missing file is an empty set, not an error', async (t) => {
  const root = await makeRoot();
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  const read = await store.readAcknowledged(root);
  assert.deepEqual(read.entries, {});
  assert.equal(read.revision, 0);
  assert.equal(read.warning, undefined);
});

test('AK-02 a corrupt file resurfaces everything and says so', async (t) => {
  const root = await makeRoot();
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  await mkdir(join(root, '.maid'), { recursive: true });
  await writeFile(join(root, '.maid', 'acknowledged.json'), '{ not json');
  const read = await store.readAcknowledged(root);
  // The failure direction matters: an unreadable file must never hide leaks.
  assert.deepEqual(read.entries, {});
  assert.equal(read.warning, 'E_MAID_ACK_CORRUPT');
});

test('AK-03 a write bumps the revision and stays private', async (t) => {
  const root = await makeRoot();
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  const first = await store.writeAcknowledged(root, { entries: { '80-Outputs/a.md': { ctime: 5, at: new Date().toISOString() } }, revision: 0 });
  assert.equal(first, 1);
  const second = await store.writeAcknowledged(root, { entries: {}, revision: first });
  assert.equal(second, 2);
  const mode = (await stat(join(root, '.maid', 'acknowledged.json'))).mode & 0o777;
  assert.equal(mode, 0o600);
  const written = JSON.parse(await readFile(join(root, '.maid', 'acknowledged.json'), 'utf8'));
  assert.equal(written.version, 1);
  assert.equal(written.revision, 2);
});

test('AK-04 stale and retired entries are pruned on write', () => {
  const now = Date.now();
  const pruned = pruneAcks({
    now,
    dirs: ['80-Outputs'],
    entries: {
      '80-Outputs/keep.md': { ctime: 1, at: new Date(now - 1000).toISOString() },
      '80-Outputs/old.md': { ctime: 2, at: new Date(now - ACK_MAX_AGE_MS - 1000).toISOString() },
      '99-Gone/retired.md': { ctime: 3, at: new Date(now).toISOString() },
    },
  });
  assert.deepEqual(Object.keys(pruned.kept), ['80-Outputs/keep.md']);
  assert.deepEqual(pruned.dropped.sort(), ['80-Outputs/old.md', '99-Gone/retired.md']);
});

test('AK-05 the key carries ctime, so a later write on the same path is seen', () => {
  const set = ackSet([{ path: '80-Outputs/a.md', ctime: 100 }]);
  assert.ok(set.has(ackKey('80-Outputs/a.md', 100)));
  assert.ok(!set.has(ackKey('80-Outputs/a.md', 101)), 'a new inode change is a new leak');
});

test('R-33 an accepted leak leaves the list but keeps the arithmetic whole', () => {
  const before = { dirs: { '80-Outputs': 0 }, files: 0 };
  const after = { dirs: { '80-Outputs': 2 }, files: 2 };
  const candidates = [
    { path: '80-Outputs/a.md', dir: '80-Outputs', ctime: 10, size: 1, kind: 'file' },
    { path: '80-Outputs/b.md', dir: '80-Outputs', ctime: 20, size: 2, kind: 'file' },
  ];
  const plain = reconcile({ before, after, recorded: 0, candidates });
  const acked = reconcile({ before, after, recorded: 0, candidates, acknowledged: ackSet([{ path: '80-Outputs/a.md', ctime: 10 }]) });
  assert.equal(plain.missing.length, 2);
  assert.equal(acked.missing.length, 1);
  assert.equal(acked.acknowledged_files, 1);
  assert.equal(acked.missing_total, 2);
  assert.equal(acked.new_files, plain.new_files);
});

test('R-34 residual is subtracted from missing_total, not the visible list', () => {
  const before = { dirs: { '80-Outputs': 0 }, files: 0 };
  const after = { dirs: { '80-Outputs': 3 }, files: 3 };
  const candidates = [
    { path: '80-Outputs/a.md', dir: '80-Outputs', ctime: 10 },
    { path: '80-Outputs/b.md', dir: '80-Outputs', ctime: 20 },
  ];
  // Three new files, two named candidates, one never named: the residual is 1
  // whether or not one of the two named ones was accepted.
  const acked = reconcile({
    before,
    after,
    recorded: 0,
    candidates,
    acknowledged: ackSet([{ path: '80-Outputs/a.md', ctime: 10 }]),
  });
  assert.equal(acked.missing.length, 1);
  assert.equal(acked.missing_total, 2);
  assert.equal(acked.residual, 1, 'an accepted file cannot become residual');
});

test('R-35 a coverage gap keeps every acknowledgement number unknown', () => {
  const result = reconcile({
    before: { dirs: { '80-Outputs': 0 }, files: 0 },
    after: { dirs: { '80-Outputs': 2 }, files: 2 },
    recorded: 0,
    candidates: [],
    ledgerIncomplete: true,
    acknowledged: ackSet([{ path: '80-Outputs/a.md', ctime: 10 }]),
  });
  assert.deepEqual(result.missing, []);
  assert.equal(result.acknowledged_files, null);
  assert.equal(result.residual, null);
});

test('R-36 accepting hides the leak, undoing brings it back', async (t) => {
  const root = await makeRoot();
  const roots = createRoots({ ctx });
  const agent = { id: 'ack-1', session: { header: { cwd: root } } };
  const { entry } = await seed(roots, agent);
  t.after(async () => {
    roots.disposeAll();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  await roots.scan(entry, 'test');
  await writeFile(join(root, '80-Outputs', 'outside.md'), 'x');

  const first = await roots.review(entry);
  const leak = first.missing.find((item) => item.path === '80-Outputs/outside.md');
  assert.ok(leak !== undefined);

  const accepted = await roots.acknowledge(entry, { op: 'ack', path: leak.path, ctime: leak.ctime });
  assert.equal(accepted.ok, true);
  const second = await roots.review(entry);
  assert.equal(second.missing.some((item) => item.path === leak.path), false, 'the accepted leak is not listed');
  assert.equal(second.counts.acknowledged_files, 1);
  assert.equal(second.counts.missing_total, first.counts.missing_total);

  const undone = await roots.acknowledge(entry, { op: 'unack', path: leak.path, ctime: leak.ctime });
  assert.equal(undone.ok, true);
  const third = await roots.review(entry);
  assert.equal(third.missing.some((item) => item.path === leak.path), true, 'undo surfaces it again');
});

test('R-37 an acceptance after a restart still updates the stored projection', async (t) => {
  const root = await makeRoot();
  const first = createRoots({ ctx });
  const agent = { id: 'restart-1', session: { header: { cwd: root } } };
  const { entry } = await seed(first, agent);
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  await first.scan(entry, 'test');
  first.disposeAll();
  // The file lands after the last scan of the old process, so it is inside the window
  // the stored baseline describes.
  await writeFile(join(root, '80-Outputs', 'kept-out.md'), 'x');

  // A new process has no scan in memory; the card is still reading the file the
  // previous one wrote. Accepting must patch that file, not silently do nothing.
  const second = createRoots({ ctx });
  const fresh = second.acquire(agent);
  const review = await second.review(fresh);
  const leak = review.missing.find((item) => item.path === '80-Outputs/kept-out.md');
  const result = await second.acknowledge(fresh, { op: 'ack', path: leak.path, ctime: leak.ctime });
  assert.equal(result.ok, true);
  second.disposeAll();

  const status = JSON.parse(await readFile(join(root, '.maid', 'status.json'), 'utf8'));
  const row = status.reconcile.missing.find((item) => item.path === '80-Outputs/kept-out.md');
  assert.equal(row.acknowledged, true, 'the row is marked, not dropped');
  assert.equal(status.reconcile.acknowledged_files, 1);
  assert.equal(status.reconcile.missing_total, 1);
});

test('R-38 an undo brings the row back in the stored projection', async (t) => {
  const root = await makeRoot();
  const roots = createRoots({ ctx });
  const agent = { id: 'restart-2', session: { header: { cwd: root } } };
  const { entry } = await seed(roots, agent);
  t.after(async () => {
    roots.disposeAll();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  await roots.scan(entry, 'test');
  await writeFile(join(root, '80-Outputs', 'back.md'), 'x');
  const leak = (await roots.review(entry)).missing.find((item) => item.path === '80-Outputs/back.md');
  await roots.acknowledge(entry, { op: 'ack', path: leak.path, ctime: leak.ctime });
  await roots.acknowledge(entry, { op: 'unack', path: leak.path, ctime: leak.ctime });

  const status = JSON.parse(await readFile(join(root, '.maid', 'status.json'), 'utf8'));
  const row = status.reconcile.missing.find((item) => item.path === '80-Outputs/back.md');
  assert.equal(row.acknowledged, false, 'undo flips the flag back');
  assert.equal(status.reconcile.acknowledged_files, 0);
  assert.equal(status.reconcile.missing_total, 1);
});
