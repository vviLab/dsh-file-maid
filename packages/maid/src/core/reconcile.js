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
 * @param {{ before?: { dirs?: Record<string, number>, files?: number }, after: { dirs?: Record<string, number>, files?: number }, recorded: number, ledger?: number, candidates?: { path: string, dir: string, ctime?: number, mtime?: number, size?: number, kind?: string }[], recordedPaths?: Set<string>, ledgerPaths?: Set<string>, acknowledged?: Set<string>, truncated?: boolean, ledgerIncomplete?: boolean, decisionsIncomplete?: boolean, decisionsRotatedAt?: number }} input - snapshots, channel counts, changed-file candidates, acknowledged keys (`path@ctime`), and where the decisions log rotated.
 * @returns {{ baseline: boolean, new_files: number, recorded: number, ledger: number, missing: { path: string, dir: string, ctime: number | null, size: number | null, kind: string }[], residual: number, gap: number, gap_ratio: number, top_dirs: { dir: string, added: number }[], truncated: boolean, ledger_incomplete: boolean, recorded_incomplete: boolean }} the reconciliation.
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
  // A rotation inside the window hides records for everything written before it.
  // Records after the rotation cannot have been rotated away, so that slice can
  // still be named; only the earlier slice has to stay a count.
  const canSplit = recordedIncomplete && !ledgerIncomplete && Number.isFinite(input.decisionsRotatedAt);
  if (canSplit) {
    const rotatedAt = Number(input.decisionsRotatedAt);
    const evaluable = [];
    let unknown = 0;
    for (const candidate of input.candidates ?? []) {
      const ctime = Number.isFinite(candidate?.ctime) ? Number(candidate.ctime) : 0;
      // Strictly after: a file written in the same millisecond as the rotation may
      // have landed in the rotated file, and guessing there is how a list lies.
      if (ctime > rotatedAt) evaluable.push(candidate);
      else unknown += 1;
    }
    const inner = reconcile({ ...input, decisionsIncomplete: false, decisionsRotatedAt: undefined, candidates: evaluable });
    const known = inner.missing_total;
    return {
      ...inner,
      recorded_incomplete: true,
      // The slice after the rotation is named; the earlier one is counted only.
      unknown_files: unknown,
      missing_total: known === null ? null : known + unknown,
      residual: null,
      gap: inner.gap === null ? null : inner.gap + unknown,
      gap_ratio: null,
    };
  }

  if (ledgerIncomplete || recordedIncomplete) {
    return {
      baseline: false,
      new_files: newFiles,
      recorded,
      ledger,
      recorded_files: null,
      ledger_files: null,
      missing: [],
      acknowledged_files: null,
      unknown_files: null,
      missing_total: null,
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
  const acknowledgedKeys = input.acknowledged ?? new Set();
  const missing = [];
  let acknowledgedFiles = 0;
  const counted = new Set();
  for (const candidate of input.candidates ?? []) {
    const path = typeof candidate?.path === 'string' ? candidate.path : '';
    if (path === '' || counted.has(path)) continue;
    if (recordedPaths.has(path) || ledgerPaths.has(path)) continue;
    counted.add(path);
    const ctime = Number.isFinite(candidate?.ctime) ? candidate.ctime : null;
    if (ctime !== null && acknowledgedKeys.has(`${path}@${ctime}`)) {
      // Still a new file, just one a human has already looked at: it leaves the
      // list but stays in the arithmetic, otherwise it would resurface as residual.
      acknowledgedFiles += 1;
      continue;
    }
    // Rich fields travel with the entry so a reviewer can tell a 2 KB note from a
    // 40 MB video; the card's projection strips them again (see `roots.project`).
    missing.push({
      path,
      dir: typeof candidate?.dir === 'string' ? candidate.dir : '',
      ctime,
      mtime: Number.isFinite(candidate?.mtime) ? candidate.mtime : null,
      size: Number.isFinite(candidate?.size) ? candidate.size : null,
      kind: typeof candidate?.kind === 'string' ? candidate.kind : 'file',
    });
  }
  // Count the distinct files the channels named, not the number of records:
  // one file written twice is still one accounted file.
  const accounted = new Set([...recordedPaths, ...ledgerPaths]);
  const missingTotal = missing.length + acknowledgedFiles;
  const residual = Math.max(0, newFiles - accounted.size - missingTotal);

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
    acknowledged_files: acknowledgedFiles,
    unknown_files: 0,
    missing_total: missingTotal,
    residual,
    gap,
    gap_ratio: Number(ratio.toFixed(4)),
    top_dirs: topDirs.slice(0, TOP_DIRS_LIMIT),
    truncated,
    ledger_incomplete: ledgerIncomplete,
    recorded_incomplete: recordedIncomplete,
  };
}
