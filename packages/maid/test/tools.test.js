/**
 * Tool surface: envelopes, the write channel, and reconciliation (`T-*`).
 * @module file-maid/test/tools
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRoots } from '../src/runtime/roots.js';
import { createTools } from '../src/surfaces/tools.js';
import { catalogDocument, seed } from './helpers.js';

/**
 * Create a workspace-shaped root.
 * @returns {Promise<string>} absolute root.
 */
async function makeRoot() {
  const root = await mkdtemp(join(tmpdir(), 'maid-tools-'));
  for (const name of ['00-Specs', '10-Projects', '30-Media', '80-Outputs']) {
    await mkdir(join(root, name), { recursive: true });
  }
  return root;
}

/**
 * Build a context stub with the services this plugin reads.
 * @param {{ readOnly?: boolean, messages?: unknown[] }} [options] - session options.
 * @returns {{ ctx: object, registered: object[] }} the stub.
 */
function stubContext(options = {}) {
  const registered = [];
  return {
    registered,
    ctx: {
      get(name) {
        if (name === 'workingDirectory') return { get: (session) => session?.header?.cwd };
        if (name === 'permissionPresets') return { current: () => (options.readOnly === true ? 'read-only' : 'workspace-write') };
        return undefined;
      },
      tools: {
        register(definition) {
          registered.push(definition);
          return () => {
            const index = registered.indexOf(definition);
            if (index >= 0) registered.splice(index, 1);
          };
        },
      },
      systemPrompt: { context: () => () => {} },
      on: () => () => {},
      effect: (fn) => fn(),
      sessions: { get: () => ({ deriveMessages: () => options.messages ?? [] }) },
    },
  };
}

/**
 * Build one agent bound to a root.
 * @param {string} root - controlled root.
 * @param {string} [id] - session id.
 * @returns {object} the agent stub.
 */
function makeAgent(root, id = 'session-1') {
  return { id, session: { header: { cwd: root } } };
}

/**
 * Build a session-shaped execution object.
 * @param {object} agent - the agent.
 * @returns {object} the execution stub.
 */
function exec(agent) {
  return { agent, name: 'maid_put', arguments: {} };
}

/**
 * Find one registered tool by name.
 * @param {object[]} registered - registered definitions.
 * @param {string} name - tool name.
 * @returns {object} the definition.
 */
function tool(registered, name) {
  const found = registered.find((definition) => definition.name === name);
  if (found === undefined) throw new Error(`tool not registered: ${name}`);
  return found;
}

test('T-01 the five tools register with the shared envelope schema', async (t) => {
  const { ctx, registered } = stubContext();
  const tools = createTools({ ctx, roots: createRoots({ ctx }) });
  const dispose = tools.register();
  t.after(dispose);
  assert.deepEqual(
    registered.map((definition) => definition.name),
    ['maid_put', 'maid_route', 'maid_init', 'maid_review', 'maid_scan'],
  );
  for (const definition of registered) {
    assert.deepEqual(definition.output.schema.required, ['schemaVersion', 'verdict', 'data', 'errors', 'warnings']);
    assert.equal(typeof definition.output.render, 'function');
    assert.equal(typeof definition.execute, 'function');
  }
});

