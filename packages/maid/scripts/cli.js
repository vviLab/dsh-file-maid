#!/usr/bin/env node
/**
 * Maintenance CLI for one controlled root (`§7.1`).
 *
 * It exercises the same core and state modules the plugin uses, without a DSH
 * session, which makes routing decisions reproducible when a report looks wrong.
 * Every subcommand prints JSON so its output can be diffed.
 *
 * Usage:
 *   node scripts/cli.js route --root <dir> --name <file> [--intent <text>]
 *   node scripts/cli.js scan  --root <dir> [--scope managed|root] [--export json]
 *   node scripts/cli.js review --root <dir>
 *   node scripts/cli.js init  --root <dir> [--mode init|opt_out|defer] [--root-default <dir>]
 *   node scripts/cli.js check
 * @module file-maid/scripts/cli
 */
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { validateCatalog } from '../src/core/catalog.js';
import { decide } from '../src/core/decide.js';
import { measure } from '../src/runtime/measure.js';
import { snapshotFromIndex } from '../src/runtime/scan.js';
import { reconcile } from '../src/core/reconcile.js';
import * as store from '../src/state/store.js';
import * as probe from '../src/state/probe.js';
import { exportDocument, renderReport, reportName } from '../src/surfaces/tools.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Parse `--flag value` pairs.
 * @param {string[]} argv - arguments after the subcommand.
 * @returns {Record<string, string | true>} parsed flags.
 */
function parseFlags(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      flags[key] = true;
    } else {
      flags[key] = next;
      index += 1;
    }
  }
  return flags;
}

/**
 * Resolve the `--root` flag.
 * @param {Record<string, string | true>} flags - parsed flags.
 * @returns {string | undefined} absolute root.
 */
function rootOf(flags) {
  const value = flags.root;
  return typeof value === 'string' ? resolve(value) : undefined;
}

/**
 * Print one JSON value.
 * @param {unknown} value - printable value.
 * @returns {void}
 */
function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Run the `route` subcommand.
 * @param {Record<string, string | true>} flags - parsed flags.
 * @returns {Promise<void>} fulfillment after printing.
 */
async function runRoute(flags) {
  const root = rootOf(flags);
  const name = flags.name;
  if (root === undefined || typeof name !== 'string') {
    throw new Error('route needs --root <dir> and --name <file>');
  }
  const loaded = await store.readCatalog(root);
  if (loaded.state !== 'MANAGED') {
    print({ ok: false, state: loaded.state, errors: loaded.errors, warnings: loaded.warnings });
    process.exitCode = 2;
    return;
  }
  const intent = typeof flags.intent === 'string' ? flags.intent : '';
  const dir = typeof flags.dir === 'string' ? flags.dir : undefined;
  print({ ok: true, state: loaded.state, ...decide({ catalog: loaded.catalog, name, intent, dir }) });
}

/**
 * Run the `scan` subcommand.
 * @param {Record<string, string | true>} flags - parsed flags.
 * @returns {Promise<void>} fulfillment after printing.
 */
async function runScan(flags) {
  const root = rootOf(flags);
  if (root === undefined) throw new Error('scan needs --root <dir>');
  const loaded = await store.readCatalog(root);
  if (loaded.state !== 'MANAGED') {
    print({ ok: false, state: loaded.state, errors: loaded.errors });
    process.exitCode = 2;
    return;
  }
  const scope = flags.scope === 'root' ? 'root' : 'managed';
  let files = 0;
  let dirs = 0;
  let outcome = { files: 0, dirs: 0, elapsed: 0 };
  if (scope === 'root') {
    const section = await probe.scanTree(root, { maxFiles: probe.SCAN_FILE_BUDGET });
    if (section.truncated) {
      print({ ok: false, code: 'E_MAID_TOO_LARGE', files: section.files, suggestion: 'scope: managed' });
      process.exitCode = 2;
      return;
    }
    files = section.files;
    dirs = section.dirs;
  } else {
    // Same measurement the plugin runs: one implementation, so the CLI report and
    // the card cannot disagree about what counts as an unaccounted file.
    const measured = await measure({ root, catalog: loaded.catalog });
    files = measured.result.files;
    dirs = measured.result.dirs;
    outcome = {
      files,
      dirs,
      elapsed: measured.result.elapsed,
      baseline: measured.baseline,
      reconcile: measured.result ? measured.reconciliation : undefined,
      candidates: measured.result.candidates,
    };
  }
  const name = reportName(Date.now());
  await store.writeReport(root, name, renderReport({ root, scope, outcome: { ...outcome, files, dirs }, catalog: loaded.catalog }));
  let exported = null;
  if (flags.export === 'json') {
    const jsonName = name.replace(/\.md$/u, '.json');
    await store.writeScanExport(root, jsonName, exportDocument({ root, outcome: { ...outcome, files, dirs } }));
    exported = `.maid/reports/${jsonName}`;
  }
  print({ ok: true, state: loaded.state, scope, files, dirs, report: `.maid/reports/${name}`, export: exported });
}

/**
 * Run the `migrate` subcommand: rewrite a v3 catalog into the v5 schema.
 *
 * The two schemas differ in where routing lives (top-level `rules`) and in what
 * a directory carries (`includes`/`excludes` instead of `about`/`keywords`).
 * The old file is copied to `catalog.yml.v3.bak` before the rewrite, and the
 * rewrite goes through the same validator the plugin uses.
 * @param {Record<string, string | true>} flags - parsed flags.
 * @returns {Promise<void>} fulfillment after printing.
 */
