/**
 * One measurement of a controlled root (`§4` of the leak-review plan).
 *
 * A measurement walks the declared directories, reads both channel windows, and
 * reconciles them. It never writes: persisting the baseline is a separate step
 * taken by `roots.scan()`, so a caller can look at the leak list without
 * advancing the window and destroying the evidence it just found.
 * @module file-maid/runtime/measure
 */
import { ackSet } from '../core/ack.js';
import { reconcile } from '../core/reconcile.js';
import * as store from '../state/store.js';
import { scanManaged, snapshotFromIndex, snapshotOf } from './scan.js';
import { readWindow } from './window.js';

/**
 * Measure one root against its stored baseline.
 * @param {{ root: string, catalog: object, now?: () => number, acks?: Array<{ path: string, ctime: number }> }} input - measurement inputs; `acks` is the stored acknowledgement list, turned into keys here.
 * @returns {Promise<{ ok: boolean, catalogState?: string, baseline: boolean, windowStart: string | undefined, result?: object, snapshot?: object, reconciliation?: object }>} the measurement; `ok: false` carries the catalog state that blocked it.
 */
export async function measure(input) {
  const now = input.now ?? Date.now;
  let stored;
  try {
    stored = (await store.readIndex(input.root)).index;
  } catch {
    stored = undefined;
  }
  const before = snapshotFromIndex(stored);
  const windowStart = stored?.generatedAt;
  const floor = windowStart === undefined ? undefined : Date.parse(windowStart);
  const result = await scanManaged({
    root: input.root,
    catalog: input.catalog,
    now,
    since: Number.isFinite(floor) ? floor : undefined,
  });
  const snapshot = snapshotOf(result);
  const decisionsWindow = await readWindow(input.root, 'decisions', windowStart);
  const ledgerWindow = await readWindow(input.root, 'writes', windowStart);
  // The ledger only covers the window when its own first record is older than
  // the window start; a reborn or rotated ledger cannot name what it missed.
  const reconciliation = reconcile({
    before,
    after: snapshot,
    recorded: decisionsWindow.count,
    ledger: ledgerWindow.count,
    recordedPaths: decisionsWindow.paths,
    ledgerPaths: ledgerWindow.paths,
    candidates: result.candidates,
    truncated: result.candidatesTruncated,
    ledgerIncomplete: !ledgerWindow.covered,
    decisionsIncomplete: !decisionsWindow.covered,
    acknowledged: ackSet(input.acks),
  });
  return {
    ok: true,
    baseline: before === undefined,
    windowStart,
    result,
    snapshot,
    reconciliation,
    coverage: { decisions: decisionsWindow.covered, ledger: ledgerWindow.covered },
  };
}

/**
 * Measure a root that has no catalog table yet.
 * @param {string} catalogState - the state that blocked the scan.
 * @param {() => number} now - clock.
 * @param {string} [reason] - why the measurement ran.
 * @returns {object} the blocked measurement, shaped like a successful one.
 */
export function blockedMeasurement(catalogState, now, reason) {
  return {
    ok: false,
    catalogState,
    reason,
    baseline: false,
    scope: 'managed',
    files: 0,
    dirs: 0,
    elapsed: 0,
    degraded: false,
    reconcile: undefined,
  };
}
