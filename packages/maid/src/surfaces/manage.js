/**
 * The card's directory manager: create, edit and delete routing directories.
 *
 * One endpoint, one payload shape. The card is a browser, so every write goes
 * through this surface: it re-reads the catalog, applies one operation, runs the
 * same validator the plugin uses at load time, and only then rewrites the file.
 * Nothing here trusts the payload for `root`: the caller names a session and the
 * host resolves that session's working directory.
 * @module file-maid/surfaces/manage
 */
import { execFile } from 'node:child_process';
import { lstat, realpath, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { validateCatalog } from '../core/catalog.js';
import { canonicalCatalogPath, validateCatalogPath } from '../core/path.js';
import * as store from '../state/store.js';
import { isReadOnlySession } from '../runtime/permissions.js';

/** npm package name the Remote contribution is filed under. */
export const REMOTE_PACKAGE = 'dsh-file-maid';

/** Wire namespace, also the Cordis service key the descriptor names. */
export const REMOTE_NAMESPACE = 'fileMaid';

/** Operations this surface accepts. */
export const OPS = Object.freeze(['add', 'update', 'remove']);

/** Result codec: the envelope is handed over as-is. */
const RESULT_CODEC = Object.freeze({ mode: 'src-json' });

/**
 * Build one strict string codec.
 * @param {string} label - parameter name, used in the type error.
 * @returns {object} the codec.
 */
function stringCodec(label) {
  return {
    mode: 'strict',
    typeSymbol: 'string',
    create: () => ({
      /**
       * @param {unknown} value - wire value.
       * @returns {string} the parsed value.
       */
      parse: (value) => {
        if (typeof value !== 'string') throw new TypeError(`${label} must be a string`);
        return value;
      },
    }),
  };
}

/**
 * Build one invocation descriptor.
 * @param {string} method - service method name.
 * @param {string[]} names - positional parameter names.
 * @returns {object} the descriptor.
 */
function invocation(method, names) {
  return {
    id: `fileMaid/${method}`,
    service: REMOTE_NAMESPACE,
    namespace: REMOTE_NAMESPACE,
    method,
    invocation: { kind: 'direct' },
    parameters: names.map((name) => ({ name, wire: name, source: 'json', codec: stringCodec(name) })),
    result: RESULT_CODEC,
  };
}

/**
 * The single endpoint the card needs.
 * @returns {object[]} the descriptors.
 */
export function remoteDescriptors() {
  return [
    invocation('draft', ['root', 'sessionId', 'path']),
    invocation('pick', ['root', 'sessionId']),
    invocation('save', ['root', 'sessionId', 'payload']),
    invocation('scan', ['root', 'sessionId']),
  ];
}

/** How long the system folder dialog may stay open before the pick is abandoned. */
const PICK_TIMEOUT_MS = 300_000;

/**
 * The folder dialogs worth trying on one platform, in order.
 *
 * No desktop is guaranteed to carry a particular tool: a headless Linux host has
 * no zenity, and Windows may only have PowerShell 7. Each entry is a complete
 * command, so a missing one is skipped instead of failing the pick.
 * @param {string} platform - `process.platform`.
 * @param {string} [start] - absolute folder the dialog starts in.
 * @returns {object[]} the candidate commands.
 */
export function dialogCandidates(platform, start) {
  const where = typeof start === 'string' && start.length > 0 ? start : undefined;
  if (platform === 'darwin') {
    // The path travels through argv, not through the script text, so a folder
    // name with a quote cannot turn into AppleScript.
    const args = [
      '-e',
      'on run argv',
      '-e',
      'set target to POSIX file (item 1 of argv)',
      '-e',
      'POSIX path of (choose folder with prompt "选择目录" default location target)',
      '-e',
      'end run',
    ];
    if (where !== undefined) args.push(where);
    return [{ file: 'osascript', args }];
  }
  if (platform === 'linux') {
    const seed = where === undefined ? [] : [`--filename=${where}/`];
    return [
      { file: 'zenity', args: ['--file-selection', '--directory', '--title=选择路由目录', ...seed] },
      { file: 'kdialog', args: ['--getexistingdirectory', where ?? '.', '--title', '选择路由目录'] },
      {
        file: 'python3',
        args: [
          '-c',
          'import sys, tkinter as tk\nfrom tkinter import filedialog\nroot = tk.Tk(); root.withdraw()\nprint(filedialog.askdirectory(initialdir=sys.argv[1]))',
          where ?? '.',
        ],
      },
    ];
  }
  if (platform === 'win32') {
    const seeding = where === undefined ? '' : `; $d.SelectedPath = '${where.replace(/'/gu, "''")}'`;
    const script = [
      '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
      'Add-Type -AssemblyName System.Windows.Forms',
      '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
      `$d.Description = '选择路由目录'${seeding}`,
      'if ($d.ShowDialog() -eq "OK") { $d.SelectedPath }',
    ].join('; ');
    return [
      { file: 'powershell', args: ['-NoProfile', '-STA', '-Command', script] },
      { file: 'pwsh', args: ['-NoProfile', '-STA', '-Command', script] },
    ];
  }
  return [];
}

/**
 * Run one candidate dialog.
 * @param {object} candidate - `{ file, args }`.
 * @returns {Promise<{ done: true, path?: string, cancelled?: boolean } | { missing: true }>} the outcome.
 */
function runDialog(candidate) {
  return new Promise((done) => {
    execFile(candidate.file, candidate.args, { timeout: PICK_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
      if (error !== null) {
        // A tool that is not installed is a candidate to skip; anything else is
        // the user closing the dialog, which is a normal answer.
        if (error.code === 'ENOENT') {
          done({ missing: true });
          return;
        }
        done({ done: true, cancelled: true });
        return;
      }
      const path = String(stdout ?? '').trim();
      if (path.length === 0) {
        done({ done: true, cancelled: true });
        return;
      }
      done({ done: true, path });
    });
  });
}

/**
 * Open the operating system's folder chooser and return the chosen path.
 *
 * The browser cannot hand out an absolute path, so the dialog runs on the host.
 * It opens at `start`, the controlled root, because a picker that starts in the
 * home directory makes the user navigate to the workspace by hand every time.
 * @param {string} start - absolute folder the dialog starts in.
 * @param {string} [platform] - `process.platform`, injectable for tests.
 * @returns {Promise<{ ok: true, path?: string, cancelled?: boolean } | { ok: false, code: string, message: string }>} the pick.
 */
export async function chooseFolderNative(start, platform = process.platform) {
  const candidates = dialogCandidates(platform, start);
  if (candidates.length === 0) {
    return { ok: false, code: 'E_MAID_UNAVAILABLE', message: `no folder dialog on ${platform}` };
  }
  for (const candidate of candidates) {
    const result = await runDialog(candidate);
    if (result.missing === true) continue;
    return { ok: true, ...(result.path === undefined ? {} : { path: result.path }), cancelled: result.cancelled === true };
  }
  return {
    ok: false,
    code: 'E_MAID_UNAVAILABLE',
    message: `none of ${candidates.map((entry) => entry.file).join(', ')} is installed on this host`,
  };
}

/**
 * Decode the JSON payload, turning a malformed body into a business failure.
 * @param {string} raw - wire value.
 * @returns {{ ok: true, value: object } | { ok: false, errors: object[] }} the payload.
 */
function decode(raw) {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return { ok: false, errors: [{ code: 'E_MAID_SCHEMA', message: 'payload is empty' }] };
  }
  try {
    const value = JSON.parse(raw);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, errors: [{ code: 'E_MAID_SCHEMA', message: 'payload must be a JSON object' }] };
    }
    return { ok: true, value };
  } catch (error) {
    return { ok: false, errors: [{ code: 'E_MAID_SCHEMA', message: `payload is not valid JSON: ${error?.message ?? String(error)}` }] };
  }
}

