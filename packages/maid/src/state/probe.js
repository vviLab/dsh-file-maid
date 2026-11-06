/**
 * Filesystem probes and the atomic writer.
 *
 * Part of the I/O layer (`core ← state ← runtime/surfaces`). It exposes the
 * only `node:fs`-backed primitives the runtime needs: identity metadata for the
 * protection-surface comparison, recursive scans for the snapshot, directory
 * creation with a created-count, and an atomic replace that prefers the Host's
 * `@deepseek-ai/dsh-atomic-write` when that package is resolvable.
 * @module file-maid/state/probe
 */
import { randomBytes } from 'node:crypto';
import { readFileSync, statSync, lstatSync, realpathSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { MAID_SEGMENT, hasMaidSegment } from '../core/path.js';

/** Names a scan never descends into. */
export const SCAN_IGNORED = Object.freeze(['.git', 'node_modules', '.tmp', MAID_SEGMENT, '.DS_Store']);

/** File-count ceiling before a `root`-scoped scan refuses to run (`§8.5`). */
export const SCAN_FILE_BUDGET = 5000;

/** Hard cap on concurrent directory reads; 32 measured no gain over 8. */
export const SCAN_CONCURRENCY_MAX = 8;
/** Floor of the adaptive cap: 1 is the serial behaviour. */
export const SCAN_CONCURRENCY_MIN = 1;
/** Cap used before any latency sample exists. */
export const SCAN_CONCURRENCY_START = 4;
/** Mean `readdir` latency (ms) at or below which the cap may grow. */
export const SCAN_LATENCY_FAST_MS = 0.2;
/** Mean `readdir` latency (ms) above which the cap may shrink. */
export const SCAN_LATENCY_SLOW_MS = 1.5;
/** Reads per latency window. */
export const SCAN_LATENCY_WINDOW = 32;
/** Mount types whose request queues do not benefit from local concurrency. */
const NETWORK_FS = Object.freeze(['smb', 'smbfs', 'cifs', 'nfs', 'nfs4', 'fuse.sshfs', 'afpfs', 'webdav']);

/**
 * Read the pinned cap from the environment.
 *
 * The escape hatch lets an operator force serial I/O without shipping a release
 * when a scan competes with something else on the same disk.
 * @param {Record<string, string | undefined>} [env] - environment to read.
 * @returns {number | undefined} the pinned cap, or undefined for adaptive.
 */
export function scanConcurrency(env = process.env) {
  const raw = env?.FILE_MAID_SCAN_CONCURRENCY;
  if (raw === undefined || raw === '') return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < SCAN_CONCURRENCY_MIN || parsed > SCAN_CONCURRENCY_MAX) return undefined;
  return parsed;
}

/**
 * Pick the starting cap for one directory.
 *
 * Linux exposes the mount type in `/proc/mounts`, so a network mount starts at 2
 * instead of paying for the first slow window. macOS has no equivalent without a
 * subprocess, so it starts at the default and adapts from measurements.
 * @param {string} directory - absolute directory about to be walked.
 * @returns {number} the starting cap.
 */
export function initialLimit(directory) {
  if (process.platform !== 'linux') return SCAN_CONCURRENCY_START;
  try {
    const lines = readFileSync('/proc/mounts', 'utf8').split('\n');
    let bestPoint = '';
    let bestType = '';
    for (const line of lines) {
      const fields = line.split(' ');
      const point = fields[1];
      const type = fields[2];
      if (point === undefined || type === undefined) continue;
      const decoded = point.replace(/\\040/g, ' ').replace(/\\011/g, '\t');
      const prefix = decoded.endsWith('/') ? decoded : `${decoded}/`;
      if (directory !== decoded && !directory.startsWith(prefix)) continue;
      if (decoded.length > bestPoint.length) {
        bestPoint = decoded;
        bestType = type;
      }
    }
    return NETWORK_FS.includes(bestType) ? 2 : SCAN_CONCURRENCY_START;
  } catch {
    return SCAN_CONCURRENCY_START;
  }
}

