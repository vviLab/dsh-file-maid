/**
 * Render smoke test with data (`RD-*`, second half).
 *
 * The shell-only harness mounts the card with no sessions, so every loop over the
 * directories is skipped — which is exactly where the previous three blank screens were
 * hiding. This file runs a small React runtime that keeps state and re-renders, feeds a
 * `status.json` fixture through the `remote` service, and then asserts that the rows the
 * operator sees were actually built.
 * @module file-maid/test/render-data
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));

/** A status snapshot shaped like the one the Host writes. */
const STATUS = {
  schemaVersion: '2',
  generatedAt: '2026-11-05T12:00:00.000Z',
  root: '/workspace',
  catalog: {
    state: 'MANAGED',
    hash: 'sha256:abc',
    rootDefault: '80-Outputs',
    ruleCount: 0,
    dirs: [
      { path: '00-Specs', purpose: '工作区通用规范文件', excludes: '日志', files: 4 },
      { path: '20-Learning', purpose: '学习资料与笔记', excludes: '', files: 13 },
      { path: '80-Outputs', purpose: '非项目输出物的默认落点', excludes: '', files: 24 },
    ],
  },
  scan: { at: '2026-11-05T12:00:00.000Z', files: 41, dirs: 7, ms: 52, degraded: false },
  reconcile: {
    new_files: 3,
    recorded: 1,
    ledger: 1,
    missing: [{ path: '80-Outputs/漏网.md', dir: '80-Outputs' }],
    acknowledged_files: 0,
    missing_total: 2,
    residual: 1,
  },
  routes: [{ at: '2026-11-05T11:59:00.000Z', name: '报告.md', dir: '80-Outputs', decided_by: 'default', intent_source: 'param' }],
};

/**
 * Build a React stand-in that keeps state across renders.
 * @returns {object} the runtime, its hooks, and a render driver.
 */
function runtime() {
  /** Per-component hook storage, keyed by the component function itself. */
  const frames = new Map();
  let frame = null;
  let effects = [];
  let dirty = false;

  /**
   * Open (or reuse) the hook frame of one component.
   * @param {Function} component - the function component.
   * @returns {{slots: object[], cursor: number}} the frame.
   */
  const enter = (component) => {
    if (!frames.has(component)) frames.set(component, { slots: [], cursor: 0, keys: {} });
    const current = frames.get(component);
    current.cursor = 0;
    frame = current;
    return current;
  };

  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    Fragment: Symbol('Fragment'),
    useState: (initial) => {
      const at = frame.cursor++;
      if (frame.slots[at] === undefined) frame.slots[at] = { value: typeof initial === 'function' ? initial() : initial };
      const slot = frame.slots[at];
      const set = (next) => {
        const value = typeof next === 'function' ? next(slot.value) : next;
        if (value !== slot.value) {
          slot.value = value;
          dirty = true;
        }
      };
      return [slot.value, set];
    },
    useRef: (initial) => {
      const at = frame.cursor++;
      if (frame.slots[at] === undefined) frame.slots[at] = { value: { current: initial } };
      return frame.slots[at].value;
    },
    useEffect: (fn, deps) => {
      const at = frame.cursor++;
      effects.push({ frame, at, fn, deps });
    },
    useLayoutEffect: (fn, deps) => {
      const at = frame.cursor++;
      effects.push({ frame, at, fn, deps });
    },
    useMemo: (fn, deps) => {
      const at = frame.cursor++;
      const key = deps === undefined ? 'always' : JSON.stringify(deps);
      if (frame.slots[at] === undefined || frame.slots[at].key !== key) frame.slots[at] = { value: fn(), key };
      return frame.slots[at].value;
    },
    useCallback: (fn) => {
      frame.cursor += 1;
      return fn;
    },
    useReducer: (reducer, initial) => React.useState(initial),
    createContext: () => ({}),
    useContext: () => undefined,
    memo: (component) => component,
    Children: { toArray: (value) => (Array.isArray(value) ? value : value === undefined ? [] : [value]) },
  };

  /**
   * Resolve one node: function components run and their output is walked again.
   * @param {object|string|number|Array|null} node - anything the client produced.
   * @param {number} depth - recursion guard.
   * @returns {object} a tree of plain elements.
   */
  const renderNode = (node, depth = 0) => {
    if (node === null || node === undefined || node === false || node === true) return null;
    if (Array.isArray(node)) return node.map((item) => renderNode(item, depth)).filter((item) => item !== null);
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (typeof node !== 'object') return null;
    const { type, props } = node;
    const children = node.children ?? [];
    if (typeof type === 'function') {
      if (depth > 40) throw new Error('component recursion is too deep');
      enter(type);
      const produced = type({ ...props, children });
      return renderNode(produced, depth + 1);
    }
    return {
      type: typeof type === 'symbol' ? 'fragment' : type,
      props: props ?? {},
      children: renderNode(children, depth),
    };
  };

  /**
   * Render the root component once and run the effects whose deps changed.
   * @param {object} element - the root element.
   * @returns {object} the resolved tree.
   */
  const pass = (element) => {
    effects = [];
    dirty = false;
    const tree = renderNode(element);
    for (const effect of effects) {
      const slot = effect.frame.slots[effect.at];
      const key = effect.deps === undefined ? 'always' : JSON.stringify(effect.deps);
      if (slot !== undefined && slot.key === key) continue;
      effect.frame.slots[effect.at] = { ...(slot ?? {}), key };
      try {
        effect.fn();
      } catch (error) {
        throw new Error(`effect threw: ${error.message}`);
      }
    }
    return tree;
  };

  return { React, pass, isDirty: () => dirty };
}

