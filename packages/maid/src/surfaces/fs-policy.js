/**
 * Write-surface interception for the protected `.maid` directory (`§10.2`, `§10.3`).
 *
 * Two hooks call one decision: `tools/pre-execute` refuses before an approval
 * card would appear, and `fs/write-intent` / `fs/edit-intent` refuse from
 * inside the tool. Only the three file-editing tools are judged, and only the
 * `.maid` surface blocks a write; every other path continues into `next()`,
 * which keeps the built-in observation policy in charge of version checks.
 * @module file-maid/surfaces/fs-policy
 */
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { expandHomePrefix } from '../core/path.js';
import * as probe from '../state/probe.js';

/** Tools whose writes are judged (`§10.2`). */
export const JUDGED_TOOLS = Object.freeze(['write', 'edit', 'str_replace_editor']);

/** Prefix shared by every refusal this plugin raises. */
export const DENY_PREFIX = 'FILE_MAID:MAID_LOCKED';

/** Human-readable explanation per refusal reason. */
const REASON_TEXT = Object.freeze({
  LEXICAL: '路径包含独立段 .maid',
  INODE: '.maid 目录的 inode 出现在路径祖先中（软链或大小写别名）',
  UNVERIFIED: '.maid 存在但无法探测，保护面无法证伪',
});

/**
 * Build the refusal a tool call surfaces to the model (`§10.3`).
 * @param {'LEXICAL'|'INODE'|'UNVERIFIED'} reason - refusal reason.
 * @param {string} candidate - the resolved path that hit the surface.
 * @returns {Error & { code: string, reason: string, path: string }} the error.
 */
export function lockedError(reason, candidate) {
  const error = new Error(`${DENY_PREFIX}:${reason} ${REASON_TEXT[reason] ?? reason}: ${candidate}`);
  error.code = 'FS_PERMISSION_DENIED';
  error.reason = reason;
  error.path = candidate;
  return error;
}

/**
 * Read the path argument of one tool execution.
 * @param {object | undefined} exec - tool execution.
 * @returns {string | undefined} `file_path ?? path`.
 */
