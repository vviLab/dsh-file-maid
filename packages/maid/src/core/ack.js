/**
 * Acknowledgement set (`§5` of the leak-review plan): which leaks a human has
 * already looked at, and when a stored entry still applies.
 *
 * Pure module: it only decides keys and which entries a prune would drop; the
 * file lives in `state/store.js`. An acknowledgement never changes the books —
 * the file still counts as a new file, it just stops being listed.
 * @module file-maid/core/ack
 */

/** Entries kept in one acknowledgement file. */
export const ACK_LIMIT = 5000;

/** Age after which an entry is dropped, in milliseconds. */
export const ACK_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Build the key an entry is stored under and matched by.
 * The pair is `path@ctime`: matching on the path alone would swallow a real
 * outside write that lands on the same path later.
 * @param {string} path - relative path inside the root.
 * @param {number} ctime - inode change time in milliseconds.
 * @returns {string} the key.
 */
export function ackKey(path, ctime) {
  return `${path}@${ctime}`;
}

/**
 * Turn a review's missing list into the set of keys an acknowledgement covers.
 * @param {Array<{ path: string, ctime?: number | null }> | undefined} entries - stored entries.
 * @returns {Set<string>} keys usable by the reconciler.
 */
export function ackSet(entries) {
  const set = new Set();
  for (const entry of entries ?? []) {
    if (typeof entry?.path !== 'string' || entry.path === '') continue;
    const ctime = Number(entry.ctime);
    if (!Number.isFinite(ctime)) continue;
    set.add(ackKey(entry.path, ctime));
  }
  return set;
}

/**
 * Decide which stored entries a write should keep.
 *
 * Pruning happens on write and never on read: a read that cleaned up would make
 * a file that cannot be written to look like it lost its entries.
 * @param {{ entries?: Record<string, { ctime?: number, at?: string }>, dirs?: string[], now?: number }} input - current entries, live directories, clock.
 * @returns {{ kept: Record<string, { ctime: number, at: string }>, dropped: string[] }} what to write next and what was removed.
 */
export function pruneAcks(input) {
  const now = input.now ?? Date.now();
  const dirs = new Set(input.dirs ?? []);
  const kept = {};
  const dropped = [];
  for (const [path, entry] of Object.entries(input.entries ?? {})) {
    const at = Date.parse(entry?.at ?? '');
    const ctime = Number(entry?.ctime);
    const owner = path.split('/')[0];
    const retired = dirs.size > 0 && !dirs.has(owner);
    const stale = !Number.isFinite(at) || now - at > ACK_MAX_AGE_MS;
    if (retired || stale) {
      dropped.push(path);
      continue;
    }
    kept[path] = { ctime: Number.isFinite(ctime) ? ctime : 0, at: new Date(at).toISOString() };
  }
  // Oldest first, so the cap drops the least recently confirmed.
  const names = Object.keys(kept);
  if (names.length > ACK_LIMIT) {
    names
      .sort((left, right) => Date.parse(kept[left].at) - Date.parse(kept[right].at))
      .slice(0, names.length - ACK_LIMIT)
      .forEach((path) => {
        delete kept[path];
        dropped.push(path);
      });
  }
  return { kept, dropped };
}
