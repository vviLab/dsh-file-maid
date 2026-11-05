/**
 * The single persistence layer for the plugin (`§11`).
 *
 * Everything that reads or writes [`catalog.yml`, `index.json`, the four
 * `.jsonl` streams, reports, the `opt-out` marker] lives here. Callers above
 * this layer never import `node:fs`.
 * @module file-maid/state/store
 */
import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';
import * as YAML from 'yaml';
import { canonicalCatalogPath, segments, validateCatalogPath, MAID_SEGMENT } from '../core/path.js';
import { validateCatalog } from '../core/catalog.js';
import * as probe from './probe.js';

/** Plugin-owned data directory name inside the controlled root. */
export const MAID_DIR_NAME = MAID_SEGMENT;

/** File names inside `.maid`. */
export const FILES = Object.freeze({
  catalog: 'catalog.yml',
  index: 'index.json',
  status: 'status.json',
  optOut: 'opt-out',
  reports: 'reports',
  rotation: 'rotation.json',
});

/** Snapshot schema version written to `index.json`. */
export const INDEX_SCHEMA_VERSION = '1';

/**
 * Snapshot schema version written to `status.json`.
 *
 * `status.json` is a projection of state the plugin already holds in memory,
 * written for the read-only Web panel: it lets the browser show the validated
 * catalog and the last scan without parsing YAML or reaching into the runtime.
 * Nothing reads it back to decide anything, so a stale or deleted file only
 * degrades the panel to an empty view.
 */
export const STATUS_SCHEMA_VERSION = '1';

/** Recent misplaced records the status projection carries (`§10.6`). */
export const STATUS_MISPLACED_KEPT = 10;

/** Log stream names; each maps to `<name>.jsonl` (`§11.3`). */
export const LOG_STREAMS = Object.freeze(['decisions', 'guard', 'audit', 'writes']);

/** Rotation budget for one `.jsonl` stream (`§11.4`). */
export const LOG_BYTES_LIMIT = 1024 * 1024;
export const LOG_FILES_KEPT = 10;

/** Retention budget for scan reports (`§11.4`). */
export const REPORT_FILES_KEPT = 30;
export const REPORT_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Compute every path the plugin owns inside one root.
 * @param {string} root - absolute controlled root.
 * @returns {object} the path table.
 */
export function pathsFor(root) {
  const maid = join(root, MAID_DIR_NAME);
  const logs = {};
  for (const stream of LOG_STREAMS) logs[stream] = join(maid, `${stream}.jsonl`);
  return {
    root,
    maid,
    catalog: join(maid, FILES.catalog),
    index: join(maid, FILES.index),
    status: join(maid, FILES.status),
    optOut: join(maid, FILES.optOut),
    reports: join(maid, FILES.reports),
    rotation: join(maid, FILES.rotation),
    logs,
  };
}

/**
 * Hash a catalog document for `index.json` (`§11.2`).
 * @param {string} text - catalog source text.
 * @returns {string} `sha256:<hex>`.
 */
