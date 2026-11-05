/**
 * Plugin entry: assembly only.
 *
 * Five registrations inside one Cordis effect so unloading releases them
 * automatically: the prompt section, the write surface guard, the three file
 * intents, the tools, and the agent lifecycle. No handler here touches the
 * filesystem except through the runtime and state layers.
 * @module file-maid/plugin
 */
import { realpathSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { hasMaidSegment, relativeTo } from './core/path.js';
import * as probe from './state/probe.js';
import { createRoots } from './runtime/roots.js';
import * as store from './state/store.js';
import { createWriteGuard, lockedError } from './surfaces/fs-policy.js';
import { PROMPT_NAME, PROMPT_ORDER, createPromptProvider } from './surfaces/prompt.js';
import { createTools } from './surfaces/tools.js';
import { createManageSurface } from './surfaces/manage.js';
import { isReadOnlySession } from './runtime/permissions.js';

/** Plugin name used by Cordis diagnostics. */
export const name = 'dsh-file-maid';

/** Services that must exist before this plugin mounts. */
export const inject = ['tools', 'systemPrompt', 'sessions'];

/**
 * Mount the plugin.
 * @param {object} ctx - Cordis context.
 * @param {object} [config] - reserved; the catalog, not the config, holds routing.
 * @returns {void}
 */
export function apply(ctx, config) {
  void config;
  const logger = typeof ctx.logger === 'function' ? ctx.logger('file-maid') : undefined;
  const roots = createRoots({ ctx });

  ctx.effect(() => {
    const disposers = [];

    // ① Prompt context. A registration failure aborts the mount on purpose:
    //    a silently missing section is worse than a failed load.
    if (typeof ctx.systemPrompt?.context !== 'function') {
      throw new Error('file-maid: ctx.systemPrompt.context is unavailable; refusing to load without the prompt section');
    }
    disposers.push(
      ctx.systemPrompt.context({
        name: PROMPT_NAME,
        order: PROMPT_ORDER,
        required: false,
        interpolate: false,
        text: createPromptProvider(roots),
      }),
    );

    // ② One decision, four hooks. A refusal is recorded to `guard.jsonl`
    //    before it propagates.
    const guard = createWriteGuard({ ctx });
    const recordGuard = (exec, refusal, error) => {
      const session = exec?.agent?.session;
      const root = session?.header?.cwd;
      if (typeof root !== 'string') return;
      if (isReadOnlySession(ctx, session)) return;
      const target = typeof error?.path === 'string' ? relativeTo(root, error.path) ?? error.path : undefined;
      void store
        .appendLog(root, 'guard', {
          tool: exec?.name ?? null,
          target,
          reason: `FILE_MAID:MAID_LOCKED:${refusal.reason}`,
        })
        .catch(() => {});
    };

    const onIntent = (target, exec, next) => {
      const refusal = guard.decide(exec, target);
      if (refusal === undefined) return next();
      const error = lockedError(refusal.reason, refusal.path);
      recordGuard(exec, refusal, error);
      throw error;
    };
    for (const event of ['fs/write-intent', 'fs/edit-intent', 'fs/delete-intent']) {
      disposers.push(ctx.on(event, onIntent, true));
    }
    // ③ Write ledger. `fs/observed` fires for reads as well, so only the
    //    mutating tool names are recorded; `maid_put` never passes through the
    //    tool layer and stays in `decisions.jsonl` alone.
    const LEDGER_TOOLS = new Set(['write', 'edit', 'apply_patch']);
    const ledgerReady = new Set();
    const absoluteOf = (target) => {
      try {
        const service = ctx.get('fs');
        if (service !== undefined && typeof service.processPath === 'function') return service.processPath(target);
      } catch {
        /* fall through to the target's own paths */
      }
      if (typeof target?.targetKey === 'string') return target.targetKey;
      return typeof target?.displayPath === 'string' ? target.displayPath : undefined;
    };
    const recordWrite = (target, observation, exec) => {
      const tool = exec?.name;
      if (typeof tool !== 'string' || !LEDGER_TOOLS.has(tool)) return;
      const session = exec?.agent?.session;
      const root = session?.header?.cwd;
      if (typeof root !== 'string') return;
      if (isReadOnlySession(ctx, session)) return;
      const absolute = absoluteOf(target);
      if (typeof absolute !== 'string') return;
      let path = relativeTo(root, resolvePath(absolute));
      if (path === undefined) {
        // The provider hands back a realpath, which differs from the session cwd
        // when a parent directory is a symlink; compare against its realpath too.
        try {
          path = relativeTo(realpathSync(root), resolvePath(absolute));
        } catch {
          return;
        }
      }
      if (path === undefined || path === '') return;
      const kind = observation?.kind === 'absent' ? 'absent' : 'present';
      const slash = path.split('\\').join('/');
      void (async () => {
        if (!ledgerReady.has(root)) {
          const file = store.pathsFor(root).logs.writes;
          if (file !== undefined && probe.identityOf(file) === undefined) {
            await store.appendLog(root, 'writes', { kind: 'init' });
          }
          ledgerReady.add(root);
        }
        await store.appendLog(root, 'writes', { tool, path: slash, kind });
      })().catch(() => {});
    };
    disposers.push(ctx.on('fs/observed', recordWrite));

    disposers.push(
      ctx.on(
        'tools/pre-execute',
        (exec, next) => {
          const decision = guard.onPreExecute(exec, next);
          if (decision?.kind === 'deny') {
            recordGuard(exec, { reason: String(decision.info?.reason ?? 'UNVERIFIED') }, { path: decision.info?.path });
          }
          return decision;
        },
        true,
      ),
    );

    // ③ Four tools.
    const tools = createTools({ ctx, roots });
    disposers.push(tools.register());

    // ③b The card's directory manager. One endpoint, guarded the same way as the
    //     tools: the caller names a session, never a root.
    const manage = createManageSurface({ ctx, roots });
    disposers.push(manage.register());

    // ④ Lifecycle. The catalog is loaded when the session starts, so the
    //    first prompt already carries the table; a failure is logged, never
    //    thrown into the host's event loop.
    disposers.push(
      ctx.on('agent/created', ({ agent }) => {
        const entry = roots.acquire(agent);
        if (entry === undefined) return;
        queueMicrotask(() => {
          void roots.start(entry).catch((error) => {
            logger?.warn?.(`file-maid: catalog load failed for ${entry.root}: ${error?.message ?? error}`);
          });
        });
      }),
    );
    disposers.push(
      ctx.on('agent/disposed', ({ agent }) => {
        roots.release(agent);
      }),
    );

    // ⑤ A catalog file rewritten by hand is picked up on the next tool call;
    //    the panel is refreshed cheaply when a session observes a write.

    return () => {
      try {
        roots.disposeAll();
      } catch {
        /* already disposed */
      }
      for (const dispose of disposers.reverse()) {
        try {
          dispose();
        } catch {
          /* already disposed */
        }
      }
    };
  });

  logger?.debug?.('file-maid: mounted');
}