async function runMigrate(flags) {
  const root = rootOf(flags);
  if (root === undefined) throw new Error('migrate needs --root <dir>');
  const source = await store.readText(join(root, '.maid', store.FILES.catalog));
  if (source === undefined) {
    print({ ok: false, code: 'E_MAID_UNINITIALIZED', message: 'catalog.yml does not exist' });
    process.exitCode = 2;
    return;
  }
  const document = YAML.parse(source);
  const oldDirs = Array.isArray(document?.dirs) ? document.dirs : [];
  const dirs = oldDirs.map((dir) => ({
    path: dir.path,
    purpose: dir.purpose ?? '',
    includes: Array.isArray(dir.includes) ? dir.includes : Array.isArray(dir.keywords) ? dir.keywords : [],
    excludes: Array.isArray(dir.excludes) ? dir.excludes : [],
    examples: Array.isArray(dir.examples) ? dir.examples : [],
  }));
  const oldRules = Array.isArray(document?.routing?.rules) ? document.routing.rules : [];
  const rules = (Array.isArray(document?.rules) ? document.rules : oldRules).map((rule) => ({ match: rule.match, dir: rule.dir }));
  const verdict = validateCatalog({ version: 1, root_default: document?.root_default, dirs, rules });
  if (!verdict.ok) {
    print({ ok: false, code: 'E_MAID_SCHEMA', errors: verdict.errors });
    process.exitCode = 2;
    return;
  }
  await probe.writeFileAtomic(join(root, '.maid', 'catalog.yml.v3.bak'), source, { mode: 0o600 });
  await store.writeCatalog(root, store.serializeCatalog(verdict.catalog, { root }));
  print({ ok: true, dirs: verdict.catalog.dirs.length, rules: verdict.catalog.rules.length, warnings: verdict.warnings, backup: '.maid/catalog.yml.v3.bak' });
}

/**
 * Run the `init` subcommand.
 * @param {Record<string, string | true>} flags - parsed flags.
 * @returns {Promise<void>} fulfillment after printing.
 */
async function runInit(flags) {
  const root = rootOf(flags);
  if (root === undefined) throw new Error('init needs --root <dir>');
  const mode = flags.mode === 'opt_out' || flags.mode === 'defer' ? flags.mode : 'init';
  if (mode === 'defer') {
    print({ ok: true, mode, persisted: false });
    return;
  }
  if (mode === 'opt_out') {
    await store.writeOptOut(root);
    print({ ok: true, mode, persisted: true });
    return;
  }
  const existing = await store.listRootDirectories(root);
  const built = store.templateCatalog({ directories: existing });
  if (built.error !== undefined) {
    print({ ok: false, code: built.error.code, message: built.error.message });
    process.exitCode = 2;
    return;
  }
  const requested = typeof flags['root-default'] === 'string' ? flags['root-default'] : undefined;
  if (requested !== undefined) {
    const match = built.catalog.dirs.find((dir) => dir.path === requested);
    if (match === undefined) {
      print({ ok: false, code: 'E_MAID_SCHEMA', message: `root_default is not a declared directory: ${requested}` });
      process.exitCode = 2;
      return;
    }
    built.catalog.rootDefault = match.path;
  }
  const serialized = store.serializeCatalog(built.catalog, { root });
  const previous = await store.readText(join(root, '.maid', store.FILES.catalog));
  if (previous !== undefined && previous !== serialized) {
    print({ ok: false, code: 'E_MAID_EXISTS', message: 'catalog.yml already exists with different content' });
    process.exitCode = 2;
    return;
  }
  await store.writeCatalog(root, serialized);
  print({ ok: true, mode, root_default: built.catalog.rootDefault, source: built.source, dirs: built.catalog.dirs.length, catalog: '.maid/catalog.yml' });
}

/**
 * Run the `check` subcommand by delegating to the manifest script.
 * @returns {void}
 */
function runCheck() {
  const result = spawnSync(process.execPath, [join(here, 'check-manifest.js')], { stdio: 'inherit' });
  process.exitCode = result.status ?? 1;
}

/**
 * CLI entry.
 * @returns {Promise<void>} fulfillment when the subcommand finished.
 */
/**
 * Review one root without advancing the baseline (`§4`): prints the leak list
 * with the rich fields a reviewer needs, and writes nothing.
 * @param {object} flags - parsed CLI flags.
 * @returns {Promise<void>} fulfillment after printing.
 */
async function runReview(flags) {
  const root = typeof flags.root === 'string' ? resolve(flags.root) : undefined;
  if (root === undefined) throw new Error('review needs --root <dir>');
  const loaded = await store.readCatalog(root);
  if (loaded.state !== 'MANAGED') {
    print({ ok: false, state: loaded.state, errors: loaded.errors });
    process.exitCode = 2;
    return;
  }
  const measured = await measure({ root, catalog: loaded.catalog });
  const reconciliation = measured.reconciliation;
  print({
    ok: true,
    state: loaded.state,
    root,
    measuredAt: new Date().toISOString(),
    baseline: measured.baseline,
    truncated: reconciliation.truncated === true,
    coverage: measured.coverage,
    counts: {
      new_files: reconciliation.new_files,
      recorded_files: reconciliation.recorded_files,
      ledger_files: reconciliation.ledger_files,
      missing: reconciliation.missing.length,
      residual: reconciliation.residual,
    },
    missing: reconciliation.missing,
  });
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  switch (command) {
    case 'route':
      return runRoute(flags);
    case 'scan':
      return runScan(flags);
    case 'review':
      return runReview(flags);
    case 'init':
      return runInit(flags);
    case 'migrate':
      return runMigrate(flags);
    case 'check':
      return runCheck();
    default:
      console.error('usage: cli.js <route|scan|review|init|migrate|check> --root <dir> [...]');
      process.exitCode = 64;
      return undefined;
  }
}

main().catch((error) => {
  console.error(`cli: ${error?.message ?? error}`);
  process.exitCode = 1;
});
