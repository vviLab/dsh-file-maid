/**
 * Setting up a root that has no catalog yet (`M-30`…`M-47`).
 *
 * The card adds folders one at a time; the host validates every row against the
 * filesystem before the table is written, because a wrong path here would either
 * fail the next load or grow an empty folder on the first write.
 * @module file-maid/test/init
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createManageSurface } from '../src/surfaces/manage.js';
import * as store from '../src/state/store.js';

/**
 * Build an empty root plus the session that owns it.
 * @param {object} [options] - `readOnly` flips the permission stub.
 * @returns {Promise<object>} fixtures.
 */
async function bareRoot(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'maid-init-'));
  const sessionId = 'session-init';
  const session = { header: { cwd: root } };
  const ctx = {
    sessions: { get: (id) => (id === sessionId ? session : undefined) },
    get(name) {
      if (name !== 'permissionPresets') return undefined;
      return options.readOnly === true
        ? { current: () => 'read-only', resolve: () => ({ sandbox: 'read-only' }) }
        : { current: () => 'workspace-write', resolve: () => ({ sandbox: 'workspace-write' }) };
    },
  };
  const scans = [];
  const reloads = [];
  const roots = {
    scanRoot: async (target) => {
      scans.push(target);
      return { files: 3, dirs: 1, elapsed: 7, degraded: false, baseline: true };
    },
    reloadRoot: async (target) => {
      reloads.push(target);
      return 1;
    },
    projectRoot: async () => {},
  };
  const surface = createManageSurface({ ctx, roots });
  return { root, sessionId, ctx, surface, scans, reloads };
}

/**
 * Write one payload the way the card does.
 * @param {object} surface - the manage surface.
 * @param {string} root - controlled root.
 * @param {string} sessionId - session id.
 * @param {object} body - payload object.
 * @returns {Promise<object>} the result.
 */
function save(surface, root, sessionId, body) {
  return surface.service.save(root, sessionId, JSON.stringify(body));
}

test('M-30 draft describes each kind of bad path', async (t) => {
  const { root, sessionId, surface } = await bareRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '30-Media'));
  await writeFile(join(root, 'note.txt'), 'x');

  const missing = await surface.service.draft(root, sessionId, '80-Outputs');
  assert.equal(missing.value.path.kind, 'absent');
  assert.match(missing.value.path.problem, /不在磁盘上/u);

  const file = await surface.service.draft(root, sessionId, 'note.txt');
  assert.equal(file.value.path.kind, 'file');
  assert.match(file.value.path.problem, /不是文件夹/u);

  const reserved = await surface.service.draft(root, sessionId, '.maid');
  assert.match(reserved.value.path.problem, /保留目录/u);

  const deep = await surface.service.draft(root, sessionId, 'a/b/c/d');
  assert.match(deep.value.path.problem, /最多 3 段/u);

  const dir = await surface.service.draft(root, sessionId, '30-Media');
  assert.equal(dir.value.path.kind, 'dir');
  assert.equal(dir.value.path.problem, null);
});

test('M-31 canInit is true only without a table or with a blank one', async (t) => {
  const { root, sessionId, surface } = await bareRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const empty = await surface.service.draft(root, sessionId, '');
  assert.equal(empty.value.state, 'UNINITIALIZED');
  assert.equal(empty.value.canInit, true);

  await mkdir(join(root, '.maid'), { recursive: true });
  await writeFile(join(root, '.maid', 'catalog.yml'), '# only a comment\n');
  const blank = await surface.service.draft(root, sessionId, '');
  assert.equal(blank.value.state, 'ERROR');
  assert.equal(blank.value.canInit, true);

  await writeFile(join(root, '.maid', 'catalog.yml'), 'version: 1\n');
  const broken = await surface.service.draft(root, sessionId, '');
  assert.equal(broken.value.canInit, false);
});

test('M-32 draft reports a symlink anywhere on the path', async (t) => {
  const { root, sessionId, surface } = await bareRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'real', 'inner'), { recursive: true });
  await symlink(join(root, 'real'), join(root, 'alias'));
  const result = await surface.service.draft(root, sessionId, 'alias/inner');
  assert.equal(result.value.path.kind, 'link');
  assert.match(result.value.path.problem, /符号链接/u);
});

