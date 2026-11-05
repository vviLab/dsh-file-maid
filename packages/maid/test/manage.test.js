/**
 * The card's directory manager (`M-*`): create, edit and delete routing directories.
 *
 * These cases drive the surface the way the browser does — one JSON payload per
 * call, a session id, and a root the host must recognise as the session's own.
 * @module file-maid/test/manage
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chooseFolderNative, createManageSurface, dialogCandidates } from '../src/surfaces/manage.js';
import * as store from '../src/state/store.js';

/**
 * Build a root with one managed catalog and the session that owns it.
 * @param {string[]} [dirs] - routing directories to declare.
 * @returns {Promise<{ root: string, sessionId: string, ctx: object, surface: object }>} fixtures.
 */
async function makeRoot(dirs = ['00-Specs', '80-Outputs']) {
  const root = await mkdtemp(join(tmpdir(), 'maid-manage-'));
  for (const name of dirs) await mkdir(join(root, name), { recursive: true });
  const sessionId = 'session-manage';
  const ctx = { sessions: { get: (id) => (id === sessionId ? { header: { cwd: root } } : undefined) } };
  const projected = [];
  const roots = { projectRoot: async (target) => projected.push(target) };
  const surface = createManageSurface({ ctx, roots });
  const catalog = {
    version: 1,
    rootDefault: '80-Outputs',
    dirs: dirs.map((path) => ({ path, purpose: `${path} purpose`, excludes: [], examples: [], index: 0 })),
    rules: [],
  };
  await store.writeCatalog(root, store.serializeCatalog(catalog, { root }));
  return { root, sessionId, ctx, surface, projected };
}

test('M-01 add declares a folder that already exists on disk', async (t) => {
  const { root, sessionId, surface } = await makeRoot();
  await mkdir(join(root, '30-Media'), { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  const payload = JSON.stringify({ op: 'add', path: '30-Media', purpose: '媒体素材；图片', excludes: [] });
  const result = await surface.service.save(root, sessionId, payload);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(result.value.dirs.some((dir) => dir.path === '30-Media'));
  assert.equal(result.value.dirs.find((dir) => dir.path === '30-Media').purpose, '媒体素材；图片');
  const info = await stat(join(root, '30-Media'));
  assert.equal(info.isDirectory(), true);
  const loaded = await store.readCatalog(root);
  assert.equal(loaded.state, 'MANAGED');
  assert.ok(loaded.catalog.dirs.some((dir) => dir.path === '30-Media'));
});

test('M-02 add refuses a directory that is already declared', async (t) => {
  const { root, sessionId, surface } = await makeRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await surface.service.save(root, sessionId, JSON.stringify({ op: 'add', path: '00-Specs' }));
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'E_MAID_PATH');
});

test('M-03 update rewrites purpose and terms, keeping the path', async (t) => {
  const { root, sessionId, surface } = await makeRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const payload = JSON.stringify({ op: 'update', path: '00-Specs', purpose: '规范；标准', excludes: '草稿与临时文件' });
  const result = await surface.service.save(root, sessionId, payload);
  assert.equal(result.ok, true, JSON.stringify(result));
  const dir = result.value.dirs.find((entry) => entry.path === '00-Specs');
  assert.equal(dir.purpose, '规范；标准');
  assert.equal(dir.excludes, '草稿与临时文件');
});

test('M-04 removing the default output is refused', async (t) => {
  const { root, sessionId, surface } = await makeRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await surface.service.save(root, sessionId, JSON.stringify({ op: 'remove', path: '80-Outputs' }));
  assert.equal(result.ok, false);
  assert.match(result.errors[0].message, /默认落点/u);
});

test('M-05 removing another directory keeps its files and reprojects', async (t) => {
  const { root, sessionId, surface, projected } = await makeRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, '00-Specs', 'stay.md'), 'x');
  const result = await surface.service.save(root, sessionId, JSON.stringify({ op: 'remove', path: '00-Specs' }));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.value.dirs.some((dir) => dir.path === '00-Specs'), false);
  assert.equal(await readFile(join(root, '00-Specs', 'stay.md'), 'utf8'), 'x');
  assert.deepEqual(projected, [root]);
  // The catalog is hand-editable; the audit line is the record of a card edit.
  const audit = await readFile(join(root, '.maid', 'audit.jsonl'), 'utf8');
  assert.match(audit, /"op":"remove"/u);
  assert.match(audit, /"path":"00-Specs"/u);
});

