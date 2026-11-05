/**
 * Path normalization and protection-surface predicates.
 *
 * Pure module: no `node:fs` access, no environment reads. Every home-directory
 * expansion receives `home` from the caller so the predicates stay testable.
 * @module file-maid/core/path
 */
import { isAbsolute, normalize, relative, resolve, sep } from 'node:path';

/** Independent path segment that names the plugin-owned data directory. */
export const MAID_SEGMENT = '.maid';

/** Segments the catalog never accepts as a directory of its own. */
export const RESERVED_SEGMENTS = Object.freeze(['.git', 'node_modules', '.tmp', MAID_SEGMENT, '.DS_Store']);

/** Maximum accepted segment count for a `catalog.yml` directory path. */
export const MAX_CATALOG_DEPTH = 3;

/**
 * Replace a leading `~` with the caller's home directory, keeping the rest of
 * the spelling so parent traversal still resolves physically.
 * Mirrors `expandHomePrefix` in `@deepseek-ai/dsh-fs-local`.
 * @param {unknown} path - caller-supplied path.
 * @param {string} home - absolute home directory.
 * @returns {string | undefined} the expanded path, or undefined for a non-string.
 */
export function expandHomePrefix(path, home) {
  if (typeof path !== 'string' || path.length === 0) return undefined;
  if (path === '~' || path.startsWith('~/')) return `${home}${path.slice(1)}`;
  return path;
}

/**
 * Resolve one caller-supplied path against one base directory.
 * @param {string | undefined} base - absolute base directory, or undefined when unknown.
 * @param {unknown} path - caller-supplied path.
 * @param {string} home - absolute home directory.
 * @returns {string | undefined} the normalized absolute path, or undefined when it cannot be resolved.
 */
export function resolveAgainst(base, path, home) {
  const expanded = expandHomePrefix(path, home);
  if (expanded === undefined) return undefined;
  if (isAbsolute(expanded)) return normalize(expanded);
  if (typeof base !== 'string' || !isAbsolute(base)) return undefined;
  return normalize(resolve(base, expanded));
}

/**
 * Split a path into its non-empty segments.
 * @param {string} path - path in either separator spelling.
 * @returns {string[]} its segments.
 */
export function segments(path) {
  return path.split(/[\\/]+/u).filter((segment) => segment.length > 0);
}

/**
 * Whether the path contains one exact segment.
 * @param {string} path - candidate path.
 * @param {string} segment - exact segment to look for.
 * @returns {boolean} true when a segment equals `segment`.
 */
export function hasSegment(path, segment) {
  return segments(path).includes(segment);
}

/**
 * Whether the path lexically names the plugin-owned data directory.
 * @param {string} path - candidate path.
 * @returns {boolean} true for a standalone `.maid` segment anywhere in the path.
 */
export function hasMaidSegment(path) {
  return hasSegment(path, MAID_SEGMENT);
}

/**
 * Spell a path relative to one base, in `/` spelling.
 * @param {string} base - absolute base directory.
 * @param {string} path - absolute path inside that base.
 * @returns {string | undefined} the relative path, or undefined when `path` leaves `base`.
 */
export function relativeTo(base, path) {
  const rel = relative(base, path);
  if (rel === '') return '';
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
  return rel.split(sep).join('/');
}

/**
 * Whether `path` equals `base` or sits anywhere below it.
 * @param {string} base - absolute base directory.
 * @param {string} path - absolute candidate path.
 * @returns {boolean} true when `path` is inside `base`.
 */
export function isInside(base, path) {
  return relativeTo(base, path) !== undefined;
}

/**
 * Validate one `catalog.yml` directory path.
 * @param {unknown} path - declared directory path.
 * @returns {{ ok: true } | { ok: false, code: string, message: string }} the verdict.
 */
export function validateCatalogPath(path) {
  if (typeof path !== 'string' || path.trim().length === 0) {
    return { ok: false, code: 'E_MAID_PATH', message: 'dirs[].path must be a non-empty string' };
  }
  const value = path.trim();
  if (value.startsWith('~')) {
    return { ok: false, code: 'E_MAID_PATH', message: `dirs[].path must not start with "~": ${value}` };
  }
  if (isAbsolute(value) || /^[a-zA-Z]:/u.test(value)) {
    return { ok: false, code: 'E_MAID_PATH', message: `dirs[].path must be relative to the controlled root: ${value}` };
  }
  const parts = segments(value);
  if (parts.length === 0) {
    return { ok: false, code: 'E_MAID_PATH', message: `dirs[].path has no segments: ${value}` };
  }
  if (parts.includes('..') || parts.includes('.')) {
    return { ok: false, code: 'E_MAID_PATH', message: `dirs[].path must not traverse: ${value}` };
  }
  if (parts.length > MAX_CATALOG_DEPTH) {
    return { ok: false, code: 'E_MAID_PATH', message: `dirs[].path depth ${parts.length} exceeds ${MAX_CATALOG_DEPTH}: ${value}` };
  }
  for (const part of parts) {
    if (RESERVED_SEGMENTS.includes(part)) {
      return { ok: false, code: 'E_MAID_PATH', message: `dirs[].path uses the reserved segment "${part}": ${value}` };
    }
  }
  return { ok: true };
}

/**
 * Normalize a catalog directory path to its canonical relative spelling.
 * @param {string} path - validated directory path.
 * @returns {string} slash-separated, trimmed spelling without trailing slash.
 */
export function canonicalCatalogPath(path) {
  return segments(path.trim()).join('/');
}