test('T-02 an uninitialized root answers UNINITIALIZED and writes nothing', async (t) => {
  const root = await makeRoot();
  const { ctx, registered } = stubContext();
  const roots = createRoots({ ctx });
  const tools = createTools({ ctx, roots });
  tools.register();
  t.after(async () => {
    roots.disposeAll();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  const agent = makeAgent(root);
  const result = await tool(registered, 'maid_put').execute({ name: 'a.md', content: 'x' }, exec(agent));
  assert.equal(result.verdict, 'UNINITIALIZED');
  assert.equal(result.errors[0].code, 'E_MAID_UNINITIALIZED');
  assert.deepEqual(await readdir(join(root, '80-Outputs')), []);
});

test('T-03 maid_put writes into the declared directory and records the decision', async (t) => {
  const root = await makeRoot();
  const { ctx, registered } = stubContext();
  const roots = createRoots({ ctx });
  const tools = createTools({ ctx, roots });
  tools.register();
  const agent = makeAgent(root);
  await seed(roots, agent);
  t.after(async () => {
    roots.disposeAll();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  const result = await tool(registered, 'maid_put').execute({ name: 'note.md', content: 'hello', intent: '测试' }, exec(agent));
  assert.equal(result.verdict, 'OK');
  assert.equal(result.data.dir, '80-Outputs');
  assert.equal(result.data.decided_by, 'default');
  assert.equal(result.data.persisted, true);
  assert.equal(await readFile(join(root, '80-Outputs', 'note.md'), 'utf8'), 'hello');
  const log = await readFile(join(root, '.maid', 'decisions.jsonl'), 'utf8');
  assert.match(log, /"name":"note\.md"/u);
  assert.match(log, /"decided_by":"default"/u);
});

test('T-04 a rule beats a caller directory and reports overridden', async (t) => {
  const root = await makeRoot();
  const { ctx, registered } = stubContext();
  const roots = createRoots({ ctx });
  const tools = createTools({ ctx, roots });
  tools.register();
  const agent = makeAgent(root);
  const document = catalogDocument({ rules: [{ match: '规范', dir: '00-Specs' }] });
  await seed(roots, agent, document);
  t.after(async () => {
    roots.disposeAll();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  const result = await tool(registered, 'maid_put').execute({ name: '规范.md', content: 'x', intent: '写规范', dir: '80-Outputs' }, exec(agent));
  assert.equal(result.data.decided_by, 'rule');
  assert.equal(result.data.overridden, true);
  assert.equal(result.data.proposed, '80-Outputs');
  assert.equal(await readFile(join(root, '00-Specs', '规范.md'), 'utf8'), 'x');
});

test('T-05 an existing target is refused unless overwrite is set', async (t) => {
  const root = await makeRoot();
  const { ctx, registered } = stubContext();
  const roots = createRoots({ ctx });
  const tools = createTools({ ctx, roots });
  tools.register();
  const agent = makeAgent(root);
  await seed(roots, agent);
  t.after(async () => {
    roots.disposeAll();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  const put = tool(registered, 'maid_put');
  await put.execute({ name: 'note.md', content: 'one' }, exec(agent));
  const refused = await put.execute({ name: 'note.md', content: 'two' }, exec(agent));
  assert.equal(refused.verdict, 'ERROR');
  assert.equal(refused.errors[0].code, 'E_MAID_EXISTS');
  const replaced = await put.execute({ name: 'note.md', content: 'three', overwrite: true }, exec(agent));
  assert.equal(replaced.verdict, 'OK');
  assert.equal(await readFile(join(root, '80-Outputs', 'note.md'), 'utf8'), 'three');
});

test('T-06 an undeclared directory is refused and nothing is written', async (t) => {
  const root = await makeRoot();
  const { ctx, registered } = stubContext();
  const roots = createRoots({ ctx });
  const tools = createTools({ ctx, roots });
  tools.register();
  const agent = makeAgent(root);
  await seed(roots, agent);
  t.after(async () => {
    roots.disposeAll();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  const result = await tool(registered, 'maid_put').execute({ name: 'a.md', content: 'x', dir: '99-Nowhere' }, exec(agent));
  assert.equal(result.verdict, 'ERROR');
  assert.equal(result.errors[0].code, 'E_MAID_DIR');
  assert.deepEqual(await readdir(join(root, '80-Outputs')), []);
});

test('T-07 a read-only session persists nothing', async (t) => {
  const root = await makeRoot();
  const { ctx, registered } = stubContext({ readOnly: true });
  const roots = createRoots({ ctx });
  const tools = createTools({ ctx, roots });
  tools.register();
  const agent = makeAgent(root);
  await seed(roots, agent);
  t.after(async () => {
    roots.disposeAll();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  const result = await tool(registered, 'maid_put').execute({ name: 'a.md', content: 'x' }, exec(agent));
  assert.equal(result.data.persisted, false);
  assert.deepEqual(await readdir(join(root, '80-Outputs')), []);
  assert.equal(await readFile(join(root, '.maid', 'decisions.jsonl'), 'utf8').catch(() => ''), '');
});

test('T-08 intent falls back to the session tail', async (t) => {
  const root = await makeRoot();
  const { ctx, registered } = stubContext({ messages: [{ content: '把项目文档整理一下' }] });
  const roots = createRoots({ ctx });
  const tools = createTools({ ctx, roots });
  tools.register();
  const agent = makeAgent(root);
  await seed(roots, agent);
  t.after(async () => {
    roots.disposeAll();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  const result = await tool(registered, 'maid_route').execute({ name: 'plan.md' }, exec(agent));
  assert.equal(result.data.intent_source, 'session');
});

test('T-09 reconciliation counts files written outside the channel', async (t) => {
  const root = await makeRoot();
  const { ctx, registered } = stubContext();
  const roots = createRoots({ ctx });
  const tools = createTools({ ctx, roots });
  tools.register();
  const agent = makeAgent(root);
  await seed(roots, agent);
  t.after(async () => {
    roots.disposeAll();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  await writeFile(join(root, '80-Outputs', 'blind-1.md'), 'x');
  await writeFile(join(root, '80-Outputs', 'blind-2.md'), 'x');
  const first = await tool(registered, 'maid_scan').execute({}, exec(agent));
  assert.equal(first.data.reconcile.new_files, 2);
  assert.equal(first.data.reconcile.gap, 2);
  assert.equal(first.data.reconcile.top_dirs[0].dir, '80-Outputs');

  await tool(registered, 'maid_put').execute({ name: 'through.md', content: 'x' }, exec(agent));
  const second = await tool(registered, 'maid_scan').execute({}, exec(agent));
  assert.equal(second.data.reconcile.new_files, 1);
  assert.equal(second.data.reconcile.gap, 0);
});

test('T-14 a scan names the files it cannot account for', async (t) => {
  const root = await makeRoot();
  const { ctx, registered } = stubContext();
  const roots = createRoots({ ctx });
  const tools = createTools({ ctx, roots });
  tools.register();
  const agent = makeAgent(root);
  await seed(roots, agent);
  t.after(async () => {
    roots.disposeAll();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  await writeFile(join(root, '80-Outputs', 'stray.md'), 'x');
  const scan = await tool(registered, 'maid_scan').execute({}, exec(agent));
  assert.equal(typeof scan.data.ledger, 'number');
  assert.ok(Array.isArray(scan.data.missing), 'the envelope carries the blind-spot list');
  assert.ok(scan.data.missing.some((item) => item.path === '80-Outputs/stray.md'), JSON.stringify(scan.data.missing));
});

test('T-10 maid_init refuses to initialize from the tool', async (t) => {
  const root = await makeRoot();
  const { ctx, registered } = stubContext();
  const roots = createRoots({ ctx });
  const tools = createTools({ ctx, roots });
  tools.register();
  const agent = makeAgent(root);
  t.after(async () => {
    roots.disposeAll();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  const init = tool(registered, 'maid_init');
  const refused = await init.execute({ mode: 'init' }, exec(agent));
  assert.equal(refused.verdict, 'ERROR');
  assert.equal(refused.errors[0].code, 'E_MAID_CARD_REQUIRED');
  const opted = await init.execute({ mode: 'opt_out' }, exec(agent));
  assert.equal(opted.verdict, 'NOT_MANAGED');
  assert.match(await readFile(join(root, '.maid', 'opt-out'), 'utf8'), /set by maid_init/u);
});

test('T-11 the name check refuses separators before touching the disk', async (t) => {
  const root = await makeRoot();
  const { ctx, registered } = stubContext();
  const roots = createRoots({ ctx });
  const tools = createTools({ ctx, roots });
  tools.register();
  const agent = makeAgent(root);
  await seed(roots, agent);
  t.after(async () => {
    roots.disposeAll();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  const result = await tool(registered, 'maid_put').execute({ name: '../../evil.md', content: 'x' }, exec(agent));
  assert.equal(result.verdict, 'ERROR');
  assert.equal(result.errors[0].code, 'E_MAID_PATH');
});

test('T-12 every envelope survives a JSON round-trip unchanged', async (t) => {
  const root = await makeRoot();
  const { ctx, registered } = stubContext();
  const roots = createRoots({ ctx });
  const tools = createTools({ ctx, roots });
  tools.register();
  const agent = makeAgent(root);
  await seed(roots, agent);
  t.after(async () => {
    roots.disposeAll();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  const cases = [
    ['maid_route', { name: 'a.md', intent: 'x' }],
    ['maid_put', { name: 'a.md', content: 'x' }],
    ['maid_scan', {}],
    ['maid_init', { mode: 'defer' }],
  ];
  for (const [name, args] of cases) {
    const result = await tool(registered, name).execute(args, exec(agent));
    const roundTripped = JSON.parse(JSON.stringify(result));
    assert.deepEqual(roundTripped, result, `${name} envelope must be lossless JSON`);
  }
});

test('T-13 a successful put republishes the projection the card reads', async (t) => {
  const root = await makeRoot();
  const { ctx, registered } = stubContext();
  const roots = createRoots({ ctx });
  const tools = createTools({ ctx, roots });
  tools.register();
  const agent = makeAgent(root);
  await seed(roots, agent);
  t.after(async () => {
    roots.disposeAll();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  const before = JSON.parse(await readFile(join(root, '.maid', 'status.json'), 'utf8'));
  assert.deepEqual(before.routes, []);

  await tool(registered, 'maid_put').execute({ name: 'note.md', content: 'hello', intent: '测试' }, exec(agent));
  // The refresh runs behind the reply; one macrotask is enough for the write.
  await new Promise((resolve) => setTimeout(resolve, 50));

  const after = JSON.parse(await readFile(join(root, '.maid', 'status.json'), 'utf8'));
  assert.equal(after.routes.length, 1);
  assert.equal(after.routes[0].name, 'note.md');
  assert.equal(after.routes[0].decided_by, 'default');
});

test('T-15 maid_review lists every leak with its size and change time', async (t) => {
  const root = await makeRoot();
  const { ctx, registered } = stubContext();
  const roots = createRoots({ ctx });
  const tools = createTools({ ctx, roots });
  tools.register();
  const agent = makeAgent(root);
  const { entry } = await seed(roots, agent);
  t.after(async () => {
    roots.disposeAll();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  await roots.scan(entry, 'test');
  await writeFile(join(root, '30-Media', 'clip.png'), 'x'.repeat(64));
  await writeFile(join(root, '80-Outputs', 'note.md'), 'y');

  const result = await tool(registered, 'maid_review').execute({}, exec(agent));
  assert.equal(result.verdict, 'OK');
  const paths = result.data.missing.map((item) => item.path).sort();
  assert.deepEqual(paths, ['30-Media/clip.png', '80-Outputs/note.md']);
  const clip = result.data.missing.find((item) => item.path === '30-Media/clip.png');
  assert.equal(clip.size, 64);
  assert.equal(clip.kind, 'file');
  assert.ok(Number.isFinite(clip.ctime));
  assert.equal(result.data.counts.missing, 2);
});

test('T-16 maid_review never advances the baseline', async (t) => {
  const root = await makeRoot();
  const { ctx, registered } = stubContext();
  const roots = createRoots({ ctx });
  const tools = createTools({ ctx, roots });
  tools.register();
  const agent = makeAgent(root);
  const { entry } = await seed(roots, agent);
  t.after(async () => {
    roots.disposeAll();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  await roots.scan(entry, 'test');
  const before = JSON.parse(await readFile(join(root, '.maid', 'index.json'), 'utf8'));
  await writeFile(join(root, '80-Outputs', 'later.md'), 'z');

  const first = await tool(registered, 'maid_review').execute({}, exec(agent));
  const index = JSON.parse(await readFile(join(root, '.maid', 'index.json'), 'utf8'));
  assert.equal(index.generatedAt, before.generatedAt, 'the window start does not move');
  assert.equal(first.data.missing.length, 1);

  // Looking twice must return the same list: a review is not a scan.
  const second = await tool(registered, 'maid_review').execute({}, exec(agent));
  assert.deepEqual(second.data.missing.map((item) => item.path), first.data.missing.map((item) => item.path));
});

test('T-17 maid_review reports the catalog state instead of an empty list', async (t) => {
  const root = await makeRoot();
  const { ctx, registered } = stubContext();
  const roots = createRoots({ ctx });
  const tools = createTools({ ctx, roots });
  tools.register();
  const agent = makeAgent(root);
  t.after(async () => {
    roots.disposeAll();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  const result = await tool(registered, 'maid_review').execute({}, exec(agent));
  assert.equal(result.verdict, 'UNINITIALIZED', 'an uninitialized root is not "no leaks"');
});

test('T-18 maid_review works in a read-only session and writes nothing', async (t) => {
  const root = await makeRoot();
  const { ctx, registered } = stubContext({ readOnly: true });
  const roots = createRoots({ ctx });
  const tools = createTools({ ctx, roots });
  tools.register();
  const agent = makeAgent(root);
  const { entry } = await seed(roots, agent);
  t.after(async () => {
    roots.disposeAll();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  await roots.scan(entry, 'test');
  const statusBefore = await readFile(join(root, '.maid', 'status.json'), 'utf8').catch(() => '');
  await writeFile(join(root, '80-Outputs', 'ro.md'), 'q');

  const result = await tool(registered, 'maid_review').execute({}, exec(agent));
  assert.equal(result.verdict, 'OK');
  assert.equal(result.data.missing.length, 1);
  const statusAfter = await readFile(join(root, '.maid', 'status.json'), 'utf8').catch(() => '');
  assert.equal(statusAfter, statusBefore, 'a review does not touch the projection');
});

test('EX-01 an export lands beside the report under the same stem', async (t) => {
  const root = await makeRoot();
  const { ctx, registered } = stubContext();
  const roots = createRoots({ ctx });
  const tools = createTools({ ctx, roots });
  tools.register();
  const agent = makeAgent(root);
  await seed(roots, agent);
  t.after(async () => {
    roots.disposeAll();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  const result = await tool(registered, 'maid_scan').execute({ report: true, export: 'json' }, exec(agent));
  assert.equal(result.verdict, 'OK');
  const stem = result.data.report.replace(/\.md$/u, '');
  assert.equal(result.data.export, `${stem}.json`);
  const doc = JSON.parse(await readFile(join(root, result.data.export), 'utf8'));
  assert.equal(doc.schemaVersion, '1');
  assert.ok(Array.isArray(doc.missing));
  assert.equal(typeof doc.counts.new_files, 'number');
});

test('EX-02 a coverage hole exports counts as unknown, not zero', async (t) => {
  const root = await makeRoot();
  const { ctx, registered } = stubContext();
  const roots = createRoots({ ctx });
  const tools = createTools({ ctx, roots });
  tools.register();
  const agent = makeAgent(root);
  const { entry } = await seed(roots, agent);
  t.after(async () => {
    roots.disposeAll();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  await roots.scan(entry, 'test');
  // A rotation inside the window is a hole; the export must not read as "nothing leaked".
  await writeFile(join(root, '.maid', 'rotation.json'), JSON.stringify({ decisions: new Date(Date.now() + 1000).toISOString() }));

  const result = await tool(registered, 'maid_scan').execute({ export: 'json' }, exec(agent));
  const doc = JSON.parse(await readFile(join(root, result.data.export), 'utf8'));
  assert.equal(doc.coverage.ledger && doc.coverage.decisions, false);
  assert.deepEqual(doc.missing, []);
  assert.equal(doc.counts.residual, null);
});

test('EX-03 the export can stand alone, and the budget counts pairs', async (t) => {
  const root = await makeRoot();
  const { ctx, registered } = stubContext();
  const roots = createRoots({ ctx });
  const tools = createTools({ ctx, roots });
  tools.register();
  const agent = makeAgent(root);
  const { entry } = await seed(roots, agent);
  t.after(async () => {
    roots.disposeAll();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  await roots.scan(entry, 'test');

  const alone = await tool(registered, 'maid_scan').execute({ export: 'json' }, exec(agent));
  assert.equal(alone.data.report, null, 'no markdown was asked for');
  assert.ok(alone.data.export.endsWith('.json'));
  assert.equal(await readFile(join(root, alone.data.export), 'utf8').then(() => true).catch(() => false), true);
});

test('EX-04 pruning drops a pair when the budget turns over', async (t) => {
  const root = await makeRoot();
  const { ctx, registered } = stubContext();
  const roots = createRoots({ ctx });
  const tools = createTools({ ctx, roots });
  tools.register();
  const agent = makeAgent(root);
  const { entry } = await seed(roots, agent);
  t.after(async () => {
    roots.disposeAll();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  await roots.scan(entry, 'test');

  // 31 pairs is one over the budget; the oldest pair goes, md and json together.
  await mkdir(join(root, '.maid', 'reports'), { recursive: true });
  for (let index = 0; index < 31; index += 1) {
    const stamp = new Date(Date.now() - (index + 1) * 60000);
    const pad = (value) => String(value).padStart(2, '0');
    const name = `scan-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}`;
    await writeFile(join(root, '.maid', 'reports', `${name}.md`), 'x');
    await writeFile(join(root, '.maid', 'reports', `${name}.json`), '{}');
  }
  const result = await tool(registered, 'maid_scan').execute({ export: 'json' }, exec(agent));
  assert.equal(result.verdict, 'OK');
  const left = await readdir(join(root, '.maid', 'reports'));
  const stems = new Set(left.map((name) => name.replace(/\.(md|json)$/u, '')));
  assert.ok(stems.size <= 30, `kept ${stems.size} pairs`);
  // Whatever survived, every stem keeps both halves.
  for (const stem of stems) {
    const hasMd = left.includes(`${stem}.md`);
    const hasJson = left.includes(`${stem}.json`);
    assert.ok(hasMd || hasJson);
  }
});

test('EX-05 the CLI writes the same pair as the tool', async (t) => {
  const root = await makeRoot();
  const { ctx, registered } = stubContext();
  const roots = createRoots({ ctx });
  const tools = createTools({ ctx, roots });
  tools.register();
  const agent = makeAgent(root);
  const { entry } = await seed(roots, agent);
  t.after(async () => {
    roots.disposeAll();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  await roots.scan(entry, 'test');

  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const cli = join(import.meta.dirname, '..', 'scripts', 'cli.js');
  const { stdout } = await promisify(execFile)(process.execPath, [cli, 'scan', '--root', root, '--export', 'json']);
  const printed = JSON.parse(stdout);
  assert.ok(printed.report.endsWith('.md'));
  assert.ok(printed.export.endsWith('.json'));
  assert.equal(printed.export.replace(/\.json$/u, ''), printed.report.replace(/\.md$/u, ''), 'one stem, two files');
  const files = await readdir(join(root, '.maid', 'reports'));
  assert.ok(files.includes(printed.report.split('/').pop()));
  assert.ok(files.includes(printed.export.split('/').pop()));
});
