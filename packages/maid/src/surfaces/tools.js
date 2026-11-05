/**
 * The four model-facing tools.
 *
 * Every tool returns the same envelope and never throws: a failure is a
 * `verdict` plus an `errors[]` entry, which keeps the model's tool list stable
 * and its retry decisions explicit. `maid_put` is the only writer.
 * @module file-maid/surfaces/tools
 */
import { join } from 'node:path';

import { decide, checkName } from '../core/decide.js';
import { sessionTail } from '../core/text.js';
import { isReadOnlySession } from '../runtime/permissions.js';
import { place } from '../runtime/place.js';
import * as probe from '../state/probe.js';
import * as store from '../state/store.js';

/** Envelope schema version shared by every tool. */
export const SCHEMA_VERSION = '2';

/** Verdicts the envelope may carry. */
export const VERDICTS = Object.freeze(['OK', 'UNINITIALIZED', 'NOT_MANAGED', 'DEGRADED', 'ERROR']);

/** Answers offered while a root is uninitialized. */
export const INIT_CHOICES = Object.freeze(['defer', 'opt_out']);

/** JSON Schema shared by every tool's `output.schema`. */
const ENVELOPE_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    schemaVersion: { type: 'string', enum: [SCHEMA_VERSION] },
    verdict: { type: 'string', enum: [...VERDICTS] },
    data: { type: 'object' },
    errors: { type: 'array', items: { type: 'object' } },
    warnings: { type: 'array', items: { type: 'object' } },
  },
  required: ['schemaVersion', 'verdict', 'data', 'errors', 'warnings'],
  additionalProperties: false,
});

/**
 * Build one envelope.
 * @param {object} input - envelope fields.
 * @returns {object} the envelope.
 */
function envelope(input) {
  return {
    schemaVersion: SCHEMA_VERSION,
    verdict: input.verdict ?? 'OK',
    data: input.data ?? {},
    errors: input.errors ?? [],
    warnings: input.warnings ?? [],
  };
}

/**
 * Build an error envelope.
 * @param {string} code - diagnostic code.
 * @param {string} message - human-readable reason.
 * @param {object} [data] - partial data worth returning.
 * @returns {object} the envelope.
 */
function failure(code, message, data = {}) {
  return envelope({ verdict: 'ERROR', data, errors: [{ code, message }] });
}

/**
 * Trim one optional string argument.
 * @param {unknown} value - raw argument.
 * @returns {string | undefined} the trimmed value when it is a non-empty string.
 */