test('M-06 a root the session does not own is refused before any read', async (t) => {
  const { root, sessionId, surface } = await makeRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const other = await mkdtemp(join(tmpdir(), 'maid-other-'));
  t.after(() => rm(other, { recursive: true, force: true }));
  const result = await surface.service.save(other, sessionId, JSON.stringify({ op: 'add', path: 'x' }));
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'E_MAID_NO_ROOT');
});

test('M-07 the descriptors name the four endpoints and the service carries them', () => {
  const surface = createManageSurface({
    ctx: {},
    roots: { projectRoot: async () => {}, scanRoot: async () => ({}), reloadRoot: async () => 0 },
  });
  assert.deepEqual(surface.descriptors.map((item) => item.id), ['fileMaid/draft', 'fileMaid/pick', 'fileMaid/save', 'fileMaid/scan']);
  assert.equal(typeof surface.service.save, 'function');
  assert.equal(typeof surface.service.pick, 'function');
  assert.equal(typeof surface.service.scan, 'function');
  assert.equal(typeof surface.service.draft, 'function');
  // `draft` takes the typed path as a plain string: the card sends it positionally,
  // so the parameter must not be decoded as JSON.
  const draft = surface.descriptors.find((item) => item.id === 'fileMaid/draft');
  assert.deepEqual(draft.parameters.map((item) => item.name), ['root', 'sessionId', 'path']);
  assert.equal(draft.parameters[2].codec.mode, 'strict');
  assert.equal(surface.service.typertRemote.serviceKey, 'fileMaid');
});

test('M-08 the folder dialog answer is returned as a path inside the root', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maid-pick-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '30-Media', 'nested'), { recursive: true });
  const sessionId = 'session-pick';
  const ctx = { sessions: { get: (id) => (id === sessionId ? { header: { cwd: root } } : undefined) } };
  const surface = createManageSurface({
    ctx,
    roots: { projectRoot: async () => {} },
    chooseFolder: async (start) => {
      // The dialog must open at the controlled root, not at the home directory.
      assert.equal(start, root);
      return { ok: true, path: join(root, '30-Media', 'nested') };
    },
  });
  const result = await surface.service.pick(root, sessionId);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.value.path, '30-Media/nested');
  assert.equal(result.value.cancelled, false);
});

test('M-09 a cancelled dialog and an outside folder are both answered, not thrown', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maid-pick-'));
  const outside = await mkdtemp(join(tmpdir(), 'maid-outside-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const sessionId = 'session-pick';
  const ctx = { sessions: { get: (id) => (id === sessionId ? { header: { cwd: root } } : undefined) } };

  const cancelled = createManageSurface({ ctx, roots: { projectRoot: async () => {} }, chooseFolder: async () => ({ ok: true, cancelled: true }) });
  const first = await cancelled.service.pick(root, sessionId);
  assert.equal(first.ok, true);
  assert.equal(first.value.cancelled, true);

  const away = createManageSurface({ ctx, roots: { projectRoot: async () => {} }, chooseFolder: async () => ({ ok: true, path: outside }) });
  const second = await away.service.pick(root, sessionId);
  assert.equal(second.ok, false);
  assert.equal(second.errors[0].code, 'E_MAID_PATH');
  // The sentence has to name the workspace and what to do, not the code.
  assert.match(second.errors[0].message, /工作区里面的文件夹/u);
  assert.ok(second.errors[0].message.includes(root), 'the refusal names the workspace it accepts');
});

test('M-10 the sessions service is found through get() when ctx.sessions is absent', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maid-sessions-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessionId = 'session-indirect';
  const sessions = { get: (id) => (id === sessionId ? { header: { cwd: root } } : undefined) };
  const ctx = { get: (key) => (key === 'sessions' ? sessions : undefined) };
  const surface = createManageSurface({ ctx, roots: { projectRoot: async () => {} }, chooseFolder: async () => ({ ok: true, cancelled: true }) });
  const result = await surface.service.pick(root, sessionId);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.value.cancelled, true);
});

test('M-11 an unreachable sessions service answers instead of throwing', async () => {
  const surface = createManageSurface({ ctx: {}, roots: { projectRoot: async () => {} } });
  const result = await surface.service.pick('/tmp', 'session-x');
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'E_MAID_NO_ROOT');
  assert.match(result.errors[0].message, /sessions service/iu);
});