export function hashCatalog(text) {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

/**
 * Whether one `.maid` file exists.
 * @param {string} path - absolute path.
 * @returns {Promise<boolean>} true when the path exists.
 */
async function exists(path) {
  return (await probe.pathKind(path)) !== 'absent';
}

/**
 * Ensure `.maid` exists with the documented permissions (`§11.1`, `S-08`).
 * @param {string} root - absolute controlled root.
 * @returns {Promise<object>} the path table.
 */
export async function ensureMaidDir(root) {
  const paths = pathsFor(root);
  await probe.ensureDirectory(paths.maid, 0o700);
  return paths;
}

/**
 * Report each declared directory whose path crosses a symbolic link (`§4.2`).
 * @param {string} root - absolute controlled root.
 * @param {object[]} dirs - validated directories.
 * @returns {Promise<object[]>} one `E_MAID_PATH` diagnostic per offending path.
 */
async function checkDirectoryLinks(root, dirs) {
  const errors = [];
  for (const dir of dirs) {
    const parts = segments(dir.path);
    for (let depth = 1; depth <= parts.length; depth += 1) {
      const candidate = join(root, ...parts.slice(0, depth));
      const kind = await probe.pathKind(candidate);
      if (kind === 'symlink') {
        errors.push({ code: 'E_MAID_PATH', message: `dirs[].path must not cross a symbolic link: ${parts.slice(0, depth).join('/')}`, at: dir.path });
        break;
      }
      if (kind === 'absent') break;
    }
  }
  return errors;
}

/**
 * Load and validate the catalog (`§4.3` steps 1-4).
 * @param {string} root - absolute controlled root.
 * @returns {Promise<{ state: 'MANAGED'|'NOT_MANAGED'|'UNINITIALIZED'|'ERROR', catalog?: object, text?: string, hash?: string, errors: object[], warnings: object[] }>} the load result.
 */
export async function readCatalog(root) {
  const paths = pathsFor(root);
  const warnings = [];
  const hasCatalog = await exists(paths.catalog);
  const hasOptOut = await exists(paths.optOut);

  if (hasOptOut) {
    if (hasCatalog) warnings.push({ code: 'E_MAID_STATE', message: 'both catalog.yml and opt-out exist; opt-out wins' });
    return { state: 'NOT_MANAGED', errors: [], warnings };
  }
  if (!hasCatalog) return { state: 'UNINITIALIZED', errors: [], warnings };

  const text = await probe.readTextFile(paths.catalog);
  if (text === undefined) return { state: 'UNINITIALIZED', errors: [], warnings };

  let raw;
  try {
    raw = YAML.parse(text);
  } catch (error) {
    const position = Array.isArray(error?.linePos) && error.linePos[0] !== undefined ? error.linePos[0] : undefined;
    const at = position === undefined ? undefined : `line ${position.line} column ${position.col}`;
    return {
      state: 'ERROR',
      text,
      hash: hashCatalog(text),
      errors: [{ code: 'E_MAID_YAML', message: `catalog.yml is not valid YAML: ${error?.message ?? String(error)}`, ...(at === undefined ? {} : { at }) }],
      warnings,
    };
  }

  const verdict = validateCatalog(raw);
  warnings.push(...verdict.warnings);
  if (!verdict.ok) {
    return { state: 'ERROR', text, hash: hashCatalog(text), errors: verdict.errors, warnings };
  }
  const linkErrors = await checkDirectoryLinks(root, verdict.catalog.dirs);
  if (linkErrors.length > 0) {
    return { state: 'ERROR', text, hash: hashCatalog(text), errors: linkErrors, warnings };
  }
  return { state: 'MANAGED', catalog: verdict.catalog, text, hash: hashCatalog(text), errors: [], warnings };
}

/**
 * Read the stored snapshot, quarantining a corrupt file (`§13.5` P-05).
 * @param {string} root - absolute controlled root.
 * @returns {Promise<{ index?: object, warning?: object }>} the snapshot, when readable.
 */
export async function readIndex(root) {
  const paths = pathsFor(root);
  const text = await probe.readTextFile(paths.index);
  if (text === undefined) return {};
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object') throw new Error('index.json must contain an object');
    return { index: parsed };
  } catch (error) {
    const quarantined = `${paths.index}.corrupt-${Date.now()}`;
    await probe.renameIfPresent(paths.index, quarantined);
    return {
      warning: {
        code: 'E_MAID_INDEX_CORRUPT',
        message: `index.json was unreadable (${error?.message ?? String(error)}); quarantined as ${basename(quarantined)} and rebuilt`,
      },
    };
  }
}

/**
 * Replace `index.json` atomically with `0600`.
 * @param {string} root - absolute controlled root.
 * @param {object} index - snapshot document.
 * @returns {Promise<void>} fulfillment after the write committed.
 */
export async function writeIndex(root, index) {
  const paths = await ensureMaidDir(root);
  await probe.writeFileAtomic(paths.index, `${JSON.stringify(index, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 });
}

/**
 * Write the read-only status projection the Web panel reads.
 *
 * The file is plugin-owned data written through the same atomic path as
 * `index.json`; no decision ever reads it back (`D-12`).
 * @param {string} root - absolute controlled root.
 * @param {object} status - status document.
 * @returns {Promise<void>} fulfillment after the write committed.
 */
export async function writeStatus(root, status) {
  const paths = await ensureMaidDir(root);
  await probe.writeFileAtomic(paths.status, `${JSON.stringify(status, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 });
}

/**
 * Read the status projection, tolerating an absent or unreadable file.
 * @param {string} root - absolute controlled root.
 * @returns {Promise<object|undefined>} the document, or undefined when absent.
 */
export async function readStatus(root) {
  const paths = pathsFor(root);
  const text = await readText(paths.status);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Read the newest records of one log stream, oldest first.
 * @param {string} root - absolute controlled root.
 * @param {'route'|'misplaced'|'audit'|'guard'|'writes'} stream - log stream name.
 * @param {number} limit - how many trailing records to keep.
 * @returns {Promise<object[]>} parsed records; malformed lines are skipped.
 */
export async function readLogTail(root, stream, limit) {
  const paths = pathsFor(root);
  const target = paths.logs[stream];
  if (target === undefined) return [];
  const text = await readText(target);
  if (text === undefined) return [];
  const records = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      /* a torn trailing line must not empty the panel */
    }
  }
  return records.slice(Math.max(0, records.length - limit));
}