function text(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Render one envelope for the model.
 * @param {string} title - tool name.
 * @param {object} value - the envelope.
 * @returns {{ type: 'text', text: string }[]} render output.
 */
function renderEnvelope(title, value) {
  return [{ type: 'text', text: `${title} → ${value.verdict}\n${JSON.stringify(value, null, 2)}` }];
}

/**
 * Report file name for one scan stamp.
 * @param {number} stamp - epoch milliseconds.
 * @returns {string} `scan-YYYYMMDD-HHmmss.md`.
 */
export function reportName(stamp) {
  const date = new Date(stamp);
  const pad = (value) => String(value).padStart(2, '0');
  return `scan-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}.md`;
}

/**
 * Render one scan report.
 * @param {{ root: string, outcome: object, catalog: object | undefined }} input - report inputs.
 * @returns {string} markdown.
 */
export function renderReport(input) {
  const outcome = input.outcome ?? {};
  const lines = [
    `# 扫描报告`,
    '',
    `- 受控根：\`${input.root}\``,
    `- 时间：${new Date().toISOString()}`,
    `- 文件：${outcome.files ?? 0}，目录：${outcome.dirs ?? 0}，耗时：${outcome.elapsed ?? 0} ms`,
    `- 基线：${outcome.baseline === true ? '首次扫描' : '已有基线'}`,
  ];
  const reconciliation = outcome.reconcile;
  if (reconciliation !== undefined && reconciliation.baseline === false) {
    lines.push(
      '',
      '## 对账',
      '',
      `- 新增文件：${reconciliation.new_files}`,
      `- 走插件通道：${reconciliation.recorded}`,
      `- 工具写入账：${reconciliation.ledger ?? 0}`,
      `- 漏网：${reconciliation.missing?.length ?? 0}`,
      `- 残差：${reconciliation.residual === null || reconciliation.residual === undefined ? '无法计算（本窗口有覆盖缺口）' : reconciliation.residual}`,
      '',
      '| 目录 | 新增 |',
      '| --- | --- |',
      ...reconciliation.top_dirs.map((entry) => `| ${entry.dir} | ${entry.added} |`),
    );
    const missing = reconciliation.missing ?? [];
    if (missing.length > 0) {
      lines.push('', '### 漏网文件', '');
      for (const item of missing.slice(0, 20)) lines.push(`- ${item.path}`);
      if (missing.length > 20) lines.push(`- 还有 ${missing.length - 20} 个`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Create every tool definition plus its registration.
 * @param {{ ctx: object, roots: object, now?: () => number }} options - plugin context, registry and clock.
 * @returns {{ definitions: object[], register: () => () => void }} the tools.
 */
export function createTools(options) {
  const ctx = options.ctx;
  const roots = options.roots;
  const now = options.now ?? Date.now;

  /**
   * Resolve the calling session's root entry.
   * @param {object | undefined} exec - tool execution.
   * @returns {{ entry?: object, root?: string }} the entry and its root.
   */
  const entryFor = (exec) => {
    const agent = exec?.agent;
    const root = agent?.session?.header?.cwd;
    if (typeof root !== 'string' || root.length === 0) return {};
    return { entry: roots.acquire(agent), root };
  };

  /**
   * Turn a non-serviceable catalog state into its envelope.
   * @param {object} status - `roots.status()` result.
   * @param {string} root - controlled root.
   * @returns {object | undefined} the envelope, or undefined when serviceable.
   */
  const stateEnvelope = (status, root) => {
    if (status.catalogState === 'NOT_MANAGED') {
      return envelope({ verdict: 'NOT_MANAGED', data: { root, opted_out: true }, errors: [], warnings: status.warnings });
    }
    if (status.catalogState === 'UNINITIALIZED') {
      return envelope({
        verdict: 'UNINITIALIZED',
        data: { root, choices: [...INIT_CHOICES] },
        errors: [{ code: 'E_MAID_UNINITIALIZED', message: 'this root is not managed by file-maid: no .maid/catalog.yml exists' }],
        warnings: status.warnings,
      });
    }
    if (status.catalogState !== 'MANAGED' || status.catalog === undefined) {
      return envelope({ verdict: 'ERROR', data: { root }, errors: status.errors, warnings: status.warnings });
    }
    return undefined;
  };

  /**
   * Resolve the intent and where it came from.
   * @param {{ intent?: string }} args - tool arguments.
   * @param {object | undefined} exec - tool execution.
   * @returns {{ intent: string, intent_source: 'param'|'session'|'none' }} the intent.
   */
  const resolveIntent = (args, exec) => {
    const fromParam = text(args?.intent);
    if (fromParam !== undefined) return { intent: fromParam, intent_source: 'param' };
    try {
      const id = exec?.agent?.id;
      const session = id === undefined ? undefined : ctx?.sessions?.get?.(id);
      const messages = typeof session?.deriveMessages === 'function' ? session.deriveMessages() : [];
      const tail = sessionTail(messages);
      if (tail.length > 0) return { intent: tail, intent_source: 'session' };
    } catch {
      /* a session that cannot be derived is simply not a source */
    }
    return { intent: '', intent_source: 'none' };
  };

  /**
   * Append one decision record unless the session may not persist.
   * @param {boolean} readOnly - session persistence flag.
   * @param {string} root - controlled root.
   * @param {object} record - the record.
   * @returns {Promise<void>} fulfillment after the append attempt.
   */
  const record = async (readOnly, root, body) => {
    if (readOnly) return;
    try {
      await store.appendLog(root, 'decisions', body);
    } catch {
      /* logging must never fail a tool call */
    }
  };

  const definitions = [
    {
      name: 'maid_put',
      description: '把内容写进工作区里声明的目录：按 rules、dir、默认落点三级裁决，原子写入并记账。新建文件用它，不要用 write。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '文件名（不含路径分隔符）' },
          content: { type: 'string', description: '文件内容' },
          intent: { type: 'string', description: '一句话用途；缺省时从会话尾部推断' },
          dir: { type: 'string', description: '指定目录；须在 catalog 中声明' },
          overwrite: { type: 'boolean', description: '目标已存在时是否覆盖，默认 false' },
        },
        required: ['name', 'content'],
        additionalProperties: false,
      },
      output: { schema: ENVELOPE_SCHEMA, render: (_args, value) => renderEnvelope('maid_put', value) },
      async execute(args, exec) {
        const checked = checkName(args?.name);
        if (!checked.ok) return failure(checked.code, checked.message);
        const content = typeof args?.content === 'string' ? args.content : undefined;
        if (content === undefined) return failure('E_MAID_SCHEMA', 'content must be a string');
        const { entry, root } = entryFor(exec);
        if (entry === undefined || root === undefined) return failure('E_MAID_NO_ROOT', 'this session has no session.header.cwd');

        await roots.ready(entry);
        await roots.load(entry);
        const status = roots.status(entry);
        const refusal = stateEnvelope(status, root);
        if (refusal !== undefined) return refusal;

        const { intent, intent_source } = resolveIntent(args, exec);
        const decision = decide({ catalog: status.catalog, name: checked.name, intent, dir: text(args?.dir) });
        if (!decision.ok) return failure(decision.code, decision.message, { root, name: checked.name });

        const readOnly = isReadOnlySession(ctx, exec?.agent?.session);
        const outcome = readOnly
          ? { ok: true, path: `${decision.dir}/${checked.name}`, bytes: 0, createdDirs: 0 }
          : await place({ root, dir: decision.dir, name: checked.name, content, overwrite: args?.overwrite === true });

        if (!outcome.ok) {
          return envelope({
            verdict: 'ERROR',
            data: { root, name: checked.name, dir: decision.dir, path: outcome.path },
            errors: [{ code: outcome.code, message: outcome.message }],
            warnings: status.warnings,
          });
        }

        await record(readOnly, root, {
          name: checked.name,
          dir: decision.dir,
          decided_by: decision.decided_by,
          intent_source,
          overridden: decision.overridden,
          proposed: decision.proposed ?? null,
          path: outcome.path,
        });
        // The card reads `status.json`, so a write the card cannot see is a write
        // that looks like it never happened. Republishing costs one small file
        // write, so it runs behind the reply rather than in front of it.
        if (!readOnly) void Promise.resolve(roots.refreshStatus(entry)).catch(() => {});

        return envelope({
          verdict: status.degraded === true ? 'DEGRADED' : 'OK',
          data: {
            root,
            path: outcome.path,
            dir: decision.dir,
            name: checked.name,
            decided_by: decision.decided_by,
            intent_source,
            overridden: decision.overridden,
            proposed: decision.proposed ?? null,
            matched: decision.matched ?? null,
            candidates: decision.candidates,
            violations: [],
            bytes: outcome.bytes,
            createdDirs: outcome.createdDirs,
            persisted: !readOnly,
          },
          warnings: status.warnings,
        });
      },
    },
    {
      name: 'maid_route',
      description: '按用途为一个文件名挑选落点目录，返回裁决依据与候选。不写盘、不创建目录。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '目标文件名，含扩展名' },
          intent: { type: 'string', description: '用途描述；缺省时从会话尾部推断' },
          dir: { type: 'string', description: '调用方倾向的目录；规则优先' },
        },
        required: ['name'],
        additionalProperties: false,
      },
      output: { schema: ENVELOPE_SCHEMA, render: (_args, value) => renderEnvelope('maid_route', value) },
      async execute(args, exec) {
        const checked = checkName(args?.name);
        if (!checked.ok) return failure(checked.code, checked.message);
        const { entry, root } = entryFor(exec);
        if (entry === undefined || root === undefined) return failure('E_MAID_NO_ROOT', 'this session has no session.header.cwd');

        await roots.ready(entry);
        await roots.load(entry);
        const status = roots.status(entry);
        const refusal = stateEnvelope(status, root);
        if (refusal !== undefined) return refusal;

        const { intent, intent_source } = resolveIntent(args, exec);
        const decision = decide({ catalog: status.catalog, name: checked.name, intent, dir: text(args?.dir) });
        if (!decision.ok) return failure(decision.code, decision.message, { root, name: checked.name });

        return envelope({
          verdict: status.degraded === true ? 'DEGRADED' : 'OK',
          data: {
            root,
            name: checked.name,
            dir: decision.dir,
            path: `${decision.dir}/${checked.name}`,
            decided_by: decision.decided_by,
            intent_source,
            overridden: decision.overridden,
            proposed: decision.proposed ?? null,
            matched: decision.matched ?? null,
            candidates: decision.candidates,
            persisted: false,
          },
          warnings: status.warnings,
        });
      },
    },
    {
      name: 'maid_init',
      description: '受控根的初始化在侧栏卡片完成：interview／init 只返回 E_MAID_CARD_REQUIRED；defer 暂不启用，opt_out 标记该目录不受控。',
      parameters: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['interview', 'init', 'defer', 'opt_out'], description: 'interview／init 在卡片完成；defer／opt_out 保留为工具侧回答' },
        },
        required: ['mode'],
        additionalProperties: false,
      },
      output: { schema: ENVELOPE_SCHEMA, render: (_args, value) => renderEnvelope('maid_init', value) },
      async execute(args, exec) {
        const mode = args?.mode;
        const { entry, root } = entryFor(exec);
        if (entry === undefined || root === undefined) return failure('E_MAID_NO_ROOT', 'this session has no session.header.cwd');
        if (mode === 'interview' || mode === 'init') {
          return failure('E_MAID_CARD_REQUIRED', 'initialization happens in the sidebar card; open 文件管家 and choose 开始设置');
        }
        if (mode !== 'defer' && mode !== 'opt_out') {
          return failure('E_MAID_SCHEMA', 'mode must be one of interview, init, defer, opt_out');
        }
        const readOnly = isReadOnlySession(ctx, exec?.agent?.session);
        if (mode === 'opt_out' && !readOnly) {
          await store.writeOptOut(root);
          await roots.load(entry);
        }
        const status = mode === 'opt_out' && !readOnly ? roots.status(entry) : undefined;
        return envelope({
          verdict: mode === 'opt_out' && !readOnly ? 'NOT_MANAGED' : 'OK',
          data: { root, mode, persisted: !readOnly, opted_out: mode === 'opt_out' && !readOnly },
          warnings: status?.warnings ?? [],
        });
      },
    },
    {
      name: 'maid_scan',
      description: '巡检受控根：统计各目录占用、与上次基线对账，可选落一份报告。只读，不改任何业务文件。',
      parameters: {
        type: 'object',
        properties: {
          scope: { type: 'string', enum: ['managed', 'root'], description: 'managed 只扫声明目录（默认）；root 扫整棵树' },
          report: { type: 'boolean', description: '是否落一份 markdown 报告，默认 false' },
        },
        additionalProperties: false,
      },
      output: { schema: ENVELOPE_SCHEMA, render: (_args, value) => renderEnvelope('maid_scan', value) },
      async execute(args, exec) {
        const scope = args?.scope === 'root' ? 'root' : 'managed';
        const wantReport = args?.report === true;
        const { entry, root } = entryFor(exec);
        if (entry === undefined || root === undefined) return failure('E_MAID_NO_ROOT', 'this session has no session.header.cwd');

        await roots.ready(entry);
        await roots.load(entry);
        const status = roots.status(entry);
        const refusal = stateEnvelope(status, root);
        if (refusal !== undefined) return refusal;

        const readOnly = isReadOnlySession(ctx, exec?.agent?.session);
        if (scope === 'root') {
          const startedAt = now();
          const walked = await probe.scanTree(root, { maxFiles: probe.SCAN_FILE_BUDGET });
          if (walked.truncated) {
            return failure('E_MAID_TOO_LARGE', `scope: root exceeds the ${probe.SCAN_FILE_BUDGET}-file budget; use scope: managed`, { root, scope, suggested_scope: 'managed' });
          }
          return envelope({
            verdict: 'OK',
            data: { root, scope, files: walked.files, dirs: walked.dirs, elapsed: now() - startedAt, persisted: false },
            warnings: readOnly ? [{ code: 'E_MAID_READ_ONLY', message: 'read-only session: nothing persisted' }] : [],
          });
        }

        const outcome = await roots.scan(entry, 'tool');
        let reportPath;
        if (wantReport && !readOnly) {
          const name = reportName(now());
          try {
            await store.writeReport(root, name, renderReport({ root, outcome, catalog: status.catalog }));
            reportPath = `.maid/reports/${name}`;
          } catch {
            reportPath = undefined;
          }
        }
        return envelope({
          verdict: outcome.degraded === true ? 'DEGRADED' : 'OK',
          data: {
            root,
            scope,
            files: outcome.files ?? 0,
            dirs: outcome.dirs ?? 0,
            elapsed: outcome.elapsed ?? 0,
            degraded: outcome.degraded === true,
            baseline: outcome.baseline === true,
            reconcile: outcome.reconcile ?? null,
            ledger: outcome.reconcile?.ledger ?? 0,
            missing: outcome.reconcile?.missing ?? [],
            report: reportPath ?? null,
            persisted: !readOnly,
          },
          warnings: readOnly ? [{ code: 'E_MAID_READ_ONLY', message: 'read-only session: nothing persisted' }] : status.warnings,
        });
      },
    },
  ];

  return {
    definitions,
    /**
     * Register every tool and return the combined disposer.
     * @returns {() => void} the disposer.
     */
    register() {
      if (ctx.tools === undefined || typeof ctx.tools.register !== 'function') {
        throw new Error('file-maid: the tools service is unavailable, refusing to load silently');
      }
      const disposers = [];
      for (const definition of definitions) {
        const dispose = ctx.tools.register(definition);
        if (typeof dispose === 'function') disposers.push(dispose);
      }
      return () => {
        for (const dispose of disposers.reverse()) {
          try {
            dispose();
          } catch {
            /* already disposed */
          }
        }
      };
    },
  };
}
