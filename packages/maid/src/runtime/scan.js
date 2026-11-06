/**
 * Managed-union scan: walk every declared directory, count files per
 * directory, and hand back a snapshot the reconciler can compare.
 *
 * The scan is read-only. It never judges a file, never moves one, and never
 * fails a tool call because one directory is missing — a directory that was
 * deleted is reported as empty, which is exactly what the next reconciliation
 * needs to see.
 * @module file-maid/runtime/scan
 */
import { join, sep } from 'node:path';
import * as probe from '../state/probe.js';

/** Elapsed time after which one managed scan is reported as degraded. */
export const MANAGED_SCAN_BUDGET_MS = 300;

/** Upper bound on the changed-file list carried out of one scan. */
export const CANDIDATE_LIMIT = 500;

/**
 * Walk every declared directory of one catalog.
 *
 * A directory declared as `10-Projects/50-x` sits inside its ancestor's tree.
 * Counting it twice would inflate the file count and make the next
 * reconciliation report phantom additions, so files are deduplicated by their
 * absolute path and attributed to the shallowest declaration.
 * @param {{ root: string, catalog: object, signal?: AbortSignal, now?: () => number, since?: number }} input - scan inputs; `since` asks for files whose ctime is at or after that epoch millisecond.
 * @returns {Promise<{ sections: Record<string, { files: number }>, files: number, dirs: number, elapsed: number, degraded: boolean, candidates: { path: string, dir: string, ctime: number }[], candidatesTruncated: boolean }>} the snapshot.
 */
export async function scanManaged(input) {
  const now = input.now ?? Date.now;
  const startedAt = now();
  const sections = {};
  const seen = new Set();
  let files = 0;
  let dirs = 0;
  let bytes = 0;
  const candidates = [];
  let candidatesTruncated = false;
  const since = Number.isFinite(input.since) ? input.since : undefined;

  const depth = (path) => path.split('/').length;
  const ordered = [...input.catalog.dirs].sort(
    (left, right) => depth(left.path) - depth(right.path) || left.path.localeCompare(right.path),
  );

  // Overlap only exists when one declared directory sits inside another. Without
  // that, the union is the plain sum and the dedupe set (plus the absolute path
  // it needs for every file) can be skipped entirely.
  const declared = ordered.map((entry) => entry.path);
  const nested = declared.some((outer) => declared.some((inner) => inner !== outer && inner.startsWith(`${outer}/`)));

  for (const dir of ordered) {
    if (input.signal?.aborted) break;
    const section = await probe.scanTree(join(input.root, dir.path), { signal: input.signal });
    let own = 0;
    let ownBytes = 0;
    // One prefix per declared directory: rebuilding the absolute path with `join`
    // for every file allocated tens of thousands of strings on the reference tree.
    const prefix = nested ? join(input.root, dir.path) + sep : '';
    for (const [relative, meta] of Object.entries(section.entries)) {
      if (nested) {
        const absolute = relative.includes('/') ? prefix + relative.split('/').join(sep) : prefix + relative;
        if (seen.has(absolute)) continue;
        seen.add(absolute);
      }
      own += 1;
      files += 1;
      ownBytes += Number.isFinite(meta?.size) ? meta.size : 0;
      if (since !== undefined && Number.isFinite(meta?.ctime) && meta.ctime >= since) {
        // Collected in full and cut after sorting: the walk is concurrent, so the
        // arrival order is not reproducible, and the truncation point has to be.
        candidates.push({
          path: `${dir.path}/${relative}`,
          dir: dir.path,
          ctime: meta.ctime,
          size: Number.isFinite(meta?.size) ? meta.size : null,
          kind: typeof meta?.kind === 'string' ? meta.kind : 'file',
        });
      }
    }
    bytes += ownBytes;
    sections[dir.path] = { files: own, bytes: ownBytes };
    dirs += section.dirs;
  }

  // Newest first, path as the tie-break: the card shows "the newest few", so the
  // truncation has to keep the newest few, and two runs must agree on which.
  candidates.sort((left, right) => right.ctime - left.ctime
    || (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  if (candidates.length > CANDIDATE_LIMIT) {
    candidates.length = CANDIDATE_LIMIT;
    candidatesTruncated = true;
  }

  const elapsed = now() - startedAt;
  return {
    sections,
    files,
    bytes,
    dirs,
    elapsed,
    degraded: elapsed > MANAGED_SCAN_BUDGET_MS,
    candidates,
    candidatesTruncated,
  };
}

/**
 * Reduce a scan result to the shape stored in `index.json` and compared by
 * the reconciler.
 * @param {{ sections: Record<string, { files: number }>, files: number }} scan - one scan result.
 * @returns {{ files: number, dirs: Record<string, number> }} the snapshot.
 */
export function snapshotOf(scan) {
  const dirs = {};
  for (const [path, section] of Object.entries(scan.sections ?? {})) dirs[path] = section.files;
  return { files: scan.files ?? 0, dirs };
}

/**
 * Read the snapshot back out of one `index.json` document.
 * @param {object | undefined} index - stored snapshot document.
 * @returns {{ files: number, dirs: Record<string, number> } | undefined} the snapshot, or undefined when the baseline predates this format.
 */
export function snapshotFromIndex(index) {
  if (index === undefined || index === null || typeof index !== 'object') return undefined;
  const roots = index.roots;
  if (roots === null || typeof roots !== 'object') return undefined;
  const dirs = {};
  let files = 0;
  for (const [path, section] of Object.entries(roots)) {
    const count = Number.isFinite(section?.files)
      ? section.files
      : Object.keys(section?.entries ?? {}).length;
    dirs[path] = count;
    files += count;
  }
  return { files, dirs };
}
