/**
 * Placement: the only code that writes a routed file.
 *
 * `decide` answers which directory; this module writes into it. Separating
 * them keeps the decision pure and gives the naming-validation hook one
 * obvious place to land later — between a decided directory and a write that
 * has already happened.
 * @module file-maid/runtime/place
 */
import { join } from 'node:path';
import * as probe from '../state/probe.js';

/** Hook name reserved for naming validation; no rule runs in this version. */
export const VALIDATE_HOOK = 'naming';

/**
 * Judge one target against the naming rules.
 *
 * The hook exists so a later version can add rules without touching the write
 * path. It returns no violations today, and callers already treat a non-empty
 * list as a refusal.
 * @param {{ name: string, dir: string }} _input - the decided target.
 * @returns {{ code: string, message: string }[]} violations; empty when acceptable.
 */
export function validateTarget(_input) {
  return [];
}

/**
 * Write one routed file atomically.
 * @param {{ root: string, dir: string, name: string, content: string, overwrite?: boolean }} input - the decided target and its content.
 * @returns {Promise<{ ok: true, path: string, absolute: string, bytes: number, createdDirs: number } | { ok: false, code: string, message: string, path: string }>} the result.
 */
export async function place(input) {
  const relative = `${input.dir}/${input.name}`;
  const directory = join(input.root, input.dir);
  const absolute = join(directory, input.name);

  const violations = validateTarget({ name: input.name, dir: input.dir });
  if (violations.length > 0) {
    const first = violations[0];
    return { ok: false, code: first.code, message: first.message, path: relative };
  }

  if (input.overwrite !== true && (await probe.pathKind(absolute)) !== 'absent') {
    return { ok: false, code: 'E_MAID_EXISTS', message: `target already exists: ${relative}`, path: relative };
  }

  const createdDirs = await probe.ensureDirectory(directory, 0o755);
  await probe.writeFileAtomic(absolute, input.content, { mode: 0o644 });
  return { ok: true, path: relative, absolute, bytes: Buffer.byteLength(input.content, 'utf8'), createdDirs };
}