/**
 * Rotate one stream when it exceeds the size budget, then append one record
 * (`§11.4`).
 * @param {string} root - absolute controlled root.
 * @param {'route'|'misplaced'|'audit'|'guard'|'writes'} stream - log stream name.
 * @param {object} record - JSON-serializable record.
 * @returns {Promise<void>} fulfillment after the append.
 */
export async function appendLog(root, stream, record) {
  const paths = await ensureMaidDir(root);
  const target = paths.logs[stream];
  if (target === undefined) throw new Error(`unknown log stream: ${stream}`);
  const identity = probe.identityOf(target);
  if (identity !== undefined && identity.size > LOG_BYTES_LIMIT) {
    await rotateLog(target);
    await markRotation(root, stream);
  }
  await probe.appendText(target, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`, 0o600);
}

/**
 * Remember when a stream last rotated, so a reconciliation window that spans the
 * rotation can say it cannot be covered instead of reporting a false shortfall.
 *
 * The marker is a tiny JSON object per root rather than a log record: a record
 * inside the rotated stream would itself be rotated away, and reading it back
 * would hit the same tail cap this marker exists to avoid.
 * @param {string} root - absolute controlled root.
 * @param {string} stream - stream name that rotated.
 * @returns {Promise<void>} fulfillment after the marker is durable.
 */
export async function markRotation(root, stream) {
  const paths = pathsFor(root);
  const current = await readRotation(root);
  const next = { ...current, [stream]: new Date().toISOString() };
  await probe.writeFileAtomic(paths.rotation, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 });
}

/**
 * Read the rotation markers of one root.
 * @param {string} root - absolute controlled root.
 * @returns {Promise<Record<string, string>>} stream name to ISO timestamp.
 */
export async function readRotation(root) {
  const text = await readText(pathsFor(root).rotation);
  if (text === undefined) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Shift one stream's rotated siblings and restart the base file (`§11.4`).
 * @param {string} target - absolute `.jsonl` path.
 * @returns {Promise<void>} fulfillment after the shift.
 */
async function rotateLog(target) {
  const stem = target.slice(0, -'.jsonl'.length);
  for (let index = LOG_FILES_KEPT - 1; index >= 1; index -= 1) {
    await probe.renameIfPresent(`${stem}.${index}.jsonl`, `${stem}.${index + 1}.jsonl`);
  }
  await probe.renameIfPresent(target, `${stem}.1.jsonl`);
}

/**
 * Write one scan report, pruning the report directory first (`§11.4`).
 * @param {string} root - absolute controlled root.
 * @param {string} name - report file name.
 * @param {string} content - markdown body.
 * @returns {Promise<{ pruned: string[] }>} reports deleted by pruning.
 */
export async function writeReport(root, name, content) {
  const paths = await ensureMaidDir(root);
  await probe.ensureDirectory(paths.reports, 0o700);
  const pruned = await pruneReports(root);
  await probe.writeFileAtomic(join(paths.reports, name), content, { mode: 0o600, dirMode: 0o700 });
  for (const removed of pruned) {
    await appendLog(root, 'audit', { action: 'report-pruned', target: removed });
  }
  return { pruned };
}

/**
 * Delete reports beyond the count or age budget.
 * @param {string} root - absolute controlled root.
 * @returns {Promise<string[]>} removed report names.
 */
export async function pruneReports(root) {
  const paths = pathsFor(root);
  const entries = await probe.listDirectory(paths.reports);
  const reports = entries
    .filter((entry) => entry.isFile() && /^scan-\d{8}-\d{6}\.md$/u.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  const removed = [];
  const now = Date.now();
  const keepFrom = Math.max(0, reports.length - REPORT_FILES_KEPT);
  for (let index = 0; index < reports.length; index += 1) {
    const name = reports[index];
    const match = /^scan-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.md$/u.exec(name);
    const parsed = match === null ? Number.NaN : Date.parse(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`);
    const tooOld = Number.isFinite(parsed) && now - parsed > REPORT_MAX_AGE_MS;
    if (index < keepFrom || tooOld) {
      await probe.removeIfPresent(join(paths.reports, name));
      removed.push(name);
    }
  }
  return removed;
}