/**
 * Build one stable identity string for a snapshot entry.
 * @param {{ dev: number, ino: number, size: number, mtime: number }} identity - file identity.
 * @returns {string} the version key.
 */
export function versionKey(identity) {
  return `${identity.dev}:${identity.ino}:${identity.size}:${identity.mtime}`;
}

/** Cached module namespace of the Host atomic writer, or null once it failed. */
let atomicModule;
let atomicProbe;

/**
 * Resolve the Host atomic writer once. `link:` installs resolve imports from
 * the linked package directory, so the package may be unavailable; the local
 * implementation below keeps the same observable contract.
 * @returns {Promise<{ writeFileAtomic: Function } | null>} the module, or null.
 */
async function loadAtomicWriter() {
  if (atomicProbe === undefined) {
    atomicProbe = import('@deepseek-ai/dsh-atomic-write')
      .then((module) => {
        atomicModule = typeof module.writeFileAtomic === 'function' ? module : null;
        return atomicModule;
      })
      .catch(() => {
        atomicModule = null;
        return null;
      });
  }
  return atomicProbe;
}

/**
 * Write a complete file through a same-directory temporary inode and one rename.
 * @param {string} filename - final path.
 * @param {string | Uint8Array} content - complete next content.
 * @param {{ mode: number, dirMode?: number }} options - permission bits.
 * @returns {Promise<void>} fulfillment after the rename committed.
 */
async function writeFileAtomicLocal(filename, content, options) {
  const directory = dirname(filename);
  await fsp.mkdir(directory, { recursive: true, mode: options.dirMode ?? 0o755 });
  const temporary = join(directory, `.${basename(filename)}.${randomBytes(6).toString('hex')}.tmp`);
  let handle;
  try {
    handle = await fsp.open(temporary, 'wx', options.mode);
    await handle.writeFile(content);
  } finally {
    await handle?.close();
  }
  try {
    await fsp.rename(temporary, filename);
  } catch (error) {
    await fsp.rm(temporary, { force: true });
    throw error;
  }
}

/**
 * Replace a file atomically, preferring the Host implementation.
 * @param {string} filename - final path.
 * @param {string | Uint8Array} content - complete next content.
 * @param {{ mode: number, dirMode?: number }} options - permission bits.
 * @returns {Promise<void>} fulfillment after the content is visible.
 */
export async function writeFileAtomic(filename, content, options) {
  const host = await loadAtomicWriter();
  if (host !== null) return host.writeFileAtomic(filename, content, options);
  return writeFileAtomicLocal(filename, content, options);
}

/**
 * Read one path's identity metadata without following a final symlink.
 * @param {string} path - absolute path.
 * @returns {{ dev: number, ino: number, size: number, mtime: number, kind: 'file'|'directory'|'symlink'|'other' } | undefined} metadata, or undefined when absent.
 */
export function identityOf(path) {
  try {
    const info = lstatSync(path);
    const kind = info.isSymbolicLink() ? 'symlink' : info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other';
    // `ctimeMs` is the inode-change clock: unlike mtime it cannot be preserved
    // by `cp -p` or a timestamp-restoring extract, so it is the only reliable
    // "did this change since T" signal available from a plain stat.
    return { dev: info.dev, ino: info.ino, size: info.size, mtime: info.mtimeMs, ctime: info.ctimeMs, kind };
  } catch {
    return undefined;
  }
}

/**
 * Describe one path without following a final symlink.
 * @param {string} path - absolute path.
 * @returns {'file'|'directory'|'symlink'|'other'|'absent'|'unknown'} the entry kind.
 */
export function pathKind(path) {
  try {
    const info = lstatSync(path);
    if (info.isSymbolicLink()) return 'symlink';
    if (info.isDirectory()) return 'directory';
    if (info.isFile()) return 'file';
    return 'other';
  } catch (error) {
    return error?.code === 'ENOENT' ? 'absent' : 'unknown';
  }
}

