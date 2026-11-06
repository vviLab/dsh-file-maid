/**
 * Baseline reconciliation: how many new files appeared, and how many of them
 * came through the write channel.
 *
 * The difference is the blind spot — files created by downloads, exports,
 * `bash`, or another plugin's direct `node:fs` call. The number is an estimate
 * by construction: deletions shrink it, overwrites do not grow it, and a move
 * between two controlled directories changes two counters.
 *
 * Pure module: it compares two snapshots and never touches the disk.
 * @module file-maid/core/reconcile
 */

/** Maximum directories named in one report. */
export const TOP_DIRS_LIMIT = 5;

/**
 * Total per-directory counts of one snapshot.
 * @param {{ dirs?: Record<string, number> } | undefined} snapshot - one scan snapshot.
 * @returns {number} the summed file count.
 */
function totalOf(snapshot) {
  const dirs = snapshot?.dirs ?? {};
  let sum = 0;
  for (const value of Object.values(dirs)) sum += Number.isFinite(value) ? value : 0;
  return sum;
}

/**
 * Compare one snapshot against its baseline.
 *
 * Four quantities come out of it: how many files appeared, how many of those
 * the write channel accounts for, how many are named but unaccounted for, and
 * the remainder the candidate list never covered.
 * `recordedIncomplete` and `ledgerIncomplete` are separate on purpose: a hole in
 * the decision log only corrupts `recorded`, a hole in the write ledger only
 * corrupts `ledger`, and one flag cannot describe both.
 * @param {{ before?: { dirs?: Record<string, number>, files?: number }, after: { dirs?: Record<string, number>, files?: number }, recorded: number, ledger?: number, candidates?: { path: string, dir: string }[], recordedPaths?: Set<string>, ledgerPaths?: Set<string>, truncated?: boolean, ledgerIncomplete?: boolean, decisionsIncomplete?: boolean }} input - snapshots, channel counts, and the changed-file candidates.
 * @returns {{ baseline: boolean, new_files: number, recorded: number, ledger: number, missing: { path: string, dir: string }[], residual: number, gap: number, gap_ratio: number, top_dirs: { dir: string, added: number }[], truncated: boolean, ledger_incomplete: boolean, recorded_incomplete: boolean }} the reconciliation.
 */
export function reconcile(input) {
  const after = input.after ?? {};
  const recorded = Number.isFinite(input.recorded) ? Math.max(0, input.recorded) : 0;
  const ledger = Number.isFinite(input.ledger) ? Math.max(0, input.ledger) : 0;
  const truncated = input.truncated === true;
  const ledgerIncomplete = input.ledgerIncomplete === true;
  const recordedIncomplete = input.decisionsIncomplete === true;
  if (input.before === undefined || input.before === null) {
    return {
      baseline: true,
      new_files: 0,
      recorded,
      ledger,
      missing: [],
      residual: 0,
      recorded_files: 0,
      ledger_files: 0,
      gap: 0,
      gap_ratio: 0,
      top_dirs: [],
      truncated,
      ledger_incomplete: ledgerIncomplete,
      recorded_incomplete: recordedIncomplete,
    };
  }

  const beforeDirs = input.before.dirs ?? {};
  const afterDirs = after.dirs ?? {};
  const delta = totalOf(after) - totalOf(input.before);
  const newFiles = Math.max(0, delta);
  const gap = Math.max(0, newFiles - recorded);
  const ratio = newFiles === 0 ? 0 : gap / newFiles;

  const topDirs = [];
  for (const [dir, count] of Object.entries(afterDirs)) {
    const added = count - (Number.isFinite(beforeDirs[dir]) ? beforeDirs[dir] : 0);
    if (added > 0) topDirs.push({ dir, added });
  }
  topDirs.sort((left, right) => right.added - left.added || left.dir.localeCompare(right.dir));

  // A path already accounted for by either channel is not a blind spot; the
  // rest of the candidate list is. Candidates are deduplicated by path because
  // one file can be written several times inside the same window.
  // When either channel cannot cover the window, both the list and the remainder
  // are unknowable: a channel record may name a file the other channel already
  // accounted for, so `residual` would silently absorb the difference. Return
  // null — "cannot be computed" — rather than a zero that reads as "all clear".
  if (ledgerIncomplete || recordedIncomplete) {
    return {
      baseline: false,
      new_files: newFiles,
      recorded,
      ledger,
      recorded_files: null,
      ledger_files: null,
      missing: [],
      residual: null,
      gap,
      gap_ratio: Number(ratio.toFixed(4)),
      top_dirs: topDirs.slice(0, TOP_DIRS_LIMIT),
      truncated,
      ledger_incomplete: ledgerIncomplete,
      recorded_incomplete: recordedIncomplete,
    };
  }

  const recordedPaths = input.recordedPaths ?? new Set();
  const ledgerPaths = input.ledgerPaths ?? new Set();
  const missing = [];
  const counted = new Set();
  for (const candidate of input.candidates ?? []) {
    const path = typeof candidate?.path === 'string' ? candidate.path : '';
    if (path === '' || counted.has(path)) continue;
    if (recordedPaths.has(path) || ledgerPaths.has(path)) continue;
    counted.add(path);
    missing.push({ path, dir: typeof candidate?.dir === 'string' ? candidate.dir : '' });
  }
  // Count the distinct files the channels named, not the number of records:
  // one file written twice is still one accounted file.
  const accounted = new Set([...recordedPaths, ...ledgerPaths]);
  const residual = Math.max(0, newFiles - accounted.size - missing.length);

  return {
    baseline: false,
    new_files: newFiles,
    recorded,
    ledger,
    // The card adds these three numbers together, so they have to be the same
    // unit: files. A file written twice is one file, not two records.
    recorded_files: recordedPaths.size,
    ledger_files: ledgerPaths.size,
    missing,
    residual,
    gap,
    gap_ratio: Number(ratio.toFixed(4)),
    top_dirs: topDirs.slice(0, TOP_DIRS_LIMIT),
    truncated,
    ledger_incomplete: ledgerIncomplete,
    recorded_incomplete: recordedIncomplete,
  };
}
