/**
 * Root registry: one entry per session that points at a controlled root.
 *
 * The entry holds the validated catalog and the last scan, and it is the only
 * place that reads the catalog back from disk. Everything else — tools, the
 * prompt section, the status projection — reads this registry, so a catalog
 * that changes on disk is picked up by one refresh instead of many readers.
 * @module file-maid/runtime/roots
 */
import { reconcile } from '../core/reconcile.js';
import * as store from '../state/store.js';
import { scanManaged, snapshotFromIndex, snapshotOf } from './scan.js';

/** Recent decision records the card shows. */
export const ROUTES_KEPT = 10;

/**
 * Create the registry.
 * @param {{ ctx: object, now?: () => number }} options - plugin context and clock.
 * @returns {object} the registry.
 */
/** Roots already counted in this process, so a session storm cannot walk the tree repeatedly. */
const countedRoots = new Set();

export function createRoots(options) {
  const now = options.now ?? Date.now;
  const entries = new Map();

  const rootOf = (agent) => {
    const cwd = agent?.session?.header?.cwd;
    return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined;
  };

  /**
   * Get or create the entry for one agent.
   * @param {object | undefined} agent - calling agent.
   * @returns {object | undefined} the entry, or undefined when the session has no cwd.
   */
  const acquire = (agent) => {
    const root = rootOf(agent);
    if (root === undefined) return undefined;
    const id = agent?.id ?? agent?.session?.id ?? root;
    const existing = entries.get(id);
    if (existing !== undefined && existing.root === root) return existing;
    const entry = {
      id,
      root,
      catalogState: 'PENDING',
      catalog: undefined,
      errors: [],
      warnings: [],
      catalogHash: undefined,
      snapshot: undefined,
      reconcile: undefined,
      lastScan: undefined,
    };
    entries.set(id, entry);
    return entry;
  };

  /**
   * Look up an existing entry without creating one.
   * @param {object | undefined} agent - calling agent.
   * @returns {object | undefined} the entry.
   */
  const forAgent = (agent) => {
    const id = agent?.id ?? agent?.session?.id;
    if (id !== undefined) {
      const entry = entries.get(id);
      if (entry !== undefined) return entry;
    }
    const root = rootOf(agent);
    if (root === undefined) return undefined;
    for (const entry of entries.values()) if (entry.root === root) return entry;
    return undefined;
  };

  /**
   * Read and validate the catalog, replacing the entry's cached state.
   * @param {object} entry - root entry.
   * @returns {Promise<object>} the entry.
   */
  const load = async (entry) => {
    try {
      const loaded = await store.readCatalog(entry.root);
      entry.catalogState = loaded.state;
      entry.catalog = loaded.catalog;
      entry.errors = loaded.errors ?? [];
      entry.warnings = loaded.warnings ?? [];
      entry.catalogHash = loaded.hash;
    } catch (error) {
      entry.catalogState = 'ERROR';
      entry.catalog = undefined;
      entry.errors = [{ code: 'E_MAID_CATALOG', message: String(error?.message ?? error) }];
    }
    return entry;
  };

  /**
   * Load the catalog once per entry when it was never loaded.
   * @param {object} entry - root entry.
   * @returns {Promise<object>} the entry.
   */
  const ready = async (entry) => {
    if (entry.catalogState === 'PENDING') await load(entry);
    return entry;
  };

  /**
   * Count the decision records written after one instant.
   * @param {string} root - controlled root.
   * @param {string | undefined} since - ISO timestamp, inclusive.
   * @returns {Promise<number>} the count.
   */
  /**
   * Read one log stream restricted to a window.
   *
   * Both channel streams answer the same three questions: how many records fall
   * inside the window, which paths they name, and when the stream itself starts
   * — the last one decides whether the stream can cover the window at all.
   * @param {string} root - absolute controlled root.
   * @param {'decisions'|'writes'} stream - channel stream name.
   * @param {string | undefined} since - window start as an ISO string.
   * @returns {Promise<{ count: number, paths: Set<string>, earliest: number | undefined, covered: boolean }>} the window slice.
   */
  const readWindow = async (root, stream, since) => {
    let records = [];
    let rotatedAt;
    try {
      // Read the whole stream: one rotation window is at most `LOG_BYTES_LIMIT`,
      // so the tail cap would silently under-count a busy window, and under-counting
      // is indistinguishable from "these files really never went through the plugin".
      records = await store.readLogTail(root, stream, Number.POSITIVE_INFINITY);
      const marks = await store.readRotation(root);
      rotatedAt = Date.parse(marks?.[stream]);
    } catch {
      return { count: 0, paths: new Set(), earliest: undefined, birth: undefined, rotated: false, covered: false };
    }
    let earliest;
    for (const record of records) {
      const at = Date.parse(record?.at);
      if (Number.isFinite(at) && (earliest === undefined || at < earliest)) earliest = at;
    }
    const floor = since === undefined ? undefined : Date.parse(since);
    const inside = Number.isFinite(floor)
      ? records.filter((record) => {
          const at = Date.parse(record?.at);
          return Number.isFinite(at) ? at >= floor : false;
        })
      : records;
    // The ledger's `init` marker names no file: it dates the stream, it does not
    // count as one write, so only records carrying a path are counted.
    const paths = new Set();
    let count = 0;
    for (const record of inside) {
      const path = typeof record?.path === 'string' ? record.path : '';
      if (path === '') continue;
      count += 1;
      paths.add(path);
    }
    // Two things can leave a hole, and they are different in kind:
    //   * a rotation inside the window moved records out of the file that was read;
    //   * the write ledger was born inside the window (its `init` marker is newer
    //     than the window start), so writes before its birth are simply unknown.
    // Counts that merely begin after the window start are not a hole: nothing
    // happened before, which is exactly what a zero count says.
    let birth;
    for (const record of records) {
      if (record?.kind !== 'init') continue;
      const at = Date.parse(record?.at);
      if (Number.isFinite(at) && (birth === undefined || at < birth)) birth = at;
    }
    const rotated = Number.isFinite(floor) && Number.isFinite(rotatedAt) && rotatedAt >= floor;
    const bornLate = stream === 'writes' && Number.isFinite(floor) && Number.isFinite(birth) && birth > floor;
    return { count, paths, earliest, birth, rotated, covered: !rotated && !bornLate };
  };

  const countDecisions = async (root, since) => (await readWindow(root, 'decisions', since)).count;

  /**
   * Run one managed-union scan, reconcile it, and persist the snapshot.
   * @param {object} entry - root entry.
   * @param {string} [reason] - why the scan ran.
   * @returns {Promise<object>} the outcome.
   */
  const scan = async (entry, reason = 'scan') => {
    await load(entry);
    const startedAt = now();
    if (entry.catalogState !== 'MANAGED') {
      const outcome = {
        ok: false,
        scope: 'managed',
        reason,
        catalogState: entry.catalogState,
        files: 0,
        dirs: 0,
        elapsed: now() - startedAt,
        degraded: false,
        baseline: false,
        reconcile: undefined,
      };
      entry.lastScan = outcome;
      await project(entry, outcome);
      return outcome;
    }

    let stored;
    try {
      stored = (await store.readIndex(entry.root)).index;
    } catch {
      stored = undefined;
    }
    const before = snapshotFromIndex(stored);
    const windowStart = stored?.generatedAt;
    const floor = windowStart === undefined ? undefined : Date.parse(windowStart);
    const result = await scanManaged({
      root: entry.root,
      catalog: entry.catalog,
      now,
      since: Number.isFinite(floor) ? floor : undefined,
    });
    const snapshot = snapshotOf(result);
    const decisionsWindow = await readWindow(entry.root, 'decisions', windowStart);
    const ledgerWindow = await readWindow(entry.root, 'writes', windowStart);
    // The ledger only covers the window when its own first record is older than
    // the window start; a reborn or rotated ledger cannot name what it missed.
    const ledgerIncomplete = !ledgerWindow.covered;
    const decisionsIncomplete = !decisionsWindow.covered;
    const reconciliation = reconcile({
      before,
      after: snapshot,
      recorded: decisionsWindow.count,
      ledger: ledgerWindow.count,
      recordedPaths: decisionsWindow.paths,
      ledgerPaths: ledgerWindow.paths,
      candidates: result.candidates,
      truncated: result.candidatesTruncated,
      ledgerIncomplete,
      decisionsIncomplete,
    });

    entry.snapshot = snapshot;
    entry.reconcile = reconciliation;
    try {
      await store.writeIndex(entry.root, {
        schemaVersion: store.INDEX_SCHEMA_VERSION,
        generatedAt: new Date(now()).toISOString(),
        baseline: before === undefined,
        files: snapshot.files,
        roots: Object.fromEntries(Object.entries(snapshot.dirs).map(([path, files]) => [path, { files }])),
      });
    } catch {
      /* a snapshot that cannot be written must not fail the scan */
    }

    const outcome = {
      ok: true,
      scope: 'managed',
      reason,
      catalogState: 'MANAGED',
      files: snapshot.files,
      dirs: result.dirs,
      bytes: result.bytes,
      elapsed: result.elapsed,
      degraded: result.degraded,
      baseline: before === undefined,
      reconcile: reconciliation,
    };
    entry.lastScan = outcome;
    await project(entry, outcome);
    return outcome;
  };

  /**
   * Write the read-only projection the card reads.
   * @param {object} entry - root entry.
   * @param {object} outcome - the scan outcome just produced.
   * @returns {Promise<void>} fulfillment after the write attempt.
   */
  const project = async (entry, outcome) => {
    const catalog = entry.catalog;
    const snapshot = entry.snapshot;
    const directories = (catalog?.dirs ?? []).map((dir) => ({
      path: dir.path,
      purpose: dir.purpose,
      excludes: dir.excludes,
      files: typeof snapshot?.dirs?.[dir.path] === 'number' ? snapshot.dirs[dir.path] : null,
    }));
    let routes = [];
    try {
      routes = await store.readLogTail(entry.root, 'decisions', ROUTES_KEPT);
    } catch {
      /* the card degrades to an empty list */
    }
    const document = {
      schemaVersion: '2',
      generatedAt: new Date(now()).toISOString(),
      root: entry.root,
      catalog: {
        state: entry.catalogState,
        hash: entry.catalogHash ?? null,
        rootDefault: catalog?.rootDefault ?? null,
        ruleCount: catalog?.rules?.length ?? 0,
        dirs: directories,
        errors: [...(entry.errors ?? [])],
        warnings: [...(entry.warnings ?? [])],
      },
      // No scan outcome means no scan has run here yet. Writing zeros instead
      // would state "this workspace is empty", which is a different claim.
      scan: outcome === undefined
        ? undefined
        : {
            baseline: outcome.baseline === true,
            scannedAt: new Date(now()).toISOString(),
            durationMs: typeof outcome.elapsed === 'number' ? outcome.elapsed : 0,
            files: typeof outcome.files === 'number' ? outcome.files : 0,
            dirs: typeof outcome.dirs === 'number' ? outcome.dirs : 0,
            degraded: outcome.degraded === true,
          },
      reconcile: entry.reconcile ?? null,
      routes: routes.map((record) => ({
        at: record.at ?? null,
        name: record.name ?? '',
        dir: record.dir ?? '',
        decided_by: record.decided_by ?? null,
        intent_source: record.intent_source ?? null,
        overridden: record.overridden === true,
      })),
    };
    try {
      await store.writeStatus(entry.root, document);
    } catch {
      /* the panel is a projection; failing it never fails a scan */
    }
  };

  /**
   * Reproject one root from disk, without holding a session entry.
   *
   * The card's directory manager edits the catalog outside any session turn, so
   * it needs a way to republish the projection it just invalidated.
   * @param {string} root - absolute controlled root.
   * @returns {Promise<void>} fulfillment after the write attempt.
   */
  const projectRoot = async (root) => {
    const loaded = await store.readCatalog(root);
    const snapshot = await store.readIndex(root);
    await project(
      {
        root,
        catalog: loaded.catalog,
        catalogState: loaded.state,
        catalogHash: loaded.hash,
        snapshot: snapshot === undefined ? undefined : snapshotFromIndex(snapshot),
        errors: loaded.errors ?? [],
        warnings: loaded.warnings ?? [],
      },
      undefined,
    );
  };

  /**
   * Drop the cached catalog for every entry on one root and load it again.
   *
   * `scanRoot` refreshes only the first entry it finds, so a session that just
   * wrote the table through the card would otherwise keep the old projection
   * until its own next tool call.
   * @param {string} root - absolute controlled root.
   * @returns {Promise<number>} how many entries were reloaded.
   */
  const reloadRoot = async (root) => {
    const touched = [];
    for (const entry of entries.values()) {
      if (entry.root !== root) continue;
      entry.catalogState = 'PENDING';
      entry.catalog = undefined;
      entry.errors = [];
      entry.warnings = [];
      touched.push(entry);
    }
    for (const entry of touched) {
      await load(entry);
      await project(entry, entry.lastScan);
    }
    return touched.length;
  };

  /**
   * Project the current state without scanning.
   * @param {object} entry - root entry.
   * @returns {Promise<void>} fulfillment after the write attempt.
   */
  const refreshStatus = async (entry) => {
    await ready(entry);
    await project(entry, entry.lastScan);
  };

  /**
   * Scan one root that no session entry owns yet.
   *
   * The card can ask for a scan outside any turn, so the entry is built here
   * when the root has none; a registered entry for the same root is reused so
   * the card and the session never project two different snapshots.
   * @param {string} root - absolute controlled root.
   * @returns {Promise<object>} the scan outcome.
   */
  const scanRoot = async (root) => {
    for (const candidate of entries.values()) {
      if (candidate.root === root) return scan(candidate, 'card');
    }
    const entry = {
      id: `root:${root}`,
      root,
      catalogState: 'PENDING',
      catalog: undefined,
      errors: [],
      warnings: [],
      catalogHash: undefined,
      snapshot: undefined,
      reconcile: undefined,
      lastScan: undefined,
    };
    return scan(entry, 'card');
  };

  return {
    acquire,
    scanRoot,
    reloadRoot,
    forAgent,
    load,
    ready,
    scan,
    project,
    refreshStatus,
    projectRoot,
    /**
     * The validated catalog for one agent, for the prompt provider.
     * Pure and synchronous: it never loads or scans.
     * @param {object | undefined} agent - calling agent.
     * @returns {object | undefined} the catalog, when managed.
     */
    view(agent) {
      const entry = forAgent(agent);
      return entry?.catalogState === 'MANAGED' ? entry.catalog : undefined;
    },
    /**
     * The current state, for tool envelopes.
     * @param {object} entry - root entry.
     * @returns {object} the state.
     */
    status(entry) {
      return {
        catalogState: entry.catalogState,
        catalog: entry.catalog,
        errors: [...(entry.errors ?? [])],
        warnings: [...(entry.warnings ?? [])],
        degraded: entry.lastScan?.degraded === true,
      };
    },
    /**
     * Load the catalog when the entry still carries none.
     * @param {object} entry - root entry.
     * @returns {Promise<object>} the entry.
     */
    async start(entry) {
      const loaded = await ready(entry);
      // The card shows one file count per directory; without a scan it would show
      // nothing, so the first session on a root counts it in the background. Later
      // sessions reuse the projection instead of walking the tree again.
      if (entry.lastScan === undefined && !countedRoots.has(entry.root)) {
        countedRoots.add(entry.root);
        void scan(entry, 'startup').catch(() => {
          /* a background count that fails leaves the counts unknown, not wrong */
        });
      }
      return loaded;
    },
    /**
     * Drop one session's entry.
     * @param {object | undefined} agent - the agent.
     * @returns {void}
     */
    release(agent) {
      const id = agent?.id ?? agent?.session?.id;
      if (id !== undefined) entries.delete(id);
    },
    /**
     * Drop every entry.
     * @returns {void}
     */
    disposeAll() {
      entries.clear();
    },
  };
}
