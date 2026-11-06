/**
 * `catalog.yml` structure validation and normalization.
 *
 * Pure module: it receives the already-parsed YAML value and returns a
 * normalized catalog plus typed diagnostics. YAML syntax errors, file
 * existence and decoding belong to the I/O layer.
 *
 * A catalog carries three things: which directories are routable, what each
 * one is for, and which filename patterns go where. The purpose text is the
 * only field a human must write; everything else has a default.
 * @module file-maid/core/catalog
 */
import { canonicalCatalogPath, validateCatalogPath } from './path.js';

/** Version the plugin accepts. */
export const CATALOG_VERSION = 1;

/** Keys understood at the document root; anything else is reported, not rejected. */
const KNOWN_ROOT_KEYS = new Set(['version', 'root_default', 'dirs', 'rules', 'naming']);

/** Keys understood on one `dirs[]` entry. */
const KNOWN_DIR_KEYS = new Set(['path', 'role', 'purpose', 'includes', 'excludes', 'examples']);

/**
 * Longest purpose sentence a directory may carry.
 *
 * The table is injected into every system prompt, so one runaway sentence costs
 * every session in that root. 200 characters is roughly three typed lines.
 */
export const PURPOSE_MAX = 200;

/** Longest excludes sentence. Same budget, same reason. */
export const EXCLUDES_MAX = 200;

/**
 * `role` and `includes` are retired: still accepted so older catalogs keep loading,
 * never written again. A directory is described by its purpose sentence and its
 * refusal list, which is what both a person and the model read.
 */

/** Keys understood on one `rules[]` entry. */
const KNOWN_RULE_KEYS = new Set(['match', 'dir']);

/**
 * Build one diagnostic record.
 * @param {string} code - diagnostic code.
 * @param {string} message - human-readable detail.
 * @param {string} [at] - field path that carries the problem.
 * @returns {{ code: string, message: string, at?: string }} the record.
 */
function diag(code, message, at) {
  return at === undefined ? { code, message } : { code, message, at };
}

/**
 * Read one optional string array, dropping unusable entries with a warning.
 * @param {unknown} value - declared value.
 * @param {string} at - field path, for diagnostics.
 * @param {object[]} warnings - collector.
 * @returns {string[]} the usable entries, trimmed.
 */
/**
 * Read one sentence field.
 *
 * A sentence is what a person writes and what the model reads, so the field
 * accepts a string. Older catalogs wrote a list; it is joined instead of being
 * rejected, so a catalog made by v5.0 keeps loading verbatim.
 * @param {unknown} value - wire value.
 * @param {string} at - diagnostic location.
 * @param {object[]} warnings - collected warnings.
 * @returns {string} the sentence.
 */
function readSentence(value, at, warnings) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) {
    warnings.push(diag('E_MAID_SCHEMA', `${at} is a list; it is joined into one sentence`, at));
    return value.filter((item) => typeof item === 'string').map((item) => item.trim()).filter((item) => item.length > 0).join('、');
  }
  warnings.push(diag('E_MAID_SCHEMA', `${at} must be a string`, at));
  return '';
}

/**
 * Read a list of words.
 * @param {unknown} value - wire value.
 * @param {string} at - diagnostic location.
 * @param {object[]} warnings - collected warnings.
 * @returns {string[]} the words.
 */
function readStringArray(value, at, warnings) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    warnings.push(diag('E_MAID_SCHEMA', `${at} must be an array; ignored`, at));
    return [];
  }
  const out = [];
  for (const entry of value) {
    if (typeof entry === 'string' && entry.trim().length > 0) out.push(entry.trim());
    else warnings.push(diag('E_MAID_SCHEMA', `${at} contains a non-string entry; ignored`, at));
  }
  return out;
}

/**
 * Validate and normalize one parsed catalog document.
 * @param {unknown} raw - parsed YAML value.
 * @returns {{ ok: boolean, catalog?: object, errors: object[], warnings: object[] }} the verdict.
 */