export function argPath(exec) {
  const args = exec?.arguments;
  if (args === null || typeof args !== 'object') return undefined;
  const raw = args.file_path ?? args.path;
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

/**
 * Read the `command` argument of `str_replace_editor`.
 * @param {object | undefined} exec - tool execution.
 * @returns {string | undefined} the command, when present.
 */
export function argCommand(exec) {
  const value = exec?.arguments?.command;
  return typeof value === 'string' ? value : undefined;
}

/**
 * Enumerate every absolute path one call could mean (`D-08`).
 *
 * A relative argument is resolved against both the committed session directory
 * and the session header's `cwd`; both are judged, because the host resolves
 * the argument against a directory that may have moved since it was read.
 * @param {{ root?: string, basis?: string, raw?: string, displayPath?: string, home?: string }} input - resolution inputs.
 * @returns {string[]} unique absolute candidates.
 */
export function candidatesFor(input) {
  const home = input.home ?? homedir();
  const candidates = [];
  const push = (value) => {
    if (typeof value !== 'string' || value.length === 0) return;
    const absolute = resolve(expandHomePrefix(value, home));
    if (!candidates.includes(absolute)) candidates.push(absolute);
  };
  push(input.displayPath);
  const raw = input.raw;
  if (typeof raw === 'string' && raw.length > 0) {
    if (isAbsolute(raw) || raw.startsWith('~')) {
      push(raw);
    } else {
      if (input.basis !== undefined) push(resolve(input.basis, raw));
      if (input.root !== undefined) push(resolve(input.root, raw));
    }
  }
  return candidates;
}

/**
 * Decide one call against the protection surface.
 * @param {{ exec?: object, target?: { displayPath?: string }, paths?: string[], root?: string, basis?: string, home?: string }} input - decision inputs.
 * @returns {{ reason: string, path: string } | undefined} the refusal, or undefined to allow.
 */
export function judgeCall(input) {
  const exec = input.exec;
  const tool = exec?.name;
  const displayPath = input.target?.displayPath;
  // `fs/write-intent` fires for every writer that goes through `ctx.fs`, whatever the
  // tool is named, and the Host has already resolved the target there — so the tool
  // name is not a reliable filter on that path. `tools/pre-execute` carries only the
  // arguments, so it keeps the name + command filter.
  const fromHost = typeof displayPath === 'string' && displayPath.length > 0;
  if (!fromHost) {
    if (typeof tool !== 'string' || !JUDGED_TOOLS.includes(tool)) return undefined;
    if (tool === 'str_replace_editor' && argCommand(exec) === 'view') return undefined;
    if (input.root === undefined && input.basis === undefined) return undefined;
  }
  const raw = argPath(exec);
  if (!fromHost && raw === undefined) return undefined;

  const candidates = candidatesFor({ root: input.root, basis: input.basis, raw, displayPath, home: input.home });
  for (const extra of input.paths ?? []) {
    if (typeof extra === 'string' && extra.length > 0 && !candidates.includes(extra)) candidates.push(extra);
  }
  if (candidates.length === 0) return undefined;
  const surface = probe.protectionIdentities([input.root, input.basis].filter((value) => typeof value === 'string' && value.length > 0));
  for (const candidate of candidates) {
    const verdict = probe.protectionVerdict(candidate, surface);
    if (verdict !== undefined) return { reason: verdict, path: candidate };
  }
  return undefined;
}

/**
 * Resolve the two bases one execution is judged against.
 * @param {object} ctx - plugin context.
 * @param {object | undefined} exec - tool execution.
 * @returns {{ root?: string, basis?: string }} the bases.
 */
export function basesFor(ctx, exec) {
  const session = exec?.agent?.session;
  const root = typeof session?.header?.cwd === 'string' && session.header.cwd.length > 0 ? session.header.cwd : undefined;
  let basis;
  try {
    const service = ctx?.get?.('workingDirectory');
    if (service !== undefined && typeof service.get === 'function' && session !== undefined) {
      const value = service.get(session);
      if (typeof value === 'string' && value.length > 0) basis = value;
    }
  } catch {
    basis = undefined;
  }
  return { root, basis };
}

/**
 * Build the handlers this plugin registers for the write surface.
 * @param {{ ctx: object }} options - plugin context.
 * @returns {{ onIntent: Function, onPreExecute: Function, decide: Function }} handlers.
 */
export function createWriteGuard(options) {
  const ctx = options.ctx;

  /**
   * Shared decision used by both hooks (`§9.3`: the stricter verdict wins).
   * @param {object} exec - tool execution.
   * @param {{ displayPath?: string }} [target] - resolved target, when the fs layer supplies one.
   * @returns {{ reason: string, path: string } | undefined} the refusal, or undefined.
   */
  /**
   * The Host's own resolution of the target. `dsh-fs-local` stores the `realpath` of
   * the target (or of its deepest existing ancestor) before firing the intent, so it
   * sees through symlinks that a lexical comparison cannot (`P0-2`).
   * @param {{ displayPath?: string }} [target] - the fs target.
   * @returns {string[]} resolved absolute paths; empty when the service is absent.
   */
  const hostPaths = (target) => {
    if (target === undefined) return [];
    let service;
    try {
      service = ctx?.get?.('fs');
    } catch {
      return [];
    }
    if (service === undefined || typeof service?.processPath !== 'function') return [];
    try {
      const resolved = service.processPath(target);
      return typeof resolved === 'string' && resolved.length > 0 ? [resolved] : [];
    } catch {
      return [];
    }
  };

  const decide = (exec, target) => {
    if (exec?.agent === undefined) return undefined;
    const { root, basis } = basesFor(ctx, exec);
    return judgeCall({ exec, target, paths: hostPaths(target), root, basis });
  };

  return {
    decide,
    /**
     * `fs/write-intent` / `fs/edit-intent` listener (`§9.2`).
     * @param {{ displayPath?: string }} target - the fs target.
     * @param {object} exec - tool execution.
     * @param {Function} next - waterfall continuation.
     * @returns {Promise<unknown>} `next()`'s result.
     */
    onIntent(target, exec, next) {
      const refusal = decide(exec, target);
      if (refusal !== undefined) throw lockedError(refusal.reason, refusal.path);
      return next();
    },
    /**
     * `tools/pre-execute` listener (`§9.3`): refuse before an approval card.
     * @param {object} exec - tool execution.
     * @param {Function} next - waterfall continuation.
     * @returns {Promise<unknown>} `next()`'s result, or the deny decision.
     */
    onPreExecute(exec, next) {
      const refusal = decide(exec);
      if (refusal === undefined) return next();
      return {
        kind: 'deny',
        reason: `${DENY_PREFIX}:${refusal.reason} ${REASON_TEXT[refusal.reason] ?? refusal.reason}: ${refusal.path}`,
        info: { name: 'FILE_MAID', code: 'FS_PERMISSION_DENIED', reason: refusal.reason, path: refusal.path },
      };
    },
  };
}
