#!/usr/bin/env node
/**
 * Manifest self-check (`§14.2`, `X-11`).
 *
 * The plugin manager's preflight skips a bundle whose manifest cannot be read,
 * which looks identical to "the plugin is not installed". This script turns
 * that silent skip into a failing command with a reason. It also enforces the
 * two structural rules the plan depends on: no `@deepseek-ai/*` runtime import
 * (a `link:` install cannot resolve host packages) and no `node:fs` inside
 * `src/core`.
 *
 * Usage: node scripts/check-manifest.js [package-dir]
 * @module file-maid/scripts/check-manifest
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as YAML from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(process.argv[2] ?? join(here, '..'));

const failures = [];
const notes = [];

/**
 * Record one failing assertion.
 * @param {string} message - what failed.
 * @returns {void}
 */
function fail(message) {
  failures.push(message);
}

/**
 * Assert one condition.
 * @param {boolean} condition - the check.
 * @param {string} message - failure text.
 * @returns {void}
 */
function assert(condition, message) {
  if (!condition) fail(message);
}

/**
 * Read one file as text.
 * @param {string} path - absolute path.
 * @returns {string} content.
 */
function read(path) {
  return readFileSync(path, 'utf8');
}

const manifestPath = join(packageDir, 'package.json');
assert(existsSync(manifestPath), `package.json not found in ${packageDir}`);

let manifest;
if (existsSync(manifestPath)) {
  try {
    manifest = JSON.parse(read(manifestPath));
  } catch (error) {
    fail(`package.json is not valid JSON: ${error.message}`);
  }
}

