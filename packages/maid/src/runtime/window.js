/**
 * Log-window reads (`§11.3`): decide how much of a channel a scan window covers.
 *
 * Both channel streams answer the same three questions: how many records fall
 * inside the window, which paths they name, and when the stream itself starts —
 * the last one decides whether the stream can cover the window at all.
 * @module file-maid/runtime/window
 */
import * as store from '../state/store.js';

/**
 * Read one log stream restricted to a window.
 * @param {string} root - absolute controlled root.
 * @param {'decisions'|'writes'} stream - channel stream name.
 * @param {string | undefined} since - window start as an ISO string.
 * @returns {Promise<{ count: number, paths: Set<string>, earliest: number | undefined, birth: number | undefined, rotated: boolean, covered: boolean }>} the window slice.
 */
export async function readWindow(root, stream, since) {
  let records = [];
  let rotatedAt;
  try {
    // Read the whole stream: one rotation window is at most `LOG_BYTES_LIMIT`,
    // so the tail cap would silently under-count a busy window, and under-counting
    // is indistinguishable from "these files really never went through the plugin".
    records = await store.readLogTail(root, stream, Number.POSITIVE_INFINITY);
    const marks = await store.readRotation(root);
    rotatedAt = Date.parse(marks?.[stream]);
  } catch {
    return { count: 0, paths: new Set(), earliest: undefined, birth: undefined, rotated: false, covered: false };
  }
  let earliest;
  for (const record of records) {
    const at = Date.parse(record?.at);
    if (Number.isFinite(at) && (earliest === undefined || at < earliest)) earliest = at;
  }
  const floor = since === undefined ? undefined : Date.parse(since);
  const inside = Number.isFinite(floor)
    ? records.filter((record) => {
        const at = Date.parse(record?.at);
        return Number.isFinite(at) ? at >= floor : false;
      })
    : records;
  // The ledger's `init` marker names no file: it dates the stream, it does not
  // count as one write, so only records carrying a path are counted.
  const paths = new Set();
  let count = 0;
  for (const record of inside) {
    const path = typeof record?.path === 'string' ? record.path : '';
    if (path === '') continue;
    count += 1;
    paths.add(path);
  }
  // Two things can leave a hole, and they are different in kind:
  //   * a rotation inside the window moved records out of the file that was read;
  //   * the write ledger was born inside the window (its `init` marker is newer
  //     than the window start), so writes before its birth are simply unknown.
  // Counts that merely begin after the window start are not a hole: nothing
  // happened before, which is exactly what a zero count says.
  let birth;
  for (const record of records) {
    if (record?.kind !== 'init') continue;
    const at = Date.parse(record?.at);
    if (Number.isFinite(at) && (birth === undefined || at < birth)) birth = at;
  }
  const rotated = Number.isFinite(floor) && Number.isFinite(rotatedAt) && rotatedAt >= floor;
  const bornLate = stream === 'writes' && Number.isFinite(floor) && Number.isFinite(birth) && birth > floor;
  // `rotatedAt` travels with the flag: records written after it cannot have been
  // rotated away, so a caller may still name those even when the window has a hole.
  return { count, paths, earliest, birth, rotated, rotatedAt: rotated ? rotatedAt : undefined, covered: !rotated && !bornLate };
}

/**
 * Count the decision records written after one instant.
 * @param {string} root - controlled root.
 * @param {string | undefined} since - ISO timestamp, inclusive.
 * @returns {Promise<number>} the count.
 */
export async function countDecisions(root, since) {
  return (await readWindow(root, 'decisions', since)).count;
}
