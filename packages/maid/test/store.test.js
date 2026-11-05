/**
 * Persistence (`§13.5` P-01..P-06) and the state derived from `AGENTS.md`.
 * @module file-maid/test/store
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import * as store from '../src/state/store.js';

/**
 * Create a disposable controlled root.
 * @returns {Promise<string>} absolute root path.
 */
async function makeRoot() {
  return mkdtemp(join(tmpdir(), 'maid-store-'));
}

const AGENTS_MD = `# 工作区

| 目录 | 策略 | 用途 |
| --- | --- | --- |
| \`00-Specs\` | MANAGED | 通用规范文件 |
| \`10-Projects\` | AUTONOMOUS | 进行中的项目 |
| \`70-Downloads\` | EXTERNAL_LINK | 系统下载目录入口 |
| \`80-Outputs\` | MANAGED | 非项目输出物的默认落点 |

默认落点：\`80-Outputs\`
`;

test('an absent .maid reports UNINITIALIZED', async (t) => {
  const root = await makeRoot();
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  const loaded = await store.readCatalog(root);
  assert.equal(loaded.state, 'UNINITIALIZED');
});

test('V-06 invalid YAML reports E_MAID_YAML with a position', async (t) => {
  const root = await makeRoot();
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  await mkdir(join(root, '.maid'), { recursive: true });
  await writeFile(join(root, '.maid', 'catalog.yml'), 'version: 1\ndirs: [\n');
  const loaded = await store.readCatalog(root);
  assert.equal(loaded.state, 'ERROR');
  assert.equal(loaded.errors[0].code, 'E_MAID_YAML');
  assert.ok(typeof loaded.errors[0].at === 'string');
});

test('an opt-out marker wins over a valid catalog', async (t) => {
  const root = await makeRoot();
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  const { validCatalog } = await import('./helpers.js');
  const catalog = validCatalog();
  await store.writeCatalog(root, store.serializeCatalog(catalog, { root }));
  await store.writeOptOut(root);
  const loaded = await store.readCatalog(root);
  assert.equal(loaded.state, 'NOT_MANAGED');
});

test('S-01 and P-02 enforce 0700 / 0600', async (t) => {
  const root = await makeRoot();
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  await store.writeIndex(root, { schemaVersion: '1', baseline: true });
  const dirMode = (await stat(join(root, '.maid'))).mode & 0o777;
  const fileMode = (await stat(join(root, '.maid', 'index.json'))).mode & 0o777;
  assert.equal(dirMode, 0o700);
  assert.equal(fileMode, 0o600);
});

test('S-03 rotation keeps ten rotated files and starts a new base', async (t) => {
  const root = await makeRoot();
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  const chunk = 'x'.repeat(64 * 1024);
  for (let index = 0; index < 24; index += 1) {
    await store.appendLog(root, 'audit', { action: 'bulk', payload: chunk });
  }
  const names = (await readdir(join(root, '.maid'))).filter((name) => name.startsWith('audit.') && name.endsWith('.jsonl'));
  assert.ok(names.length <= store.LOG_FILES_KEPT, `expected at most ${store.LOG_FILES_KEPT} rotated files, found ${names.length}`);
  assert.ok(names.includes('audit.1.jsonl'));
  const base = await readFile(join(root, '.maid', 'audit.jsonl'), 'utf8');
  assert.ok(base.length < store.LOG_BYTES_LIMIT);
});

test('S-04 reports are pruned to thirty and the deletion is audited', async (t) => {
  const root = await makeRoot();
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  await mkdir(join(root, '.maid', 'reports'), { recursive: true });
  const base = Date.now();
  for (let index = 0; index < 33; index += 1) {
    const stamp = new Date(base - index * 60 * 1000);
    const pad = (value) => String(value).padStart(2, '0');
    const name = `scan-${stamp.getUTCFullYear()}${pad(stamp.getUTCMonth() + 1)}${pad(stamp.getUTCDate())}-${pad(stamp.getUTCHours())}${pad(stamp.getUTCMinutes())}${pad(stamp.getUTCSeconds())}.md`;
    await writeFile(join(root, '.maid', 'reports', name), '# scan\n');
  }
  const pruned = await store.pruneReports(root);
  assert.equal(pruned.length, 3);
  const remaining = (await readdir(join(root, '.maid', 'reports'))).filter((name) => name.endsWith('.md'));
  assert.equal(remaining.length, store.REPORT_FILES_KEPT);
});

test('S-05 a corrupt index.json is quarantined', async (t) => {
  const root = await makeRoot();
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  await mkdir(join(root, '.maid'), { recursive: true });
  await writeFile(join(root, '.maid', 'index.json'), '{ not json');
  const loaded = await store.readIndex(root);
  assert.equal(loaded.index, undefined);
  assert.equal(loaded.warning.code, 'E_MAID_INDEX_CORRUPT');
  const names = await readdir(join(root, '.maid'));
  assert.ok(names.some((name) => name.startsWith('index.json.corrupt-')));
});

test('a catalog round-trips through YAML and json', async (t) => {
  const root = await makeRoot();
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  const { validCatalog } = await import('./helpers.js');
  const catalog = validCatalog();
  await store.writeCatalog(root, store.serializeCatalog(catalog, { root }));
  const loaded = await store.readCatalog(root);
  assert.equal(loaded.state, 'MANAGED', JSON.stringify(loaded.errors));
  assert.equal(loaded.catalog.rootDefault, '80-Outputs');
  assert.deepEqual(loaded.catalog.dirs.map((dir) => dir.path), ['00-Specs', '10-Projects', '30-Media', '80-Outputs']);
  assert.ok(loaded.hash.startsWith('sha256:'));
});

test('an unknown catalog key is a warning, not a failure', async (t) => {
  const root = await makeRoot();
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  const { validCatalog } = await import('./helpers.js');
  const text = `${store.serializeCatalog(validCatalog(), { root })}surprise: true\n`;
  await store.writeCatalog(root, text);
  const loaded = await store.readCatalog(root);
  assert.equal(loaded.state, 'MANAGED');
  assert.ok(loaded.warnings.some((warning) => warning.code === 'E_MAID_UNKNOWN_KEY'));
});

test('S-12 a refusal sentence survives the YAML round-trip as one sentence', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maid-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const catalog = {
    rootDefault: '80-Outputs',
    dirs: [
      { path: '00-Specs', purpose: '工作区通用规范文件', excludes: '草稿与临时文件', examples: [], index: 0 },
      { path: '80-Outputs', purpose: '非项目输出物的默认落点', excludes: '', examples: [], index: 1 },
    ],
    rules: [],
  };
  await store.writeCatalog(root, store.serializeCatalog(catalog, { root }));
  const text = await readFile(join(root, '.maid', 'catalog.yml'), 'utf8');
  assert.match(text, /excludes: 草稿与临时文件/u);
  const loaded = await store.readCatalog(root);
  assert.equal(loaded.catalog.dirs[0].excludes, '草稿与临时文件');
});