test('M-33 init refuses an empty list and a list over the cap', async (t) => {
  const { root, sessionId, surface } = await bareRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const empty = await save(surface, root, sessionId, { op: 'init', dirs: [], rootDefault: '' });
  assert.equal(empty.errors[0].code, 'E_MAID_SCHEMA');

  const many = Array.from({ length: 65 }, (_, index) => ({ path: `d${index}`, purpose: 'x' }));
  const over = await save(surface, root, sessionId, { op: 'init', dirs: many, rootDefault: 'd0' });
  assert.equal(over.errors[0].code, 'E_MAID_SCHEMA');
});

test('M-34 init refuses a folder that is not on disk', async (t) => {
  const { root, sessionId, surface } = await bareRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await save(surface, root, sessionId, {
    op: 'init',
    dirs: [{ path: '80-Outputs', purpose: '导出件' }],
    rootDefault: '80-Outputs',
  });
  assert.equal(result.errors[0].code, 'E_MAID_PATH');
  assert.equal(result.errors[0].path, '80-Outputs');
});

test('M-35 init refuses a row without a purpose', async (t) => {
  const { root, sessionId, surface } = await bareRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '80-Outputs'));
  const result = await save(surface, root, sessionId, {
    op: 'init',
    dirs: [{ path: '80-Outputs', purpose: '   ' }],
    rootDefault: '80-Outputs',
  });
  assert.equal(result.errors[0].code, 'E_MAID_PURPOSE_MISSING');
});

test('M-36 two spellings of one folder are one row', async (t) => {
  const { root, sessionId, surface } = await bareRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '80-Outputs'));
  const result = await save(surface, root, sessionId, {
    op: 'init',
    dirs: [
      { path: '80-Outputs', purpose: '导出件' },
      { path: '80-Outputs/', purpose: '导出件' },
    ],
    rootDefault: '80-Outputs',
  });
  assert.equal(result.errors[0].code, 'E_MAID_DUPLICATE');
});

test('M-37 the default folder must be one of the listed rows', async (t) => {
  const { root, sessionId, surface } = await bareRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '80-Outputs'));
  const result = await save(surface, root, sessionId, {
    op: 'init',
    dirs: [{ path: '80-Outputs', purpose: '导出件' }],
    rootDefault: '99-Nowhere',
  });
  assert.equal(result.errors[0].code, 'E_MAID_DEFAULT_MISSING');
});

test('M-38 init writes the table, scans, reloads and audits', async (t) => {
  const { root, sessionId, surface, scans, reloads } = await bareRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '00-Specs'));
  await mkdir(join(root, '80-Outputs'));
  const result = await save(surface, root, sessionId, {
    op: 'init',
    dirs: [
      { path: '00-Specs', purpose: '规范与标准', excludes: '日志' },
      { path: '80-Outputs', purpose: '导出件' },
    ],
    rootDefault: '80-Outputs',
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.value.state, 'MANAGED');
  assert.deepEqual(scans, [root]);
  assert.deepEqual(reloads, [root]);
  assert.deepEqual(result.value.scan, { files: 3, dirs: 1, elapsed: 7, degraded: false, baseline: true });

  const loaded = await store.readCatalog(root);
  assert.equal(loaded.state, 'MANAGED');
  assert.equal(loaded.catalog.rootDefault, '80-Outputs');
  assert.equal(loaded.catalog.dirs.length, 2);

  const info = await stat(join(root, '.maid', 'catalog.yml'));
  assert.equal(info.mode & 0o777, 0o600);
  const audit = await readFile(join(root, '.maid', 'audit.jsonl'), 'utf8');
  assert.match(audit, /"op":"init"/u);
  assert.match(audit, /"dirs":2/u);
});