if (manifest !== undefined) {
  assert(manifest.name === 'dsh-file-maid', `package.json name must be dsh-file-maid, found ${String(manifest.name)}`);
  assert(manifest.type === 'module', 'package.json type must be module');
  assert(typeof manifest.version === 'string' && manifest.version.length > 0, 'package.json version is missing');

  const dshRange = manifest.engines?.dsh;
  assert(typeof dshRange === 'string' && dshRange.length > 0, 'engines.dsh is missing: the plugin manager cannot place the bundle');
  if (typeof dshRange === 'string') {
    assert(dshRange.includes('>=0.2.2-alpha.2'), `engines.dsh must accept the current prerelease; found ${dshRange}`);
    assert(dshRange.includes('<0.3.0'), `engines.dsh must cap the minor line with <0.3.0; found ${dshRange}`);
  }

  const scripts = manifest.scripts ?? {};
  for (const forbidden of ['prepare', 'preinstall', 'postinstall', 'prepublishOnly']) {
    assert(scripts[forbidden] === undefined, `scripts.${forbidden} must not exist: an install hook runs arbitrary code before the bundle is reviewed`);
  }

  const patchRelative = manifest.dsh?.bundle?.patch;
  assert(typeof patchRelative === 'string' && patchRelative.length > 0, 'dsh.bundle.patch is missing');
  if (typeof patchRelative === 'string') {
    const patchPath = join(packageDir, patchRelative);
    assert(existsSync(patchPath), `dsh.bundle.patch points at a missing file: ${patchRelative}`);
    if (existsSync(patchPath)) {
      try {
        const parsed = YAML.parse(read(patchPath));
        const rows = Array.isArray(parsed)
          ? parsed.flatMap((block) => (Array.isArray(block?.insert) ? block.insert : []))
          : [];
        assert(rows.length > 0, 'cordis.patch.yml must insert at least one row');
        assert(
          rows.some((row) => row?.name === manifest.name),
          `cordis.patch.yml must reference ${manifest.name}; found ${rows.map((row) => row?.name).join(', ') || 'none'}`,
        );
        for (const row of rows) {
          assert(typeof row?.id === 'string' && row.id.length > 0, 'every inserted row needs an id');
        }
      } catch (error) {
        fail(`cordis.patch.yml is not valid YAML: ${error.message}`);
      }
    }
  }

  const entry = manifest.exports?.['.'];
  const entryPath = typeof entry === 'string' ? entry : entry?.default;
  assert(typeof entryPath === 'string' && entryPath.length > 0, 'exports["."] must name a file');
  if (typeof entryPath === 'string') {
    assert(existsSync(join(packageDir, entryPath)), `exports["."] points at a missing file: ${entryPath}`);
  }

  const client = manifest.dsh?.client;
  if (client !== undefined) {
    assert(client.platform === 'web', `dsh.client.platform must be web; found ${String(client.platform)}`);
    assert(typeof client.immediately === 'boolean', 'dsh.client.immediately must be a boolean when present');
    if (client.inject !== undefined) {
      assert(Array.isArray(client.inject) && client.inject.every((item) => typeof item === 'string'), 'dsh.client.inject must be a string array');
    }
    if (client.external !== undefined) {
      assert(Array.isArray(client.external) && client.external.every((item) => typeof item === 'string'), 'dsh.client.external must be a string array');
    }
    const clientEntry = manifest.exports?.['./client'];
    assert(typeof clientEntry === 'string' && clientEntry.length > 0, 'dsh.client requires exports["./client"]');
    if (typeof clientEntry === 'string') {
      const clientPath = join(packageDir, clientEntry);
      assert(existsSync(clientPath), `exports["./client"] points at a missing file: ${clientEntry}`);
      if (existsSync(clientPath)) {
        const body = read(clientPath);
        assert(
          /window\.__ModuleLoader__\s*\.\s*load\s*\(/u.test(body),
          `${clientEntry} must register through window.__ModuleLoader__.load(...)`,
        );
        assert(
          new RegExp(`id:\\s*['"]${manifest.name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}['"]`, 'u').test(body),
          `${clientEntry} must register the module id "${manifest.name}"`,
        );
        assert(!/^\s*(import|export)\s/mu.test(body), `${clientEntry} must be a classic script: no import/export statements`);
        // The shared UI kit is the one host package a bundle may require: the module
        // loader resolves it, and shipped plugins (dsh-im-connect) do the same. Anything
        // else must stay out, because a link: install resolves from the real directory.
        const allowedRequires = new Set(['@deepseek-ai/dsh-client-ui-primitives']);
        const required = [...body.matchAll(/require\(\s*['"](@deepseek-ai\/[^'"]+)['"]/gu)].map((match) => match[1]);
        assert(
          required.every((id) => allowedRequires.has(id)),
          `${clientEntry} may only require ${[...allowedRequires].join(', ')} from the host, got ${required.join(', ')}`,
        );
        notes.push(`${clientEntry}: module id and classic-script form verified`);
      }
    }
  }

  for (const item of manifest.files ?? []) {
    assert(existsSync(join(packageDir, item)), `files[] entry is missing on disk: ${item}`);
  }
  notes.push(`files[] entries present: ${(manifest.files ?? []).length}`);
}

const required = [
  'src/plugin.js',
  'src/core/catalog.js',
  'src/core/decide.js',
  'src/core/text.js',
  'src/core/reconcile.js',
  'src/core/path.js',
  'src/state/store.js',
  'src/state/probe.js',
  'src/runtime/roots.js',
  'src/runtime/scan.js',
  'src/runtime/place.js',
  'src/runtime/permissions.js',
  'src/surfaces/prompt.js',
  'src/surfaces/fs-policy.js',
  'src/surfaces/manage.js',
  'src/surfaces/tools.js',
  'src/client.js',
  'scripts/cli.js',
  'scripts/check-manifest.js',
  'README.md',
  'icon.svg',
  'locale/zh.json',
  'locale/en.json',
];
for (const item of required) assert(existsSync(join(packageDir, item)), `required file is missing: ${item}`);

/**
 * Walk one directory tree.
 * @param {string} directory - absolute directory.
 * @returns {string[]} file paths.
 */
function walk(directory) {
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...walk(path));
    else if (entry.isFile() && path.endsWith('.js')) found.push(path);
  }
  return found;
}

const sourceFiles = existsSync(join(packageDir, 'src')) ? walk(join(packageDir, 'src')) : [];
for (const file of sourceFiles) {
  const body = read(file);
  const relative = file.slice(packageDir.length + 1);
  if (/from\s+['"]@deepseek-ai\//u.test(body) || /import\(\s*['"]@deepseek-ai\//u.test(body)) {
    if (!/import\(\s*['"]@deepseek-ai\/dsh-atomic-write/u.test(body)) {
      fail(`${relative} imports an @deepseek-ai/* package; a link: install cannot resolve host packages`);
    } else {
      notes.push(`${relative} probes @deepseek-ai/dsh-atomic-write dynamically (allowed)`);
    }
  }
  if (relative.startsWith('src/core/') && /from\s+['"]node:fs|import\(\s*['"]node:fs/u.test(body)) {
    fail(`${relative} imports node:fs; src/core must stay pure`);
  }
}

notes.push(`scanned ${sourceFiles.length} source files`);
notes.push(`engines.dsh: ${manifest?.engines?.dsh ?? 'missing'}`);

if (failures.length > 0) {
  console.error(`check-manifest: ${failures.length} failure(s) in ${packageDir}`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`check-manifest: OK (${packageDir})`);
for (const note of notes) console.log(`  - ${note}`);