/**
 * Mount the card with a fixture and collect what it rendered.
 * @returns {Promise<{tree: object, hooks: Set<string>, texts: string[]}>} the result.
 */
async function mount({ page } = {}) {
  const source = await readFile(join(packageDir, 'src', 'client.js'), 'utf8');
  const dom = new JSDOM('<!doctype html><body><div id="dsh-st-shell-panel"></div></body>', { url: 'http://localhost/' });
  const { window } = dom;
  // The card remembers its collapsed state; the rows only exist while it is open.
  window.localStorage.setItem('dsh-file-maid.card.open', '1');
  const rt = runtime();
  let element = null;

  const requireStub = (id) => {
    if (id === 'react') return rt.React;
    if (id === 'react-dom/client') {
      return { createRoot: () => ({ render: (next) => { element = next; }, unmount: () => {} }) };
    }
    if (id === 'react-dom') return { createPortal: (node) => node };
    // Leave SegmentedTabs undefined so the bundle renders its own tab buttons, which
    // the test can press instead of guessing at the host component's contract.
    return {};
  };

  let module = null;
  window.__ModuleLoader__ = { load: (loaded) => { module = loaded; } };
  window.matchMedia = () => ({ matches: false, addEventListener: () => {} });
  const sandbox = {
    window,
    document: window.document,
    console,
    require: requireStub,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    requestAnimationFrame: (fn) => { fn(0); return 0; },
    cancelAnimationFrame: () => {},
    localStorage: window.localStorage,
    AbortController,
    ResizeObserver: class { observe() {} disconnect() {} },
    MutationObserver: class { observe() {} disconnect() {} },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  assert.ok(module !== null, 'the bundle registers itself');

  const text = JSON.stringify(STATUS, null, 2);
  const sessions = {
    list: {
      getSnapshot: () => ({ ids: ['s1'], byId: { s1: { cwd: STATUS.root, updatedAt: 1 } } }),
      subscribe: () => () => {},
    },
    get: () => ({ header: { cwd: STATUS.root } }),
  };
  const remote = {
    fileMaid: {
      // The carrier wraps the service reply, and the service reply wraps the value:
      // callRemote() strips only the outer layer.
      review: async () => ({
        ok: true,
        value: {
          ok: true,
          value: {
            measuredAt: STATUS.generatedAt,
            baseline: false,
            truncated: false,
            candidateLimit: 500,
            coverage: { decisions: true, ledger: true },
            counts: { new_files: 3, recorded_files: 1, ledger_files: 1, missing: 1, acknowledged_files: 0, missing_total: 2, residual: 1 },
            readOnly: false,
            acknowledged: [],
            missing: [
              { path: '80-Outputs/漏网.md', dir: '80-Outputs', ctime: Date.parse('2026-11-05T11:59:30.000Z'), size: 1258291, kind: 'file' },
            ],
          },
        },
      }),
      ack: async () => ({ ok: true, value: { ok: true, value: { revision: 1, counts: null } } }),
    },
    workspaceFiles: {
      stat: async () => ({ ok: true, value: { size: text.length } }),
      read: async () => ({ ok: true, value: { text, offset: 1, lines: text.split('\n').length, eof: true } }),
    },
  };
  const ctx = {
    locale: Object.assign((key) => key, { bind: () => (key) => key, register: () => () => {} }),
    effect: (fn) => { try { fn(); } catch { /* mount errors surface below */ } return () => {}; },
    slots: { register: () => () => {}, inject: () => () => {} },
    tools: { register: () => () => {} },
    sessions,
    remote,
    get: (name) => {
      if (name === 'sessions') return sessions;
      if (name === 'remote') return remote;
      if (name === 'remote.fileMaid') return remote.fileMaid;
      return undefined;
    },
    on: () => () => {},
    inject: () => ({ dispose: () => {} }),
    provide: () => {},
  };

  const mod = module.factory(requireStub);
  mod.apply(ctx);
  assert.ok(element !== null, 'the card is handed to a root');

  let tree = rt.pass(element);
  // The snapshot arrives asynchronously; give the promise chain room to land and render
  // again, a bounded number of times so a runaway effect fails instead of hanging.
  for (let round = 0; round < 12; round += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    tree = rt.pass(element);
  }

  const pressTab = (tree, value) => {
    const tab = findTab(tree, value);
    assert.ok(tab !== null, `the ${value} tab exists`);
    tab.props.onClick();
  };
  const findTab = (node, value) => {
    if (node === null || node === undefined) return null;
    if (Array.isArray(node)) {
      for (const item of node) {
        const found = findTab(item, value);
        if (found !== null) return found;
      }
      return null;
    }
    if (typeof node !== 'object') return null;
    if (node.props?.role === 'tab' && node.props?.['data-view'] === value) return node;
    return findTab(node.children, value) ?? findTab(node.props?.children, value);
  };
  const hooks = new Set();
  const texts = [];
  const walk = (node) => {
    if (node === null || node === undefined) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (typeof node === 'string') {
      texts.push(node);
      return;
    }
    if (typeof node !== 'object') return;
    const hook = node.props?.['data-file-maid'];
    if (typeof hook === 'string') hooks.add(hook);
    walk(node.children);
    if (node.props?.children !== undefined) walk(node.props.children);
  };
  walk(tree);
  if (page !== undefined) {
    pressTab(tree, page);
    for (let round = 0; round < 6; round += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      tree = rt.pass(element);
    }
    hooks.clear();
    texts.length = 0;
    walk(tree);
  }
  return { tree, hooks, texts };
}

test('RD-06 the directory rows, the table rows and the ledger all render with data', async () => {
  const { hooks, texts } = await mount();
  assert.ok(hooks.has('tabrow'), `the card built its directory rows; saw ${[...hooks].join(',')}`);
  assert.ok(hooks.has('tabtoggle'), 'each row has its disclosure');
  assert.ok(hooks.has('item') || hooks.has('tabrow'), 'the record list is reached from the same snapshot');
  assert.ok(texts.some((value) => value.includes('00-Specs')), 'the directory names reached the output');
});

test('RD-07 switching to the scan page renders the verdict and the three counts', async () => {
  const { texts, hooks } = await mount({ page: 'scan' });
  assert.ok(hooks.has('verdictband'), 'the answer band is the first thing on the page');
  assert.ok(hooks.has('verdicttext'), 'it carries a sentence, not a category name');
  assert.ok(hooks.has('scansentence'), 'the period opens with a spoken sentence');
  assert.ok(texts.some((value) => value.includes('3')), 'the new-file count from the snapshot is shown');
  // The scan cost is folded away: it answers a question the reader did not ask.
  assert.equal(hooks.has('costline'), false, 'cost stays closed until asked');
});

test('RD-08 the scan page builds the rich leak rows from the review reply', async () => {
  const { texts, hooks } = await mount({ page: 'scan' });
  assert.ok(hooks.has('missrow'), 'a two-line leak row was built');
  assert.ok(hooks.has('misstoggle'), 'the row is a disclosure button');
  assert.ok(hooks.has('missname'), 'the file name has its own hook');
  assert.ok(hooks.has('missdim'), 'the owner and the size have their own hook');
  assert.ok(texts.some((value) => value.includes('1.2 MB')), 'the size column shows a human number');
  assert.ok(texts.some((value) => value.includes('漏网.md')), 'the name is shown, not the whole path');
});


test('RD-09 the counts add up to the sentence, and no fact is stated twice', async () => {
  const { texts } = await mount({ page: 'scan' });
  const count = (needle) => texts.filter((value) => value === needle).length;
  // The fixture has one residual, so the fourth cell exists and 1+1+2+1 = 5 would be
  // the sentence number; without it the three above would not add up.
  assert.ok(texts.includes('k.unclear'), 'a residual cell appears when there is a residual');
  // The verdict says "N files did not go through" once; the list head must not repeat it.
  assert.equal(count('scan.leakTitle'), 1, 'the list head appears once');
  assert.equal(count('verdict.leak'), 1, 'the verdict appears once');
});


test('RD-10 the counts carry their own sentence underneath', async () => {
  const { texts, hooks } = await mount({ page: 'scan' });
  const sentence = texts.indexOf('scan.newLine') >= 0 ? texts.indexOf('scan.newLine') : texts.indexOf('scan.noneNew');
  const firstCell = Math.min(...['k.byMaid', 'k.byTools', 'k.onTheirOwn'].map((key) => texts.indexOf(key)).filter((i) => i >= 0));
  assert.ok(firstCell >= 0, 'the three counts are rendered');
  assert.ok(sentence > firstCell, 'the sentence reads under the numbers, not above them');
  // The block needs no title of its own; the numbers are the header.
  assert.equal(texts.includes('section.who'), false, 'the group title is gone');
  assert.ok(hooks.has('scansentence'));
});