test('M-39 an existing table is refused and left untouched', async (t) => {
  const { root, sessionId, surface } = await bareRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '80-Outputs'));
  const first = await save(surface, root, sessionId, {
    op: 'init',
    dirs: [{ path: '80-Outputs', purpose: '导出件' }],
    rootDefault: '80-Outputs',
  });
  assert.equal(first.ok, true);
  const before = await readFile(join(root, '.maid', 'catalog.yml'), 'utf8');
  const again = await save(surface, root, sessionId, {
    op: 'init',
    dirs: [{ path: '80-Outputs', purpose: '另一个用途' }],
    rootDefault: '80-Outputs',
  });
  assert.equal(again.errors[0].code, 'E_MAID_EXISTS');
  assert.equal(await readFile(join(root, '.maid', 'catalog.yml'), 'utf8'), before);
});

test('M-40 a blank table is replaced and the previous hash is recorded', async (t) => {
  const { root, sessionId, surface } = await bareRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.maid'), { recursive: true });
  await writeFile(join(root, '.maid', 'catalog.yml'), '');
  await mkdir(join(root, '80-Outputs'));
  const result = await save(surface, root, sessionId, {
    op: 'init',
    dirs: [{ path: '80-Outputs', purpose: '导出件' }],
    rootDefault: '80-Outputs',
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  const audit = await readFile(join(root, '.maid', 'audit.jsonl'), 'utf8');
  assert.match(audit, /"previousHash":"sha256:/u);
});

test('M-41 an opted-out root refuses setup', async (t) => {
  const { root, sessionId, surface } = await bareRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.maid'), { recursive: true });
  await writeFile(join(root, '.maid', 'opt-out'), '');
  await mkdir(join(root, '80-Outputs'));
  const result = await save(surface, root, sessionId, {
    op: 'init',
    dirs: [{ path: '80-Outputs', purpose: '导出件' }],
    rootDefault: '80-Outputs',
  });
  assert.equal(result.errors[0].code, 'E_MAID_OPT_OUT');
});

test('M-42 a read-only session writes nothing', async (t) => {
  const { root, sessionId, surface } = await bareRoot({ readOnly: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '80-Outputs'));
  const draft = await surface.service.draft(root, sessionId, '80-Outputs');
  assert.equal(draft.value.canWrite, false);
  const result = await save(surface, root, sessionId, {
    op: 'init',
    dirs: [{ path: '80-Outputs', purpose: '导出件' }],
    rootDefault: '80-Outputs',
  });
  assert.equal(result.errors[0].code, 'E_MAID_READONLY');
  const loaded = await store.readCatalog(root);
  assert.equal(loaded.state, 'UNINITIALIZED');
});

test('M-43 two concurrent setups of one root produce one table', async (t) => {
  const { root, sessionId, surface } = await bareRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '80-Outputs'));
  const body = { op: 'init', dirs: [{ path: '80-Outputs', purpose: '导出件' }], rootDefault: '80-Outputs' };
  const [first, second] = await Promise.all([
    save(surface, root, sessionId, body),
    save(surface, root, sessionId, body),
  ]);
  const codes = [first, second].map((item) => (item.ok === true ? 'ok' : item.errors[0].code)).sort();
  assert.deepEqual(codes, ['E_MAID_EXISTS', 'ok']);
});

test('M-44 paths are normalised before they are checked', async (t) => {
  const { root, sessionId, surface } = await bareRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '80-Outputs'));
  const slashed = await surface.service.draft(root, sessionId, '  80-Outputs/  ');
  assert.equal(slashed.value.path.kind, 'dir');
  assert.equal(slashed.value.path.relative, '80-Outputs');
  const backslashed = await surface.service.draft(root, sessionId, '80-Outputs\\');
  assert.equal(backslashed.value.path.kind, 'dir');
});

test('M-45 a blank table still reads as ERROR, not as a new state', async (t) => {
  const { root } = await bareRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.maid'), { recursive: true });
  await writeFile(join(root, '.maid', 'catalog.yml'), '# nothing here\n');
  const loaded = await store.readCatalog(root);
  assert.equal(loaded.state, 'ERROR');
  assert.equal(loaded.blank, true);
});