/**
 * Collect the protection-surface identities of one controlled root (`§3.5`).
 *
 * The surface is `<root>/.maid`. Its absence is not a protection: nothing can
 * be inside a directory that does not exist, and the lexical segment check
 * already refuses that spelling.
 * @param {string[]} roots - absolute directories whose `.maid` is protected.
 * @returns {{ protections: { path: string, dev: number, ino: number }[], failed: string[] }} identities found, plus directories whose probe failed.
 */
export function protectionIdentities(roots) {
  const protections = [];
  const failed = [];
  const seen = new Set();
  for (const absoluteRoot of roots) {
    if (typeof absoluteRoot !== 'string' || absoluteRoot.length === 0) continue;
    const maidPath = join(absoluteRoot, MAID_SEGMENT);
    if (seen.has(maidPath)) continue;
    seen.add(maidPath);
    const identity = identityOf(maidPath);
    if (identity === undefined) {
      const kind = pathKind(maidPath);
      if (kind === 'unknown') failed.push(maidPath);
      continue;
    }
    protections.push({ path: maidPath, dev: identity.dev, ino: identity.ino });
  }
  return { protections, failed };
}

/**
 * Walk one candidate path's ancestors and compare `(dev, ino)` with the
 * protection identities (`§3.5`, `D-09`).
 * @param {string} target - normalized absolute path.
 * @param {{ path: string, dev: number, ino: number }[]} protections - protection identities.
 * @returns {{ hit: boolean, via?: string, unknown?: boolean }} the verdict.
 */
export function identityHit(target, protections) {
  if (protections.length === 0) return { hit: false };
  let current = target;
  for (let guard = 0; guard < 256; guard += 1) {
    let info;
    try {
      info = statSync(current);
    } catch (error) {
      const code = error?.code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return { hit: false, unknown: true };
      const parent = dirname(current);
      if (parent === current) return { hit: false };
      current = parent;
      continue;
    }
    // `statSync` follows symlinks, so `info` may describe a file inside the protected
    // directory while the spelled path shares no prefix with it. Resolve the deepest
    // existing node first and judge only its physical identity and physical ancestors.
    let physical = current;
    try {
      physical = realpathSync(current);
    } catch {
      physical = current;
    }
    if (hasMaidSegment(physical)) return { hit: true, via: physical };
    let node = physical;
    for (let depth = 0; depth < 256; depth += 1) {
      let nodeInfo;
      try {
        nodeInfo = statSync(node);
      } catch {
        break;
      }
      for (const protection of protections) {
        if (protection.dev === nodeInfo.dev && protection.ino === nodeInfo.ino) {
          return { hit: true, via: protection.path };
        }
      }
      const parent = dirname(node);
      if (parent === node) break;
      node = parent;
    }
    return { hit: false };
  }
  return { hit: false, unknown: true };
}

/**
 * Decide whether one absolute path belongs to the protection surface.
 *
 * Order follows `§3.5`: a lexical `.maid` segment refuses at once; an
 * unprobeable `.maid` directory refuses because the surface cannot be
 * falsified; otherwise only an inode hit refuses. An unreadable ancestor of a
 * path that does not name `.maid` stays allowed (`X-03`).
 * @param {string} target - normalized absolute path.
 * @param {{ protections: { path: string, dev: number, ino: number }[], failed: string[] }} surface - protection data.
 * @returns {'LEXICAL'|'INODE'|'UNVERIFIED'|undefined} the refusal reason, or undefined to allow.
 */
export function protectionVerdict(target, surface) {
  if (hasMaidSegment(target)) return 'LEXICAL';
  if (surface.failed.length > 0) return 'UNVERIFIED';
  if (identityHit(target, surface.protections).hit) return 'INODE';
  return undefined;
}

