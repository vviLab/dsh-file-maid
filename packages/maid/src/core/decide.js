/**
 * Directory decision: the only place a target directory is chosen.
 *
 * Two levels, first hit wins: the directory the caller named, then the catalog's
 * `root_default`. Keyword rules sat above both until they were retired — a
 * substring match is a second, dumber brain arguing with the model, and when the
 * two disagreed the file landed somewhere nobody asked for. The result always
 * says which level decided, so the card and the log can show it.
 *
 * `purpose` and `excludes` never decide here: they are the sentence the model
 * reads, and `rank()` uses them only to suggest candidates.
 *
 * Pure module: no I/O, no clocks, no randomness.
 * @module file-maid/core/decide
 */
import { isDeclared } from './catalog.js';
import { normalize } from './text.js';

/** Maximum candidate directories returned for a human to inspect. */
const CANDIDATE_LIMIT = 3;

/**
 * Reject a name that could escape its target directory.
 * @param {unknown} value - candidate file name.
 * @returns {{ ok: true, name: string } | { ok: false, code: string, message: string }} the verdict.
 */
export function checkName(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return { ok: false, code: 'E_MAID_PATH', message: 'name must be a non-empty string' };
  }
  const name = value.trim();
  if (name.length > 255) return { ok: false, code: 'E_MAID_PATH', message: 'name is longer than 255 characters' };
  if (name.includes('\0')) return { ok: false, code: 'E_MAID_PATH', message: 'name contains a NUL byte' };
  if (name.includes('/') || name.includes('\\')) return { ok: false, code: 'E_MAID_PATH', message: 'name must not contain a path separator' };
  if (name === '.' || name === '..') return { ok: false, code: 'E_MAID_PATH', message: 'name must not be . or ..' };
  if (name === '.maid') return { ok: false, code: 'E_MAID_PATH', message: 'name must not be the plugin data directory' };
  return { ok: true, name };
}

/**
 * Count how many needles one folded haystack contains.
 * @param {string} haystack - folded text.
 * @param {string[]} needles - raw candidate words.
 * @returns {number} the hit count.
 */
function hits(haystack, needles) {
  let count = 0;
  for (const needle of needles) {
    const folded = normalize(needle);
    if (folded.length > 0 && haystack.includes(folded)) count += 1;
  }
  return count;
}

/**
 * Turn a purpose sentence into the needles worth matching.
 *
 * A purpose is written for a human, so its punctuation marks the phrases, and
 * each phrase still reads as one long string that no intent repeats verbatim.
 * Two-character windows recover the words inside a phrase — "工作区通用规范文件"
 * contributes 规范 — without pretending to segment Chinese properly.
 * @param {string} text - purpose sentence.
 * @returns {string[]} phrases and their two-character windows.
 */
function segments(text) {
  const pieces = String(text ?? '')
    .split(/[、，,；;：:／/\s]+/u)
    .map((piece) => piece.trim())
    .filter((piece) => piece.length >= 2);
  const needles = new Set(pieces);
  for (const piece of pieces) {
    for (let index = 0; index + 2 <= piece.length; index += 1) needles.add(piece.slice(index, index + 2));
  }
  return [...needles];
}

/**
 * Rank declared directories against one intent, for inspection only.
 *
 * A directory matched through its `excludes` is penalized, so a file whose
 * stated purpose is exactly what a directory refuses ranks below one that
 * accepts it. This ranking never decides; `decide` does.
 * @param {object} catalog - validated catalog.
 * @param {string} intent - folded intent text.
 * @param {string} name - folded file name.
 * @returns {{ dir: string, score: number }[]} the best candidates, highest first.
 */
export function rank(catalog, intent, name) {
  const haystack = `${intent} ${name}`.trim();
  const scored = catalog.dirs.map((dir) => {
    const accepted = hits(haystack, [...segments(dir.purpose), ...dir.examples]);
    const refused = hits(haystack, segments(dir.excludes));
    return { dir: dir.path, score: accepted * 2 - refused };
  });
  return scored
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.dir.localeCompare(right.dir))
    .slice(0, CANDIDATE_LIMIT);
}

/**
 * Decide the target directory for one file.
 * @param {{ catalog: object, name: string, intent?: string, dir?: string }} input - decision inputs.
 * @returns {{ ok: true, dir: string, decided_by: 'agent'|'default', candidates: object[] } | { ok: false, code: string, message: string }} the decision.
 */
export function decide(input) {
  const catalog = input.catalog;
  const name = normalize(input.name);
  const intent = normalize(input.intent ?? '');
  const proposed = typeof input.dir === 'string' && input.dir.trim().length > 0 ? input.dir.trim() : undefined;
  const candidates = rank(catalog, intent, name);

  if (proposed !== undefined) {
    if (!isDeclared(catalog, proposed)) {
      return { ok: false, code: 'E_MAID_DIR', message: `directory is not declared in .maid/catalog.yml: ${proposed}` };
    }
    return { ok: true, dir: proposed, decided_by: 'agent', candidates };
  }

  return { ok: true, dir: catalog.rootDefault, decided_by: 'default', candidates };
}
