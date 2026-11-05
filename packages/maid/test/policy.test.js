/**
 * Write-surface decisions (`§13.7` I-01..I-10).
 * @module file-maid/test/policy
 */
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { candidatesFor, createWriteGuard, judgeCall, lockedError } from '../src/surfaces/fs-policy.js';
import { protectionVerdict } from '../src/state/probe.js';

/**
 * Create a controlled root with a `.maid` directory.
 * @returns {Promise<string>} absolute root.
 */
async function makeRoot() {
  const root = await mkdtemp(join(tmpdir(), 'maid-policy-'));
  await mkdir(join(root, '.maid'), { recursive: true });
  await mkdir(join(root, '80-Outputs'), { recursive: true });
  return root;
}

/**
 * Build one tool execution.
 * @param {string} name - tool name.
 * @param {object} args - tool arguments.
 * @param {object} [agent] - owning agent.
 * @returns {object} the execution.
 */
function execution(name, args, agent = { session: { header: {} } }) {
  return { name, arguments: args, agent };
}

test('I-01 an absolute .maid path is refused lexically', async (t) => {
  const root = await makeRoot();
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  const verdict = judgeCall({
    exec: execution('write', { file_path: join(root, '.maid', 'catalog.yml'), content: 'x' }),
    root,
    basis: root,
  });
  assert.equal(verdict?.reason, 'LEXICAL');
});

test('I-01 a relative .maid path is refused lexically', async (t) => {
  const root = await makeRoot();
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  const verdict = judgeCall({ exec: execution('edit', { file_path: '.maid/catalog.yml' }), root, basis: root });
  assert.equal(verdict?.reason, 'LEXICAL');
});

test('I-02 and I-05 a symlinked parent directory is refused by inode', async (t) => {
  const root = await makeRoot();
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  await symlink(join(root, '.maid'), join(root, 'alias'));
  const verdict = judgeCall({ exec: execution('write', { file_path: join(root, 'alias', 'index.json') }), root, basis: root });
  assert.equal(verdict?.reason, 'INODE');
});

test('I-24 the Host resolution of the target joins the protection check', async (t) => {
  const root = await makeRoot();
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  // The Host stores the realpath it resolved before firing the intent; a lexical-only
  // comparison would miss a symlink whose visible path never mentions `.maid`.
  const visible = join(root, 'shared', 'handbook.yml');
  const physical = join(root, '.maid', 'catalog.yml');
  const guard = createWriteGuard({ ctx: { get: (name) => (name === 'fs' ? { processPath: () => physical } : undefined) } });
  let continued = 0;
  let failure;
  try {
    await guard.onIntent({ displayPath: visible }, execution('write', { file_path: visible }, { session: { header: { cwd: root } } }), () => {
      continued += 1;
      return undefined;
    });
  } catch (error) {
    failure = error;
  }
  assert.equal(continued, 0);
  assert.equal(failure?.code, 'FS_PERMISSION_DENIED');
  assert.ok(failure.message.includes('MAID_LOCKED'));
});

test('I-22 a host-resolved intent from an unknown tool is still judged', async (t) => {
  const root = await makeRoot();
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  // `fs/write-intent` fires for any writer going through ctx.fs; the Host resolves the
  // target, so a tool outside the argument-parsing whitelist must not slip through.
  const verdict = judgeCall({
    exec: execution('some_other_writer', {}, { session: { header: { cwd: root } } }),
    target: { displayPath: join(root, '.maid', 'catalog.yml') },
    root,
    basis: root,
  });
  assert.equal(verdict?.reason, 'LEXICAL');
});

test('I-23 a host-resolved intent outside the surface is allowed', async (t) => {
  const root = await makeRoot();
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  const verdict = judgeCall({
    exec: execution('some_other_writer', {}, { session: { header: { cwd: root } } }),
    target: { displayPath: join(root, '80-Outputs', 'ok.md') },
    root,
    basis: root,
  });
  assert.equal(verdict, undefined);
});

test('I-20 a file symlink into .maid is refused by inode', async (t) => {
  const root = await makeRoot();
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  await writeFile(join(root, '.maid', 'catalog.yml'), 'version: 1\n');
  // The spelled path shares no prefix with `.maid`; only resolving the leaf reveals it.
  await symlink(join(root, '.maid', 'catalog.yml'), join(root, 'innocent.yml'));
  const verdict = judgeCall({ exec: execution('write', { file_path: join(root, 'innocent.yml'), content: 'x' }), root, basis: root });
  assert.equal(verdict?.reason, 'INODE');
});

test('I-21 a directory symlink into .maid is refused for new files beneath it', async (t) => {
  const root = await makeRoot();
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  await mkdir(join(root, '.maid', 'reports'), { recursive: true });
  await symlink(join(root, '.maid', 'reports'), join(root, 'reports'));
  const verdict = judgeCall({ exec: execution('write', { file_path: join(root, 'reports', 'scan-new.md'), content: 'x' }), root, basis: root });
  assert.equal(verdict?.reason, 'INODE');
});

