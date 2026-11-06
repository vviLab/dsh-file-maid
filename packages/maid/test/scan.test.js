/**
 * Concurrent walk (`R-28`…`R-31`): the walk is parallel, so its results and its
 * truncation points have to stay reproducible, and the cap has to react to a
 * slow filesystem instead of oversubscribing it.
 * @module file-maid/test/scan
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  SCAN_CONCURRENCY_MAX,
  SCAN_LATENCY_WINDOW,
  initialLimit,
  scanConcurrency,
  scanTree,
} from '../src/state/probe.js';
import { CANDIDATE_LIMIT, scanManaged } from '../src/runtime/scan.js';

/**
 * Build a tree with `dirs` directories and `perDir` files in each.
 * @param {number} dirs - directory count.
 * @param {number} perDir - files per directory.
 * @returns {Promise<string>} the temporary root.
 */
async function fixture(dirs, perDir) {
  const root = await mkdtemp(join(tmpdir(), 'file-maid-scan-'));
  for (let d = 0; d < dirs; d += 1) {
    const dir = join(root, `d${String(d).padStart(3, '0')}`);
    await mkdir(dir, { recursive: true });
    for (let f = 0; f < perDir; f += 1) {
      await writeFile(join(dir, `f${String(f).padStart(3, '0')}.md`), 'x');
    }
  }
  return root;
}

const catalogue = (paths) => ({ version: 1, rootDefault: paths[0], rules: [], dirs: paths.map((path) => ({ path })) });

test('R-28 a concurrent walk reports the same tree as a serial one', async (t) => {
  const root = await fixture(12, 5);
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));

  const serial = await scanTree(root, { concurrency: 1 });
  const parallel = await scanTree(root, { concurrency: SCAN_CONCURRENCY_MAX });

  assert.equal(parallel.files, serial.files);
  assert.equal(parallel.dirs, serial.dirs);
  assert.deepEqual(Object.keys(parallel.entries), Object.keys(serial.entries), 'entries stay in code-point order');
  assert.deepEqual(parallel.entries, serial.entries);
});

test('R-29 candidate truncation is reproducible', async (t) => {
  // More files than the candidate cap, so the cut has to land on the same paths.
  const root = await fixture(6, 110);
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));

  const catalog = catalogue(['d000', 'd001', 'd002', 'd003', 'd004', 'd005']);
  const since = Date.now() - 60_000;
  const first = await scanManaged({ root, catalog, since });
  const second = await scanManaged({ root, catalog, since });

  assert.equal(first.candidates.length, CANDIDATE_LIMIT);
  assert.equal(first.candidates_truncated ?? first.candidatesTruncated, true);
  assert.deepEqual(first.candidates.map((entry) => entry.path), second.candidates.map((entry) => entry.path));
  const paths = first.candidates.map((entry) => entry.path);
  // Newest first, path as the tie-break: the card shows the newest rows, so the
  // cut has to keep them and two runs have to agree on which.
  const ordered = [...first.candidates].sort((left, right) => right.ctime - left.ctime
    || (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  assert.deepEqual(paths, ordered.map((entry) => entry.path), 'cut lands in newest-first order');
  assert.ok(first.candidates[0].size >= 0, 'a candidate carries its size');
  assert.equal(first.candidates[0].kind, 'file');
});

test('R-30 the cap follows the measured latency, and the environment can pin it', async (t) => {
  const root = await fixture(4, 2);
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));

  // A slow directory read: every window exceeds the slow threshold, so after two
  // windows the cap halves until it reaches the floor.
  let inFlight = 0;
  let peak = 0;
  const slow = async (path, options) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 6));
    inFlight -= 1;
    return (await import('node:fs/promises')).readdir(path, options);
  };
  await scanTree(root, { readdir: slow });
  assert.ok(peak <= 4, `a slow filesystem keeps the cap low, saw ${peak}`);

  // A fast one grows the cap to the ceiling instead.
  inFlight = 0;
  peak = 0;
  const fast = async (path, options) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    const entries = await (await import('node:fs/promises')).readdir(path, options);
    inFlight -= 1;
    return entries;
  };
  await scanTree(root, { readdir: fast });
  assert.ok(peak >= 2, 'a fast filesystem is allowed to run reads in parallel');

  assert.equal(scanConcurrency({ FILE_MAID_SCAN_CONCURRENCY: '1' }), 1);
  assert.equal(scanConcurrency({ FILE_MAID_SCAN_CONCURRENCY: '9' }), undefined, 'out of range falls back to adaptive');
  assert.equal(scanConcurrency({}), undefined);
  peak = 0;
  await scanTree(root, { concurrency: 1, readdir: fast });
  assert.equal(peak, 1, 'a pinned cap is never exceeded');
});

test('R-31 a scan does not stall the event loop', async (t) => {
  const root = await fixture(20, 40);
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));

  let worst = 0;
  let last = Date.now();
  const ticker = setInterval(() => {
    const now = Date.now();
    worst = Math.max(worst, now - last - 5);
    last = now;
  }, 5);
  try {
    await scanTree(root);
  } finally {
    clearInterval(ticker);
  }
  assert.ok(worst <= 50, `a 5 ms timer slipped ${worst} ms during the walk`);
});

test('R-31b mount types only shorten the starting cap', async () => {
  const start = initialLimit('/tmp');
  assert.ok(Number.isInteger(start) && start >= 1 && start <= SCAN_CONCURRENCY_MAX);
  assert.ok(SCAN_LATENCY_WINDOW > 0);
});
