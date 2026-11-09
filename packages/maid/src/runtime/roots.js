  const patchAcknowledgement = (entry, delta, path) => {
    const reconcile = entry.reconcile;
    if (reconcile === undefined || reconcile === null) return undefined;
    const patched = applyAck(reconcile, delta, path);
    entry.reconcile = patched;
    if (entry.lastScan !== undefined) entry.lastScan = { ...entry.lastScan, reconcile: patched };
    return patched;
  };

  /**
   * Flip one entry's accepted flag and recompute the three counts.
   *
   * The entry is kept rather than removed: an undo needs the row back, and the card
   * needs to know which rows were accepted before it re-reads the review.
   * @param {object} reconcile - a reconciliation (or projection) to patch.
   * @param {number} delta - `+1` to accept, `-1` to undo.
   * @param {string} path - the relative path.
   * @returns {object} a new reconciliation.
   */
  const applyAck = (reconcile, delta, path) => {
    const items = (reconcile.missing ?? []).map((item) => (item.path === path ? { ...item, acknowledged: delta > 0 } : item));
    const accepted = items.filter((item) => item.acknowledged === true).length;
    const open = items.filter((item) => item.acknowledged !== true);
    return {
      ...reconcile,
      missing: items,
      acknowledged_files: accepted,
      missing_total: open.length + accepted,
    };
  };

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
import { CANDIDATE_LIMIT, scanManaged, snapshotFromIndex, snapshotOf } from './scan.js';
import { ackKey, pruneAcks } from '../core/ack.js';
import { measure } from './measure.js';
import { countDecisions as countWindowDecisions, readWindow } from './window.js';

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
  const countDecisions = countWindowDecisions;

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

    const storedAcks = await store.readAcknowledged(entry.root).catch(() => ({ entries: {}, revision: 0 }));
    const acks = Object.entries(storedAcks.entries).map(([path, value]) => ({ path, ctime: value.ctime }));
    const measurement = await measure({ root: entry.root, catalog: entry.catalog, now, acks });
    const { result, snapshot, reconciliation } = measurement;

    entry.snapshot = snapshot;
    entry.reconcile = reconciliation;
    try {
      await store.writeIndex(entry.root, {
        schemaVersion: store.INDEX_SCHEMA_VERSION,
        generatedAt: new Date(now()).toISOString(),
        baseline: measurement.baseline,
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
      baseline: measurement.baseline,
      reconcile: reconciliation,
    };
    entry.lastScan = outcome;
    await project(entry, outcome);
    return outcome;
  };

  /**
   * Accept or un-accept one leak (`§5`).
   *
   * The books do not move: the file still counts as new, it just stops being
   * listed. Every write goes through the prune first, so the file cannot grow
   * past its caps.
   * @param {object} entry - root entry.
   * @param {{ op: 'ack'|'unack', path: string, ctime: number }} input - the change.
   * @returns {Promise<object>} `{ ok: true, revision, counts }` or `{ ok: false, error }`.
   */
  const acknowledge = async (entry, input) => {
    await load(entry);
    if (entry.catalogState !== 'MANAGED') {
      return { ok: false, error: { code: 'E_MAID_UNINITIALIZED', message: 'this root has no catalog to review' } };
    }
    const path = typeof input?.path === 'string' ? input.path : '';
    const ctime = Number(input?.ctime);
    if (path === '' || path.startsWith('/') || path.split('/').includes('..')) {
      return { ok: false, error: { code: 'E_MAID_PATH', message: 'the path must be relative and stay inside the root' } };
    }
    if (!Number.isFinite(ctime) || ctime <= 0) {
      return { ok: false, error: { code: 'E_MAID_ACK_CTIME', message: 'ctime must be a positive integer in milliseconds' } };
    }
    const current = await store.readAcknowledged(entry.root);
    const dirs = (entry.catalog?.dirs ?? []).map((dir) => dir.path);
    const pruned = pruneAcks({ entries: current.entries, dirs, now: now() });
    const entries = { ...pruned.kept };
    if (input.op === 'ack') entries[path] = { ctime, at: new Date(now()).toISOString() };
    else delete entries[path];
    const revision = await store.writeAcknowledged(entry.root, { entries, revision: current.revision });
    try {
      await store.appendLog(entry.root, 'audit', { action: `ack-${input.op === 'ack' ? 'accept' : 'undo'}`, target: path, revision });
    } catch {
      /* an audit line that cannot be written must not undo the acceptance */
    }
    const patched = patchAcknowledgement(entry, input.op === 'ack' ? 1 : -1, path);
    if (entry.lastScan !== undefined && patched !== undefined) {
      await project(entry, { ...entry.lastScan, reconcile: patched });
      await patchStoredProjection(entry);
    } else {
      // After a host restart this entry has no scan of its own yet, but the card is
      // still showing the projection the last scan wrote. Patch that document, or
      // the row the operator just accepted would reappear until the next scan.
      await patchStoredProjection(entry);
    }
    return { ok: true, revision, counts: patched ?? undefined, dropped: pruned.dropped };
  };

  /**
   * Patch the on-disk projection when this process has no scan outcome to reuse.
   * @param {string} root - controlled root.
   * @param {number} delta - `+1` after an acceptance, `-1` after an undo.
   * @param {string} path - the relative path that changed.
   * @returns {Promise<void>} fulfillment after the write attempt.
   */
  const patchStoredProjection = async (entry) => {
    try {
      // Re-measure instead of patching the old document: the row being accepted may
      // not have existed when that document was written (a leak found by a review
      // after the last scan), and a patch could only flip rows it already had.
      const refreshed = await review(entry);
      if (refreshed.ok !== true) return;
      const text = await store.readText(store.pathsFor(entry.root).status);
      if (text === undefined) return;
      const document = JSON.parse(text);
      const accepted = refreshed.acknowledged ?? [];
      const rows = [
        ...refreshed.missing.map((item) => ({ path: item.path, dir: item.dir, ctime: item.ctime ?? null, acknowledged: false })),
        ...accepted.map((item) => ({ path: item.path, dir: item.path.split('/')[0], ctime: item.ctime ?? null, acknowledged: true })),
      ];
      document.reconcile = {
        ...(document.reconcile ?? {}),
        new_files: refreshed.counts.new_files,
        recorded_files: refreshed.counts.recorded_files,
        ledger_files: refreshed.counts.ledger_files,
        acknowledged_files: refreshed.counts.acknowledged_files,
        missing_total: refreshed.counts.missing_total,
        residual: refreshed.counts.residual,
        truncated: refreshed.truncated === true,
        ledger_incomplete: refreshed.coverage?.ledger !== true,
        recorded_incomplete: refreshed.coverage?.decisions !== true,
        missing: rows,
      };
      document.generatedAt = new Date(now()).toISOString();
      await store.writeStatus(entry.root, document);
    } catch {
      /* the projection is a convenience; failing it must not fail the acceptance */
    }
  };

  /**
   * Measure one root without touching the stored baseline.
   *
   * A review is a look, not a scan: it must not advance the window, otherwise the
   * act of looking would erase the evidence it just found.
   * @param {object} entry - root entry.
   * @returns {Promise<object>} the measurement shaped for callers.
   */
  const review = async (entry) => {
    await load(entry);
    if (entry.catalogState !== 'MANAGED') {
      return { ok: false, catalogState: entry.catalogState, measuredAt: new Date(now()).toISOString() };
    }
    const storedAcks = await store.readAcknowledged(entry.root).catch(() => ({ entries: {}, revision: 0 }));
    const acks = Object.entries(storedAcks.entries).map(([path, value]) => ({ path, ctime: value.ctime }));
    const measured = await measure({ root: entry.root, catalog: entry.catalog, now, acks });
    const reconciliation = measured.reconciliation;
    return {
      ok: true,
      measuredAt: new Date(now()).toISOString(),
      baseline: measured.baseline,
      truncated: reconciliation.truncated === true,
      candidate_limit: CANDIDATE_LIMIT,
      coverage: measured.coverage,
      counts: {
        new_files: reconciliation.new_files,
        recorded_files: reconciliation.recorded_files,
        ledger_files: reconciliation.ledger_files,
        missing: reconciliation.missing.length,
        acknowledged_files: reconciliation.acknowledged_files,
        unknown_files: reconciliation.unknown_files ?? 0,
        missing_total: reconciliation.missing_total,
        residual: reconciliation.residual,
      },
      missing: reconciliation.missing,
      acknowledged: Object.entries(storedAcks.entries).map(([path, value]) => ({ path, at: value.at, ctime: value.ctime })),
      dirs: reconciliation.top_dirs,
    };
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
    // The projection is read through six pages of 400 lines, so a rich entry would
    // blow the card's budget: the card gets path and dir, reviewers go through
    // `fileMaid/review`.
    const reconciliation = entry.reconcile;
    const projected = reconciliation === undefined || reconciliation === null
      ? reconciliation
      : {
          ...reconciliation,
          // `ctime` rides along so the log page can put leases and arrivals on one
          // timeline; `size` and `kind` stay in the review reply, which is where they
          // are read.
          missing: (reconciliation.missing ?? []).map((item) => ({ path: item.path, dir: item.dir, ctime: item.ctime ?? null, acknowledged: item.acknowledged === true })),
        unknown_files: reconciliation.unknown_files ?? 0,
        };
    const document = {
      schemaVersion: '2',
      generatedAt: new Date(now()).toISOString(),
      root: entry.root,
      catalog: {
        state: entry.catalogState,
        hash: entry.catalogHash ?? null,
        rootDefault: catalog?.rootDefault ?? null,
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
      reconcile: projected ?? null,
      routes: routes.map((record) => ({
        at: record.at ?? null,
        name: record.name ?? '',
        dir: record.dir ?? '',
        decided_by: record.decided_by ?? null,
        intent_source: record.intent_source ?? null,
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
    review,
    acknowledge,
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