test('I-03 a relative write after cd .maid is refused', async (t) => {
  const root = await makeRoot();
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  const verdict = judgeCall({ exec: execution('write', { file_path: 'audit.jsonl' }), root, basis: join(root, '.maid') });
  assert.equal(verdict?.reason, 'LEXICAL');
});

test('I-04 a relative write after the committed directory vanished is still refused', async (t) => {
  const root = await makeRoot();
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  const maid = join(root, '.maid');
  const verdict = judgeCall({ exec: execution('write', { file_path: 'report.md' }), root: maid, basis: join(maid, 'deleted-subdir') });
  assert.equal(verdict?.reason, 'LEXICAL');
});

test('I-06 a non-protected path continues to the next listener', async (t) => {
  const root = await makeRoot();
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  const refusal = judgeCall({ exec: execution('write', { file_path: join(root, '80-Outputs', 'report.md') }), root, basis: root });
  assert.equal(refusal, undefined);

  let continued = 0;
  const guard = createWriteGuard({ ctx: { get: () => undefined } });
  const result = await guard.onIntent({ displayPath: join(root, '80-Outputs', 'report.md') }, execution('write', { file_path: join(root, '80-Outputs', 'report.md') }), () => {
    continued += 1;
    return { kind: 'replaceIfVersion', version: 'v1' };
  });
  assert.equal(continued, 1);
  assert.deepEqual(result, { kind: 'replaceIfVersion', version: 'v1' });
});

test('I-07 str_replace_editor view is allowed even on .maid', async (t) => {
  const root = await makeRoot();
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  const refusal = judgeCall({
    exec: execution('str_replace_editor', { command: 'view', path: join(root, '.maid', 'catalog.yml') }),
    root,
    basis: root,
  });
  assert.equal(refusal, undefined);
});

test('I-08 str_replace_editor create is refused', async (t) => {
  const root = await makeRoot();
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  const refusal = judgeCall({
    exec: execution('str_replace_editor', { command: 'create', path: join(root, '.maid', 'guard.jsonl') }),
    root,
    basis: root,
  });
  assert.equal(refusal?.reason, 'LEXICAL');
});

test('I-09 an agentless call is not served', async (t) => {
  const root = await makeRoot();
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  const guard = createWriteGuard({ ctx: { get: () => undefined } });
  let continued = 0;
  await guard.onIntent({ displayPath: join(root, '.maid', 'catalog.yml') }, { name: 'write', arguments: { file_path: join(root, '.maid', 'catalog.yml') } }, () => {
    continued += 1;
    return undefined;
  });
  assert.equal(continued, 1);
});

test('I-10 pre-execute returns a deny decision with the fixed prefix', async (t) => {
  const root = await makeRoot();
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  const guard = createWriteGuard({ ctx: { get: () => undefined } });
  const agent = { session: { header: { cwd: root } } };
  const decision = await guard.onPreExecute(execution('write', { file_path: join(root, '.maid', 'catalog.yml') }, agent), () => ({ kind: 'allow' }));
  assert.equal(decision.kind, 'deny');
  assert.ok(decision.reason.startsWith('FILE_MAID:MAID_LOCKED:'));
  assert.equal(decision.info.code, 'FS_PERMISSION_DENIED');
  assert.equal(decision.info.reason, 'LEXICAL');
});

test('the refusal keeps the documented prefix and code', () => {
  const error = lockedError('INODE', '/tmp/x/.maid/y');
  assert.equal(error.code, 'FS_PERMISSION_DENIED');
  assert.equal(error.reason, 'INODE');
  assert.ok(error.message.startsWith('FILE_MAID:MAID_LOCKED:INODE'));
});

test('both resolution bases are judged', async (t) => {
  const root = await makeRoot();
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  const candidates = candidatesFor({ root, basis: join(root, '.maid'), raw: 'nested/file.md', displayPath: join(root, '80-Outputs', 'file.md') });
  assert.ok(candidates.some((candidate) => candidate.includes(`${join(root, '.maid')}/nested/file.md`)));
  const refusal = judgeCall({ exec: execution('write', { file_path: 'nested/file.md' }), root, basis: join(root, '.maid') });
  assert.equal(refusal?.reason, 'LEXICAL');
});

test('an unprobeable .maid refuses as UNVERIFIED', async (t) => {
  const outer = await mkdtemp(join(tmpdir(), 'maid-unverified-'));
  const root = join(outer, 'root');
  await mkdir(join(root, '.maid'), { recursive: true });
  t.after(async () => {
    await chmod(outer, 0o700);
    await rm(outer, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  await chmod(outer, 0o000);
  const surface = { protections: [], failed: [join(root, '.maid')] };
  assert.equal(protectionVerdict(join(root, '80-Outputs', 'x.md'), surface), 'UNVERIFIED');
});

test('only write, edit and str_replace_editor are judged', async (t) => {
  const root = await makeRoot();
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  for (const name of ['bash', 'read', 'glob', 'maid_route']) {
    const refusal = judgeCall({ exec: execution(name, { file_path: join(root, '.maid', 'catalog.yml') }), root, basis: root });
    assert.equal(refusal, undefined, `${name} must not be judged`);
  }
});