/**
 * Create the manage surface.
 * @param {{ ctx: object, roots: object }} options - plugin context and runtime registry.
 * @returns {{ descriptors: object[], service: object, register: () => () => void }} the surface.
 */
export function createManageSurface(options) {
  const ctx = options.ctx;
  const chooseFolder = typeof options.chooseFolder === 'function' ? options.chooseFolder : chooseFolderNative;
  // A silently unregistered endpoint is a card that answers 404, so every skip
  // in the mount path says why.
  const warn = (message) => {
    try {
      const logger = typeof ctx?.logger === 'function' ? ctx.logger('file-maid') : undefined;
      logger?.warn?.(`file-maid: ${message}`);
    } catch {
      /* a logger that throws must not fail the mount */
    }
  };
  const roots = options.roots;
  const descriptors = remoteDescriptors();

  /**
   * Reach the session service.
   *
   * The plugin declares `sessions` as a dependency, but a host that already
   * provided the service before this one mounted hands it over through `get`,
   * so both spellings are tried before the caller is told there is no session.
   * @returns {object | undefined} the service, when it is readable.
   */
  const sessionsOf = () => {
    if (typeof ctx?.sessions?.get === 'function') return ctx.sessions;
    if (typeof ctx?.get === 'function') {
      const found = ctx.get('sessions');
      if (found !== undefined && typeof found.get === 'function') return found;
    }
    return undefined;
  };

  /**
   * Resolve the session named by the card and check it owns the root.
   * @param {string} root - the root the card claims.
   * @param {string} sessionId - the session the card names.
   * @returns {{ ok: true, root: string, session?: object, readOnly?: boolean } | { ok: false, errors: object[] }} the checked root.
   */
  const checkRoot = (root, sessionId) => {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      return { ok: false, errors: [{ code: 'E_MAID_NO_ROOT', message: 'sessionId is required' }] };
    }
    const sessions = sessionsOf();
    if (sessions === undefined) {
      return { ok: false, errors: [{ code: 'E_MAID_NO_ROOT', message: 'the sessions service is unavailable to this plugin' }] };
    }
    let head;
    try {
      head = sessions.get(sessionId)?.header;
    } catch {
      head = undefined;
    }
    const own = head?.cwd;
    if (typeof own !== 'string' || own.length === 0) {
      return { ok: false, errors: [{ code: 'E_MAID_NO_ROOT', message: 'this session has no working directory' }] };
    }
    if (typeof root !== 'string' || resolve(root) !== resolve(own)) {
      return { ok: false, errors: [{ code: 'E_MAID_NO_ROOT', message: 'the root does not belong to this session' }] };
    }
    const session = sessions.get(sessionId);
    return { ok: true, root: own, session, readOnly: isReadOnlySession(ctx, session) };
  };

  /**
   * Apply one operation to a freshly read catalog.
   * @param {object} catalog - validated catalog.
   * @param {object} payload - decoded operation.
   * @returns {{ ok: true, dirs: object[], rootDefault: string } | { ok: false, errors: object[] }} the next state.
   */
  const applyOperation = async (catalog, payload, root) => {
    // `edit` names the same thing as `update` from the card's point of view; an
    // older cached bundle sends it, so the Host accepts both names.
    const op = payload.op === 'edit' ? 'update' : payload.op;
    if (!OPS.includes(op)) {
      return { ok: false, errors: [{ code: 'E_MAID_SCHEMA', message: `op must be one of ${OPS.join(', ')}` }] };
    }
    const rawPath = typeof payload.path === 'string' ? payload.path.trim() : '';
    if (rawPath.length === 0) {
      return { ok: false, errors: [{ code: 'E_MAID_PATH', message: '路径不能为空，填一个文件夹名再保存。' }] };
    }
    const checked = validateCatalogPath(rawPath);
    if (!checked.ok) return { ok: false, errors: [checked] };
    const path = canonicalCatalogPath(rawPath);
    const dirs = catalog.dirs.map((dir) => ({ ...dir }));
    const index = dirs.findIndex((dir) => dir.path === path);

    if (op === 'add') {
      if (index !== -1) return { ok: false, errors: [{ code: 'E_MAID_PATH', message: `「${path}」已经在目录列表里了，换个名字，或者直接编辑它。` }] };
      const purpose = typeof payload.purpose === 'string' ? payload.purpose.trim() : '';
      // A folder without a purpose is a row the model cannot act on, so the
      // manager refuses it instead of writing an empty cell.
      if (purpose.length === 0) {
        return { ok: false, errors: [{ code: 'E_MAID_PURPOSE_MISSING', message: '用途不能为空，写一句话说明这个目录收什么。' }] };
      }
      // The card names a folder that must already exist: a typo would otherwise
      // become a route that no file can ever land in, and the user would only
      // notice it when the plugin keeps writing to the default directory.
      let folder;
      try {
        folder = await stat(resolve(root, path));
      } catch (error) {
        // Only "no such file" means the folder is absent; anything else is a bug
        // and must not read as a user mistake.
        if (error?.code !== 'ENOENT') throw error;
        folder = undefined;
      }
      if (folder === undefined || folder.isDirectory() !== true) {
        return {
          ok: false,
          errors: [
            {
              code: 'E_MAID_PATH',
              message: `工作区里没有「${path}」这个文件夹。先在工作区里建好它，或者点「选择目录…」挑一个已有的。`,
            },
          ],
        };
      }
      dirs.push({
        path,
        purpose,
        excludes: typeof payload.excludes === 'string' ? payload.excludes.trim() : '',
        examples: [],
      });
    } else {
      if (index === -1) return { ok: false, errors: [{ code: 'E_MAID_PATH', message: `${path} is not a routing directory` }] };
      if (op === 'remove') {
        if (path === catalog.rootDefault) {
          return { ok: false, errors: [{ code: 'E_MAID_SCHEMA', message: '先让别的目录接管「没命中时放这里」，才能删它' }] };
        }
        if (dirs.length === 1) {
          return { ok: false, errors: [{ code: 'E_MAID_SCHEMA', message: '至少要保留一个目录' }] };
        }
        dirs.splice(index, 1);
      } else {
        if (payload.purpose !== undefined) {
          const purpose = typeof payload.purpose === 'string' ? payload.purpose.trim() : '';
          if (purpose.length === 0) {
            return { ok: false, errors: [{ code: 'E_MAID_PURPOSE_MISSING', message: '用途不能为空，写一句话说明这个目录收什么。' }] };
          }
          dirs[index].purpose = purpose;
        }
        if (payload.excludes !== undefined) dirs[index].excludes = typeof payload.excludes === 'string' ? payload.excludes.trim() : '';
      }
    }
    // The fallback can be moved while editing a row: one save, one write, and the
    // row being edited is the one that becomes the fallback.
    const rootDefault = payload.makeDefault === true ? path : catalog.rootDefault;
    return { ok: true, dirs, rootDefault };
  };

  /** How long a second initialisation may wait for the first one, in milliseconds. */
  const BUSY_MS = 10_000;

  /** One promise chain per root, so two cards cannot write the table at once. */
  const queues = new Map();

  /**
   * Run one task after every earlier task on the same root has settled.
   * @param {string} root - absolute controlled root.
   * @param {() => Promise<object>} task - the work.
   * @returns {Promise<object>} the task result, or `E_MAID_BUSY` when the wait exceeded the limit.
   */
  const withRootLock = async (root, task) => {
    const key = resolve(root);
    const prior = queues.get(key) ?? Promise.resolve();
    const started = Date.now();
    const run = prior.then(async () => {
      if (Date.now() - started > BUSY_MS) {
        return { ok: false, errors: [{ code: 'E_MAID_BUSY', message: '另一个写入正在进行，稍后再试。' }] };
      }
      return task();
    });
    queues.set(
      key,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    try {
      return await run;
    } finally {
      if (queues.get(key) === undefined) queues.delete(key);
    }
  };

  /**
   * Describe one candidate path without touching the disk beyond `lstat`/`stat`.
   * @param {string} root - absolute controlled root.
   * @param {string} input - what the card typed or picked.
   * @returns {Promise<object | null>} the description, or null for an empty input.
   */
  const describePath = async (root, input) => {
    const typed = typeof input === 'string' ? input.trim() : '';
    if (typed === '') return null;
    // Backslashes come from a pasted Windows path; a trailing slash is common after
    // a folder dialog. Both are the same folder the user means.
    const normalized = typed.replace(/\\+/gu, '/').replace(/\/+$/u, '');
    const base = { input: typed, relative: normalized, exists: false, kind: 'absent', problem: null };
    const verdict = validateCatalogPath(normalized);
    if (!verdict.ok) {
      return { ...base, problem: '路径只能写相对工作区的文件夹名，最多 3 段，且不能用 .maid、.git 这类保留目录。' };
    }
    const relativePath = canonicalCatalogPath(normalized);
    const parts = relativePath.split('/');
    for (let depth = 1; depth <= parts.length; depth += 1) {
      const candidate = join(root, ...parts.slice(0, depth));
      const info = await lstat(candidate).catch(() => undefined);
      if (info === undefined) {
        return { ...base, relative: relativePath, kind: 'absent', problem: '这个文件夹不在磁盘上。' };
      }
      if (info.isSymbolicLink()) {
        return { ...base, relative: relativePath, kind: 'link', problem: '这个路径经过符号链接，写入后目录表会判错。换真实路径。' };
      }
      if (depth < parts.length && !info.isDirectory()) {
        return { ...base, relative: relativePath, kind: 'file', problem: '路径中间有一段不是文件夹。' };
      }
      if (depth === parts.length) {
        if (!info.isDirectory()) {
          return { ...base, relative: relativePath, kind: 'file', exists: true, problem: '这是一个文件，不是文件夹。' };
        }
        return { ...base, relative: relativePath, exists: true, kind: 'dir', problem: null };
      }
    }
    return { ...base, relative: relativePath };
  };

  /**
   * Create a catalog from the folders the card listed.
   *
   * The card is the only writer of `catalog.yml` this plugin has, so every rule
   * the loader enforces is applied here first: the file must never be written in
   * a state that would load as `ERROR` on the next scan.
   * @param {object} owned - result of `checkRoot`.
   * @param {object} payload - `{ dirs, rootDefault }`.
   * @param {string} sessionId - session the card names.
   * @returns {Promise<object>} `{ ok, value }` or `{ ok: false, errors }`.
   */
  const runInit = async (owned, payload, sessionId) => {
    if (owned.readOnly === true) {
      return { ok: false, errors: [{ code: 'E_MAID_READONLY', message: '这个会话是只读的，不能写入目录表。' }] };
    }
    const listed = Array.isArray(payload.dirs) ? payload.dirs : [];
    if (listed.length === 0) {
      return { ok: false, errors: [{ code: 'E_MAID_SCHEMA', message: '至少要添加一个目录。' }] };
    }
    if (listed.length > 64) {
      return { ok: false, errors: [{ code: 'E_MAID_SCHEMA', message: '最多 64 个目录。' }] };
    }

    const dirs = [];
    const seen = new Map();
    for (const item of listed) {
      const wanted = typeof item?.path === 'string' ? item.path : '';
      const described = await describePath(owned.root, wanted);
      if (described === null) {
        return { ok: false, errors: [{ code: 'E_MAID_PATH', message: '路径不能为空。', path: '' }] };
      }
      if (described.problem !== null || described.exists !== true) {
        return { ok: false, errors: [{ code: 'E_MAID_PATH', message: described.problem ?? '这个文件夹不可用。', path: described.relative }] };
      }
      const purpose = typeof item?.purpose === 'string' ? item.purpose.trim() : '';
      if (purpose === '') {
        return { ok: false, errors: [{ code: 'E_MAID_PURPOSE_MISSING', message: '用途不能为空，写一句话说明这个目录收什么。', path: described.relative }] };
      }
      // Two spellings of one folder are one row: the catalog is compared by what
      // the filesystem says, not by how the string was typed.
      let identity;
      try {
        const real = await realpath(join(owned.root, described.relative));
        const info = await stat(real);
        identity = `${info.dev}:${info.ino}`;
      } catch (error) {
        return { ok: false, errors: [{ code: 'E_MAID_IO', message: `cannot read the folder: ${error?.message ?? String(error)}`, path: described.relative }] };
      }
      if (seen.has(identity)) {
        return { ok: false, errors: [{ code: 'E_MAID_DUPLICATE', message: '这个目录已经加过了。', path: described.relative }] };
      }
      seen.set(identity, described.relative);
      dirs.push({ path: described.relative, purpose, excludes: typeof item?.excludes === 'string' ? item.excludes.trim() : '' });
    }

    const rootDefault = typeof payload.rootDefault === 'string' ? canonicalCatalogPath(payload.rootDefault) : '';
    if (rootDefault === '' || !dirs.some((dir) => dir.path === rootDefault)) {
      return { ok: false, errors: [{ code: 'E_MAID_DEFAULT_MISSING', message: '选一个「没命中时放这里」的目录，判断不出来的文件会进它。', path: '' }] };
    }
    const verdict = validateCatalog({ version: 1, root_default: rootDefault, dirs, rules: [] });
    if (!verdict.ok) return { ok: false, errors: verdict.errors };

    return withRootLock(owned.root, async () => {
      const loaded = await store.readCatalog(owned.root);
      if (loaded.state === 'MANAGED') {
        return { ok: false, errors: [{ code: 'E_MAID_EXISTS', message: '目录表已经存在，刷新后就能看到。' }] };
      }
      if (loaded.state === 'NOT_MANAGED') {
        return { ok: false, errors: [{ code: 'E_MAID_OPT_OUT', message: '这个根已经关闭管理。' }] };
      }
      if (loaded.state === 'ERROR' && loaded.blank !== true) {
        return { ok: false, errors: [{ code: 'E_MAID_CATALOG', message: '目录表有问题，先修好再回来。' }] };
      }
      try {
        await store.writeCatalog(owned.root, store.serializeCatalog(verdict.catalog, { root: owned.root }));
      } catch (error) {
        return { ok: false, errors: [{ code: 'E_MAID_IO', message: `cannot write catalog.yml: ${error?.message ?? String(error)}` }] };
      }
      try {
        await store.appendLog(owned.root, 'audit', {
          op: 'init',
          dirs: dirs.length,
          rootDefault,
          session: sessionId,
          previousHash: loaded.hash ?? null,
        });
      } catch {
        /* a missing audit line must not undo a written table */
      }
      let scan = null;
      try {
        const outcome = await roots.scanRoot(owned.root);
        scan = {
          files: outcome.files ?? 0,
          dirs: outcome.dirs ?? 0,
          elapsed: outcome.elapsed ?? 0,
          degraded: outcome.degraded === true,
          baseline: outcome.baseline === true,
        };
      } catch {
        /* the table is on disk; a failed first count is a warning, not a rollback */
      }
      try {
        await roots.reloadRoot(owned.root);
      } catch {
        /* the next tool call re-reads anyway */
      }
      return {
        ok: true,
        value: {
          state: 'MANAGED',
          dirs: dirs.length,
          rootDefault,
          scan,
          warnings: verdict.warnings ?? [],
          persisted: true,
        },
      };
    });
  };

  const service = {
    typertRemote: { service: undefined, serviceKey: REMOTE_NAMESPACE, namespace: REMOTE_NAMESPACE },
    /**
     * Describe one candidate folder, and whether this root can still be set up.
     * Read-only: it never writes and never scans.
     * @param {string} root - controlled root.
     * @param {string} sessionId - session the card names.
     * @param {string} path - relative folder the card typed, or the empty string.
     * @returns {Promise<object>} `{ ok, value }` or `{ ok: false, errors }`.
     */
    async draft(root, sessionId, path) {
      const owned = checkRoot(root, sessionId);
      if (!owned.ok) return { ok: false, errors: owned.errors };
      const loaded = await store.readCatalog(owned.root);
      const described = await describePath(owned.root, path);
      return {
        ok: true,
        value: {
          state: loaded.state,
          canInit: loaded.state === 'UNINITIALIZED' || (loaded.state === 'ERROR' && loaded.blank === true),
          canWrite: owned.readOnly !== true,
          readOnly: owned.readOnly === true,
          rootDefault: loaded.catalog?.rootDefault ?? null,
          path: described,
          errors: loaded.errors ?? [],
          warnings: loaded.warnings ?? [],
        },
      };
    },
    /**
     * Open the system folder dialog and return the pick as a path inside the root.
     *
     * A path outside the controlled root is refused: a routing directory is a
     * folder in this workspace, not anywhere on the machine.
     * @param {string} root - controlled root.
     * @param {string} sessionId - session the card names.
     * @returns {Promise<object>} `{ ok, value }` or `{ ok: false, errors }`.
     */
    async pick(root, sessionId) {
      const owned = checkRoot(root, sessionId);
      if (!owned.ok) return { ok: false, errors: owned.errors };
      const chosen = await chooseFolder(owned.root);
      if (chosen.ok !== true) return { ok: false, errors: [{ code: chosen.code, message: chosen.message }] };
      if (chosen.cancelled === true || typeof chosen.path !== 'string' || chosen.path.length === 0) {
        return { ok: true, value: { cancelled: true } };
      }
      const inside = relative(owned.root, chosen.path);
      if (inside.length === 0 || inside.startsWith('..') || inside.split(sep).includes('..')) {
        return {
          ok: false,
          errors: [
            {
              code: 'E_MAID_PATH',
              message: `只能添加工作区里面的文件夹。你选的位置在 ${owned.root} 之外，换一个工作区内的目录再试。`,
            },
          ],
        };
      }
      return { ok: true, value: { path: inside.split(sep).join('/'), cancelled: false } };
    },
    /**
     * Run one managed scan for the card and republish the projection.
     * @param {string} root - controlled root.
     * @param {string} sessionId - session the card names.
     * @returns {Promise<object>} `{ ok, value }` or `{ ok: false, errors }`.
     */
    async scan(root, sessionId) {
      const owned = checkRoot(root, sessionId);
      if (!owned.ok) return { ok: false, errors: owned.errors };
      try {
        const outcome = await roots.scanRoot(owned.root);
        return {
          ok: true,
          value: {
            files: outcome.files ?? 0,
            dirs: outcome.dirs ?? 0,
            elapsed: outcome.elapsed ?? 0,
            degraded: outcome.degraded === true,
            baseline: outcome.baseline === true,
            reconcile: outcome.reconcile ?? null,
            ledger: outcome.reconcile?.ledger ?? 0,
            missing: outcome.reconcile?.missing ?? [],
          },
        };
      } catch (error) {
        return { ok: false, errors: [{ code: 'E_MAID_IO', message: `cannot scan: ${error?.message ?? String(error)}` }] };
      }
    },
    /**
     * Create, edit or delete one routing directory.
     * @param {string} root - controlled root.
     * @param {string} sessionId - session the card names.
     * @param {string} payload - JSON body `{ op, path, purpose?, excludes? }`.
     * @returns {Promise<object>} `{ ok, value }` or `{ ok: false, errors }`.
     */
    async save(root, sessionId, payload) {
      const owned = checkRoot(root, sessionId);
      if (!owned.ok) return { ok: false, errors: owned.errors };
      const decoded = decode(payload);
      if (!decoded.ok) return { ok: false, errors: decoded.errors };
      if (decoded.value.op === 'init') return runInit(owned, decoded.value, sessionId);
      if (owned.readOnly === true) {
        return { ok: false, errors: [{ code: 'E_MAID_READONLY', message: '这个会话是只读的，不能改目录表。' }] };
      }

      const loaded = await store.readCatalog(owned.root);
      if (loaded.state !== 'MANAGED') {
        return {
          ok: false,
          errors: [{ code: loaded.state === 'NOT_MANAGED' ? 'E_MAID_OPT_OUT' : 'E_MAID_UNINITIALIZED', message: 'this root has no catalog to edit' }],
        };
      }
      const next = await applyOperation(loaded.catalog, decoded.value, owned.root);
      if (!next.ok) return { ok: false, errors: next.errors };

      const verdict = validateCatalog({ version: 1, root_default: next.rootDefault, dirs: next.dirs, rules: loaded.catalog.rules });
      if (!verdict.ok) return { ok: false, errors: verdict.errors };

      try {
        await store.writeCatalog(owned.root, store.serializeCatalog(verdict.catalog, { root: owned.root }));
      } catch (error) {
        return { ok: false, errors: [{ code: 'E_MAID_IO', message: `cannot write catalog.yml: ${error?.message ?? String(error)}` }] };
      }
      // The catalog is hand-editable, so the only record of who changed it through
      // the card is this line: operation, folder and session.
      try {
        await store.appendLog(owned.root, 'audit', {
          op: decoded.value.op,
          path: canonicalCatalogPath(String(decoded.value.path)),
          session: sessionId,
        });
      } catch {
        /* an audit line that cannot be appended must not undo the edit */
      }
      await roots.projectRoot(owned.root);
      return {
        ok: true,
        value: {
          dirs: verdict.catalog.dirs.map((dir) => ({
            path: dir.path,
            purpose: dir.purpose,
            excludes: dir.excludes,
          })),
          rootDefault: verdict.catalog.rootDefault,
          warnings: verdict.warnings,
        },
      };
    },
  };
  // A thrown error must still be an answer: the card shows a message either way,
  // and an unanswered call reads to the user as a dead connection.
  for (const name of ['draft', 'pick', 'save']) {
    const method = service[name].bind(service);
    service[name] = async (...args) => {
      try {
        return await method(...args);
      } catch (error) {
        return { ok: false, errors: [{ code: 'E_MAID_IO', message: `${error?.message ?? String(error)}` }] };
      }
    };
  }
  service.typertRemote.service = service;

  return {
    descriptors,
    service,
    /**
     * Provide the service and file the descriptor with the Typert registry.
     * @returns {() => void} disposer.
     */
    register() {
      if (typeof ctx.inject !== 'function') return () => {};
      let fiber;
      try {
        fiber = ctx.inject(['typert'], (inner) => {
          const typert = typeof inner.get === 'function' ? inner.get('typert') : undefined;
          if (typert === undefined || typeof typert.register !== 'function') return;
          try {
            ctx.provide(REMOTE_NAMESPACE, service);
          } catch {
            return;
          }
          try {
            typert.register({
              package: REMOTE_PACKAGE,
              face: 'host',
              schemas: [],
              model: { services: [], events: [], objects: [] },
              invocations: descriptors,
            });
          } catch {
            /* a duplicate registration means an earlier mount already filed this endpoint */
          }
        });
      } catch {
        return () => {};
      }
      return () => {
        try {
          fiber?.dispose?.();
        } catch {
          /* already unloaded */
        }
      };
    },
  };
}