test('M-12 every platform seeds its dialog with the controlled root', () => {
  const root = '/Users/someone/Desktop/Work';
  const darwin = dialogCandidates('darwin', root);
  assert.equal(darwin[0].file, 'osascript');
  assert.ok(darwin[0].args.includes(root), 'the path travels as argv, not inside the script');

  const linux = dialogCandidates('linux', root);
  assert.deepEqual(linux.map((entry) => entry.file), ['zenity', 'kdialog', 'python3']);
  assert.ok(linux[0].args.includes(`--filename=${root}/`));
  assert.ok(linux[1].args.includes(root));

  const windows = dialogCandidates('win32', root);
  assert.deepEqual(windows.map((entry) => entry.file), ['powershell', 'pwsh']);
  assert.match(windows[0].args.at(-1), /SelectedPath = '/u);
  assert.ok(windows[0].args.at(-1).includes(root));
});

test('M-13 an unknown platform reports itself instead of guessing', async () => {
  const picked = await chooseFolderNative('/tmp', 'aix');
  assert.equal(picked.ok, false);
  assert.equal(picked.code, 'E_MAID_UNAVAILABLE');
  assert.match(picked.message, /aix/u);
});

test('M-14 windows quotes a folder name that contains an apostrophe', () => {
  const tricky = "/Users/o'brien/Work";
  const [first] = dialogCandidates('win32', tricky);
  const script = first.args.at(-1);
  assert.ok(script.includes("''"), 'the apostrophe is doubled for PowerShell');
  assert.equal(script.includes("SelectedPath = '/Users/o'brien"), false);
});

test('M-15 a folder without a purpose is refused', async (t) => {
  const { root, sessionId, surface } = await makeRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await surface.service.save(root, sessionId, JSON.stringify({ op: 'add', path: '30-Media' }));
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'E_MAID_PURPOSE_MISSING');
  const loaded = await store.readCatalog(root);
  assert.equal(loaded.catalog.dirs.some((dir) => dir.path === '30-Media'), false, 'nothing was written');
});

test('M-16 clearing a purpose on update is refused', async (t) => {
  const { root, sessionId, surface } = await makeRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await surface.service.save(root, sessionId, JSON.stringify({ op: 'update', path: '00-Specs', purpose: '   ' }));
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'E_MAID_PURPOSE_MISSING');
});

test('M-17 a folder that does not exist is refused instead of created', async (t) => {
  const { root, sessionId, surface } = await makeRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await surface.service.save(
    root,
    sessionId,
    JSON.stringify({ op: 'add', path: 'NotThere', purpose: '不存在的目录' }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'E_MAID_PATH');
  assert.match(result.errors[0].message, /没有「NotThere」这个文件夹/u);
  const after = await store.readCatalog(root);
  assert.equal(after.catalog.dirs.some((dir) => dir.path === 'NotThere'), false);
  const onDisk = await stat(join(root, 'NotThere')).then(() => true, () => false);
  assert.equal(onDisk, false, 'the manager must not invent a folder');
});

test('M-18 an edit payload is accepted as update', async (t) => {
  const { root, sessionId, surface } = await makeRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  // The card's edit form always sent `edit`; the Host only knew add/update/remove.
  const result = await surface.service.save(
    root,
    sessionId,
    JSON.stringify({ op: 'edit', path: '00-Specs', purpose: '规范与标准', excludes: '' }),
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  const loaded = await store.readCatalog(root);
  assert.equal(loaded.catalog.dirs.find((dir) => dir.path === '00-Specs').purpose, '规范与标准');
});

test('M-19 a directory with an empty purpose can be given one', async (t) => {
  const { root, sessionId, surface } = await makeRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const seeded = await store.readCatalog(root);
  seeded.catalog.dirs = seeded.catalog.dirs.map((dir) => (dir.path === '00-Specs' ? { ...dir, purpose: '' } : dir));
  await store.writeCatalog(root, store.serializeCatalog(seeded.catalog, { root }));

  const result = await surface.service.save(
    root,
    sessionId,
    JSON.stringify({ op: 'edit', path: '00-Specs', purpose: '历史归档', excludes: '' }),
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  const loaded = await store.readCatalog(root);
  assert.equal(loaded.catalog.dirs.find((dir) => dir.path === '00-Specs').purpose, '历史归档');
});