/**
 * Create a directory tree and report how many levels were new.
 * @param {string} directory - absolute directory to create.
 * @param {number} mode - permission bits for created levels.
 * @returns {Promise<number>} number of created directory levels.
 */
export async function ensureDirectory(directory, mode) {
  let missing = 0;
  let current = directory;
  for (let guard = 0; guard < 256; guard += 1) {
    try {
      const info = await fsp.stat(current);
      if (!info.isDirectory()) throw new Error(`not a directory: ${current}`);
      break;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      missing += 1;
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  await fsp.mkdir(directory, { recursive: true, mode });
  return missing;
}

/**
 * Recursively scan one directory tree for the snapshot (`§11.2`).
 *
 * The walk is concurrent because `readdir` dominates a scan: on the reference
 * workspace 649 directory reads take 20-24 ms while 4,162 `lstat` calls take
 * about 10 ms. The cap adapts to the measured `readdir` latency, so a network
 * mount degrades toward serial instead of oversubscribing its request queue.
 * Symbolic links are recorded but never descended into: `readdir` reports them
 * as non-directories, so the walk stays inside the controlled root.
 * @param {string} directory - absolute directory to scan.
 * @param {{ ignore?: readonly string[], maxFiles?: number, signal?: AbortSignal, concurrency?: number, now?: () => number, readdir?: Function }} [options] - scan controls; `concurrency` pins the cap and disables the adaptive step.
 * @returns {Promise<{ entries: Record<string, object>, files: number, dirs: number, truncated: boolean }>} snapshot section.
 */
export async function scanTree(directory, options = {}) {
  const ignore = new Set(options.ignore ?? SCAN_IGNORED);
  const maxFiles = options.maxFiles ?? Number.POSITIVE_INFINITY;
  const readdir = options.readdir ?? fsp.readdir;
  const now = options.now ?? Date.now;
  const pinned = Number.isInteger(options.concurrency) && options.concurrency >= 1
    ? Math.min(options.concurrency, SCAN_CONCURRENCY_MAX)
    : scanConcurrency();

  const entries = {};
  let files = 0;
  let dirs = 0;
  let truncated = false;

  /** Directories still to read, relative to `directory`; '' is the root itself. */
  const queue = [''];
  /** Directory reads currently awaiting the filesystem. */
  let active = 0;
  /** Workers parked because the queue is empty or the cap is reached. */
  const waiters = new Set();
  let limit = pinned ?? initialLimit(directory);
  let slowBatches = 0;
  let samples = [];
  let firstError;

  const wake = () => {
    if (waiters.size === 0) return;
    for (const resolve of waiters) resolve();
    waiters.clear();
  };
  const park = () => new Promise((resolve) => waiters.add(resolve));

  /**
   * Adjust the cap from the mean latency of the last window.
   * One slow window is not enough evidence: a cold page cache or a backup job
   * makes a single window slow, and dropping to serial on that would be sticky.
   * @param {number} elapsed - milliseconds spent in one `readdir`.
   */
  const recordLatency = (elapsed) => {
    if (pinned !== undefined) return;
    samples.push(elapsed);
    if (samples.length < SCAN_LATENCY_WINDOW) return;
    const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
    samples = [];
    if (mean > SCAN_LATENCY_SLOW_MS) {
      slowBatches += 1;
      if (slowBatches >= 2 && limit > SCAN_CONCURRENCY_MIN) {
        limit = Math.max(SCAN_CONCURRENCY_MIN, Math.floor(limit / 2));
        wake();
      }
      return;
    }
    slowBatches = 0;
    if (mean <= SCAN_LATENCY_FAST_MS && limit < SCAN_CONCURRENCY_MAX) {
      limit = Math.min(SCAN_CONCURRENCY_MAX, limit + 2);
      wake();
    }
  };

  const take = async () => {
    for (;;) {
      if (options.signal?.aborted || firstError !== undefined) return undefined;
      if (queue.length === 0) {
        if (active === 0) return undefined;
        await park();
        continue;
      }
      if (active >= limit) {
        await park();
        continue;
      }
      const relative = queue.pop();
      active += 1;
      return relative;
    }
  };

  const worker = async () => {
    for (let relative = await take(); relative !== undefined; relative = await take()) {
      const absoluteDir = relative === '' ? directory : join(directory, ...relative.split('/'));
      const startedAt = now();
      let children;
      try {
        children = await readdir(absoluteDir, { withFileTypes: true });
      } catch (error) {
        active -= 1;
        wake();
        if (error?.code === 'ENOENT' || error?.code === 'EACCES' || error?.code === 'ENOTDIR') continue;
        firstError = error;
        queue.length = 0;
        wake();
        return;
      }
      recordLatency(now() - startedAt);
      children.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
      for (const child of children) {
        if (ignore.has(child.name)) continue;
        if (child.name === '.DS_Store' || child.name === '._.DS_Store') continue;
        const relativeChild = relative === '' ? child.name : `${relative}/${child.name}`;
        if (child.isDirectory()) {
          dirs += 1;
          queue.push(relativeChild);
          continue;
        }
        const identity = identityOf(join(absoluteDir, child.name));
        if (identity === undefined) continue;
        files += 1;
        if (files > maxFiles) {
          truncated = true;
          queue.length = 0;
          break;
        }
        entries[relativeChild] = {
          size: identity.size,
          mtime: Math.round(identity.mtime),
          ctime: Math.round(identity.ctime),
          version: versionKey({ dev: identity.dev, ino: identity.ino, size: identity.size, mtime: Math.round(identity.mtime) }),
        };
      }
      // Children are queued before the slot is released: releasing first leaves an
      // instant where the queue is empty and no read is in flight, so the other
      // workers conclude the walk is over and the pool collapses to serial.
      active -= 1;
      wake();
    }
  };

  await Promise.all(Array.from({ length: SCAN_CONCURRENCY_MAX }, worker));
  if (firstError !== undefined) throw firstError;

  // A concurrent walk fills `entries` in whatever order the workers finish; the
  // snapshot has to be reproducible, so rebuild it in code-point order.
  const sorted = {};
  for (const key of Object.keys(entries).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))) {
    sorted[key] = entries[key];
  }
  return { entries: sorted, files, dirs, truncated };
}

