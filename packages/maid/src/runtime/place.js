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
export function validateTarget(input) {
  const name = typeof input?.name === 'string' ? input.name : '';
  return nameViolations(name);
}

/** Names Windows refuses, matched with or without an extension. */
const RESERVED_NAMES = new Set(['CON', 'PRN', 'AUX', 'NUL', 'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9', 'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9']);

/** Characters that are legal on macOS and illegal on Windows, plus the separator. */
const FORBIDDEN_CHARS = new Set(['/', '\\', ':', '*', '?', '"', '<', '>', '|']);

/**
 * Refuse a file name that would not survive a copy to another platform.
 *
 * The strictest of the three targets wins: a name accepted here must be writable
 * on macOS, Linux and Windows, because the workspace is a folder people sync and
 * zip, not a place that only ever lives on one disk.
 * @param {string} name - the proposed file name, without a directory.
 * @returns {Array<{ code: string, message: string }>} violations; empty means fine.
 */
export function nameViolations(name) {
  const violations = [];
  const refuse = (code, message) => violations.push({ code, message });
  if (name.length === 0) {
    refuse('E_MAID_NAME_EMPTY', '文件名为空。');
    return violations;
  }
  if (name === '.' || name === '..') refuse('E_MAID_NAME_RESERVED', '「.」与「..」不能当文件名。');
  for (const char of name) {
    if (FORBIDDEN_CHARS.has(char)) {
      refuse('E_MAID_NAME_CHAR', `文件名里不能有 ${char}：它在别的系统上会被当成路径分隔或通配符。`);
    } else if (char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f) {
      refuse('E_MAID_NAME_CONTROL', '文件名里不能有控制字符。');
    }
  }
  if (/[ .]$/u.test(name)) refuse('E_MAID_NAME_TRAILING', '文件名不能以空格或点结尾：Windows 会悄悄把它删掉。');
  const stem = name.split('.')[0].toUpperCase();
  if (RESERVED_NAMES.has(stem)) refuse('E_MAID_NAME_DEVICE', `「${stem}」是 Windows 的保留设备名，换一个名字。`);
  // Byte length, not code points: the limit every filesystem enforces is bytes.
  if (Buffer.byteLength(name, 'utf8') > 255) refuse('E_MAID_NAME_LONG', '文件名超过了 255 字节（中文约合 85 个字）。');
  return violations;
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
    return { ok: false, code: first.code, message: first.message, path: relative, violations };
  }

  if (input.overwrite !== true && (await probe.pathKind(absolute)) !== 'absent') {
    return { ok: false, code: 'E_MAID_EXISTS', message: `target already exists: ${relative}`, path: relative };
  }

  const createdDirs = await probe.ensureDirectory(directory, 0o755);
  await probe.writeFileAtomic(absolute, input.content, { mode: 0o644 });
  return { ok: true, path: relative, absolute, bytes: Buffer.byteLength(input.content, 'utf8'), createdDirs };
}