export function validateCatalog(raw) {
  const errors = [];
  const warnings = [];

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: [diag('E_MAID_SCHEMA', 'catalog must be a mapping at the document root')], warnings };
  }

  const document = /** @type {Record<string, unknown>} */ (raw);
  for (const key of Object.keys(document)) {
    if (!KNOWN_ROOT_KEYS.has(key)) warnings.push(diag('E_MAID_UNKNOWN_KEY', `unknown catalog key ignored: ${key}`, key));
  }

  if (document.version !== CATALOG_VERSION) {
    errors.push(diag('E_MAID_SCHEMA', `version must be ${CATALOG_VERSION}, received ${JSON.stringify(document.version)}`, 'version'));
  }

  const dirs = [];
  const seenPaths = new Set();
  if (!Array.isArray(document.dirs) || document.dirs.length === 0) {
    errors.push(diag('E_MAID_SCHEMA', 'dirs must be a non-empty array', 'dirs'));
  } else {
    document.dirs.forEach((entry, index) => {
      const at = `dirs[${index}]`;
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        errors.push(diag('E_MAID_SCHEMA', `${at} must be a mapping`, at));
        return;
      }
      const record = /** @type {Record<string, unknown>} */ (entry);
      for (const key of Object.keys(record)) {
        if (!KNOWN_DIR_KEYS.has(key)) warnings.push(diag('E_MAID_UNKNOWN_KEY', `unknown key ignored at ${at}: ${key}`, at));
      }
      const pathCheck = validateCatalogPath(record.path);
      if (!pathCheck.ok) {
        errors.push(diag(pathCheck.code, pathCheck.message, at));
        return;
      }
      const path = canonicalCatalogPath(/** @type {string} */ (record.path));
      if (seenPaths.has(path)) {
        errors.push(diag('E_MAID_PATH', `duplicate directory path: ${path}`, at));
        return;
      }
      seenPaths.add(path);
      if (record.purpose !== undefined && typeof record.purpose !== 'string') {
        errors.push(diag('E_MAID_SCHEMA', `${at}.purpose must be a string`, `${at}.purpose`));
        return;
      }
      const purpose = typeof record.purpose === 'string' ? record.purpose.trim() : '';
      if ([...purpose].length > PURPOSE_MAX) {
        errors.push(diag('E_MAID_PURPOSE_LONG', `${at}.purpose is longer than ${PURPOSE_MAX} characters`, `${at}.purpose`));
        return;
      }
      if (purpose.length === 0) {
        // The template ships with empty purposes; a root whose purposes are all
        // empty still loads, it just cannot route well, and the card says so.
        warnings.push(diag('E_MAID_PURPOSE_MISSING', `${at}.purpose is empty; this directory cannot be matched by purpose`, `${at}.purpose`));
      }
      const excludes = readSentence(record.excludes, `${at}.excludes`, warnings);
      if ([...excludes].length > EXCLUDES_MAX) {
        errors.push(diag('E_MAID_EXCLUDES_LONG', `${at}.excludes is longer than ${EXCLUDES_MAX} characters`, `${at}.excludes`));
        return;
      }
      dirs.push({
        path,
        purpose,
        excludes,
        examples: readStringArray(record.examples, `${at}.examples`, warnings),
        index: dirs.length,
      });
    });
  }

  const rootDefaultRaw = document.root_default;
  let rootDefault;
  if (typeof rootDefaultRaw !== 'string' || rootDefaultRaw.trim().length === 0) {
    errors.push(diag('E_MAID_SCHEMA', 'root_default must be a non-empty string', 'root_default'));
  } else {
    rootDefault = canonicalCatalogPath(rootDefaultRaw);
    const match = dirs.find((dir) => dir.path === rootDefault);
    if (match === undefined) {
      errors.push(diag('E_MAID_SCHEMA', `root_default "${rootDefault}" is not declared in dirs`, 'root_default'));
    }
  }

  const rules = [];
  if (document.rules !== undefined) {
    if (!Array.isArray(document.rules)) {
      warnings.push(diag('E_MAID_SCHEMA', 'rules must be an array; ignored', 'rules'));
    } else {
      document.rules.forEach((entry, index) => {
        const at = `rules[${index}]`;
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
          warnings.push(diag('E_MAID_SCHEMA', `${at} must be a mapping; ignored`, at));
          return;
        }
        const record = /** @type {Record<string, unknown>} */ (entry);
        for (const key of Object.keys(record)) {
          if (!KNOWN_RULE_KEYS.has(key)) warnings.push(diag('E_MAID_UNKNOWN_KEY', `unknown key ignored at ${at}: ${key}`, at));
        }
        if (typeof record.match !== 'string' || record.match.trim().length === 0) {
          warnings.push(diag('E_MAID_SCHEMA', `${at}.match must be a non-empty string; ignored`, at));
          return;
        }
        if (typeof record.dir !== 'string' || record.dir.trim().length === 0) {
          warnings.push(diag('E_MAID_SCHEMA', `${at}.dir must be a non-empty string; ignored`, at));
          return;
        }
        const canonical = canonicalCatalogPath(record.dir);
        if (!seenPaths.has(canonical)) {
          warnings.push(diag('E_MAID_SCHEMA', `${at}.dir references an undeclared directory: ${canonical}; rule ignored`, at));
          return;
        }
        rules.push({ match: record.match.trim().toLowerCase(), dir: canonical, index: rules.length });
      });
    }
  }

  if (document.naming !== undefined) {
    warnings.push(diag('E_MAID_NOT_IMPLEMENTED', 'naming rules are declared but not enforced in this version', 'naming'));
  }

  if (errors.length > 0) return { ok: false, errors, warnings };

  return {
    ok: true,
    catalog: { version: CATALOG_VERSION, rootDefault, dirs, rules },
    errors: [],
    warnings,
  };
}

/**
 * Project a catalog onto its declared directories.
 * @param {object} catalog - validated catalog.
 * @returns {object[]} every declared directory, in declaration order.
 */
export function directoriesOf(catalog) {
  return catalog.dirs;
}

/**
 * Find one declared directory by its canonical path.
 * @param {object} catalog - validated catalog.
 * @param {string} path - canonical relative path.
 * @returns {object | undefined} the declared directory.
 */
export function findDirectory(catalog, path) {
  return catalog.dirs.find((dir) => dir.path === path);
}

/**
 * Whether one canonical path is declared, regardless of role.
 * @param {object} catalog - validated catalog.
 * @param {string} path - canonical relative path.
 * @returns {boolean} true when declared.
 */
export function isDeclared(catalog, path) {
  return catalog.dirs.some((dir) => dir.path === path);
}