/**
 * Read a file as UTF-8 text.
 * @param {string} path - absolute path.
 * @returns {Promise<string | undefined>} the content, or undefined when absent or unreadable.
 */
export async function readTextFile(path) {
  try {
    return await fsp.readFile(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * Rename one path, tolerating a missing source.
 * @param {string} from - source path.
 * @param {string} to - destination path.
 * @returns {Promise<boolean>} whether the rename happened.
 */
export async function renameIfPresent(from, to) {
  try {
    await fsp.rename(from, to);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Remove one path, tolerating absence.
 * @param {string} path - path to delete.
 * @returns {Promise<void>} always fulfills.
 */
export async function removeIfPresent(path) {
  await fsp.rm(path, { force: true });
}

/**
 * Append UTF-8 text to one file, creating it with `mode` when absent.
 * @param {string} path - absolute file path.
 * @param {string} text - content to append.
 * @param {number} mode - permission bits for a newly created file.
 * @returns {Promise<void>} fulfillment after the append.
 */
export async function appendText(path, text, mode) {
  await fsp.appendFile(path, text, { encoding: 'utf8', mode });
}

/**
 * List one directory's entries without descending.
 * @param {string} directory - absolute directory.
 * @returns {Promise<import('node:fs').Dirent[]>} directory entries, sorted by name.
 */
export async function listDirectory(directory) {
  try {
    const entries = await fsp.readdir(directory, { withFileTypes: true });
    return entries.sort((left, right) => left.name.localeCompare(right.name));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}