/**
 * Serialize one catalog to YAML (`§4.1` shape, deterministic output).
 * @param {object} catalog - validated catalog.
 * @param {{ root: string }} meta - where the catalog lives.
 * @returns {string} file content.
 */
export function serializeCatalog(catalog, meta) {
  const optional = (list) => (Array.isArray(list) && list.length > 0 ? [...list] : undefined);
  const body = {
    version: 1,
    root_default: catalog.rootDefault,
    dirs: catalog.dirs.map((dir) => ({
      path: dir.path,
      purpose: dir.purpose,
      excludes: typeof dir.excludes === 'string' && dir.excludes.length > 0 ? dir.excludes : undefined,
      examples: optional(dir.examples),
    })),
    rules: catalog.rules.map((entry) => ({ match: entry.match, dir: entry.dir })),
  };
  const header = [
    `# file-maid catalog for ${meta.root}`,
    '# This file is the single source of truth for routing; the plugin reads no other location.',
    '# Regenerate it with maid_init after a routing decision changes on purpose.',
    '',
  ].join('\n');
  return `${header}${YAML.stringify(body, { indent: 2, lineWidth: 0 })}`;
}

/**
 * Write `catalog.yml` with `0600`.
 * @param {string} root - absolute controlled root.
 * @param {string} text - catalog content.
 * @returns {Promise<void>} fulfillment after the write committed.
 */
export async function writeCatalog(root, text) {
  const paths = await ensureMaidDir(root);
  await probe.writeFileAtomic(paths.catalog, text, { mode: 0o600, dirMode: 0o700 });
}

/**
 * Write the `opt-out` marker with `0600`.
 * @param {string} root - absolute controlled root.
 * @returns {Promise<void>} fulfillment after the write committed.
 */
export async function writeOptOut(root) {
  const paths = await ensureMaidDir(root);
  await probe.writeFileAtomic(paths.optOut, `# set by maid_init at ${new Date().toISOString()}\n`, { mode: 0o600, dirMode: 0o700 });
}

/**
 * Read one of the root's files as UTF-8 text.
 * @param {string} path - absolute path.
 * @returns {Promise<string | undefined>} the content, or undefined.
 */
export async function readText(path) {
  return probe.readTextFile(path);
}

/**
 * Build the empty-purpose template for one controlled root.
 *
 * The template names every first-level directory that exists, with an empty
 * purpose: the purpose is the one thing a human must write, and inventing one
 * from a folder name is how the old generator produced misleading tables.
 * @param {{ directories: string[] }} input - first-level directory names on disk.
 * @returns {{ catalog: object, pending: number } | { error: object }} the template, or the reason none can be built.
 */
export function templateCatalog(input) {
  const reserved = new Set(['.git', 'node_modules', '.tmp', MAID_SEGMENT, '.DS_Store']);
  const names = [...new Set(input.directories)]
    .filter((name) => typeof name === 'string' && name.length > 0)
    .filter((name) => !reserved.has(name) && !name.startsWith('.'))
    .sort((left, right) => left.localeCompare(right));
  const dirs = names.map((name) => ({
    path: name,
    purpose: '',
    excludes: '',
    examples: [],
  }));
  const preferred = dirs.find((dir) => dir.path === '80-Outputs') ?? dirs[0];
  if (preferred === undefined) {
    return { error: { code: 'E_MAID_SCHEMA', message: 'the controlled root has no directory a template could declare' } };
  }
  const verdict = validateCatalog({ version: 1, root_default: preferred.path, dirs, rules: [] });
  if (!verdict.ok) return { error: verdict.errors[0] };
  return { catalog: verdict.catalog, pending: dirs.length };
}

/**
 * List the top-level names that exist under one root.
 * @param {string} root - absolute controlled root.
 * @returns {Promise<string[]>} directory names.
 */
export async function listRootDirectories(root) {
  const entries = await probe.listDirectory(root);
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}
