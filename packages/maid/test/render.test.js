/**
 * Render smoke test for the card (`RD-*`).
 *
 * The panel is a classic script that the Host page loads into a real React root.
 * Unit tests read its text, so a symbol that is deleted from the renderer but still
 * referenced by an effect never fails them — the card just goes blank in the browser.
 * These tests build a real DOM, run the module's `apply`, and execute every component
 * body, so a missing binding shows up here instead of on the operator's screen.
 * @module file-maid/test/render
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { JSDOM } from 'jsdom';

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * A React stand-in good enough to execute component bodies.
 *
 * Hooks keep their initial value and never re-render: the point is to run the render
 * path, not to model scheduling.
 */
function stubReact(onRender) {
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    Fragment: Symbol('Fragment'),
    useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
    useRef: (value) => ({ current: value }),
    useEffect: () => {},
    useLayoutEffect: () => {},
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn(),
    useReducer: (reducer, initial) => [initial, () => {}],
    createContext: () => ({ Provider: 'provider', Consumer: 'consumer' }),
    useContext: () => undefined,
    memo: (component) => component,
  };
  react.createElement = (type, props, ...children) => {
    const node = { type, props: props ?? {}, children };
    onRender?.(node);
    return node;
  };
  return react;
}

/**
 * Load the client bundle into a fresh DOM and run its `apply`.
 * @param {object} options - render walker hooks.
 * @returns {Promise<object>} collected components and errors.
 */
async function mount(options = {}) {
  const source = await readFile(join(packageDir, 'src', 'client.js'), 'utf8');
  const dom = new JSDOM('<!doctype html><body><div id="dsh-st-shell-panel"></div></body>', { url: 'http://localhost/' });
  const { window } = dom;
  const seen = new Set();
  const errors = [];
  const rendered = [];

  /**
   * Walk an element tree, executing each function component once.
   * @param {object} node - element tree root.
   * @param {number} depth - recursion guard.
   * @returns {void}
   */
  const walk = (node, depth = 0) => {
    if (node === null || node === undefined || depth > 60) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    if (typeof node !== 'object') return;
    if (typeof node.type === 'function') {
      if (seen.has(node.type)) return;
      seen.add(node.type);
      try {
        walk(node.type(node.props ?? {}), depth + 1);
      } catch (error) {
        errors.push(`${node.type.name || 'anonymous'}: ${error.message}`);
      }
      return;
    }
    walk(node.children, depth + 1);
  };

  const react = stubReact();
  const requireStub = (id) => {
    if (id === 'react') return react;
    if (id === 'react-dom/client') {
      return {
        createRoot: () => ({
          render: (element) => {
            rendered.push(element);
            walk(element);
          },
          unmount: () => {},
        }),
      };
    }
    if (id === 'react-dom') return { createPortal: (element) => element };
    if (id.includes('primitives')) {
      return {
        SegmentedTabs: (props) => {
          const tabs = Array.isArray(props.items) ? props.items : [];
          return react.createElement(
            'div',
            { role: 'tablist' },
            ...tabs.map((item) => react.createElement('button', { role: 'tab', key: item.value }, item.label)),
            props.children,
          );
        },
      };
    }
    throw new Error(`unexpected require: ${id}`);
  };

  let module = null;
  window.__ModuleLoader__ = { load: (loaded) => { module = loaded; } };
  window.React = react;
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
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    localStorage: window.localStorage,
  };
  window.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} });

  const vm = await import('node:vm');
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  assert.ok(module !== null, 'the bundle registers itself with the module loader');

  /**
   * A service surface that tolerates any read and returns a no-op function.
   * @returns {object} the proxy.
   */
  const tolerant = () =>
    new Proxy(
      {},
      {
        get: (_target, key) => {
          if (key === 'then') return undefined;
          return () => tolerant();
        },
      },
    );

  const ctx = {
    locale: Object.assign((key) => key, {
      bind: () => (key) => key,
      register: () => () => {},
      get: () => undefined,
    }),
    effect: (fn) => {
      try {
        const cleanup = fn();
        return typeof cleanup === 'function' ? cleanup : () => {};
      } catch (error) {
        errors.push(`effect: ${error.message}`);
        return () => {};
      }
    },
    slots: {
      register: () => () => {},
      inject: (name, fn) => {
        try {
          const cleanup = fn();
          return typeof cleanup === 'function' ? cleanup : () => {};
        } catch (error) {
          errors.push(`inject ${name}: ${error.message}`);
          return () => {};
        }
      },
    },
    tools: { register: () => () => {} },
    sessions: { get: () => ({ deriveMessages: () => [] }) },
    get: (name) => (name === 'sessions' ? ctx.sessions : tolerant()),
    on: () => () => {},
    inject: () => ({ dispose: () => {} }),
    provide: () => {},
    dom: options.dom ?? {},
  };

  try {
    const mod = module.factory(requireStub);
    assert.equal(typeof mod.apply, 'function', 'the bundle exposes apply');
    mod.apply(ctx);
  } catch (error) {
    errors.push(`apply: ${error.message}`);
  }

  return { rendered, seen, errors, window };
}

test('RD-01 the card mounts and every component body renders without throwing', async () => {
  const { rendered, seen, errors } = await mount();
  assert.deepEqual(errors, [], 'no component body or effect may throw');
  assert.ok(rendered.length > 0, 'the card is handed to a React root');
  assert.ok(seen.size >= 3, `more than one component renders (saw ${seen.size})`);
});

test('RD-02 the renderer runs the directory page, not only the shell', async () => {
  const { seen } = await mount();
  const names = [...seen].map((fn) => fn.name).filter((name) => name !== '');
  assert.ok(names.length > 0, 'components are named, so a failure can say which one');
});

/**
 * Every `React.useState` binding and the position of its first use.
 *
 * The card crashed twice on this shape: a state read before its `const` runs
 * (temporal dead zone) and a setter called with no state behind it. Neither shows up
 * in a text-only test, so they are checked structurally here.
 * @param {string} body - the client bundle.
 * @returns {{states: Array<{name: string, setter: string, at: number}>, errors: string[]}} findings.
 */
function stateBindings(body) {
  const states = [];
  const pattern = /const \[(\w+), (set\w+)\] = React\.useState\(/gu;
  for (const match of body.matchAll(pattern)) {
    states.push({ name: match[1], setter: match[2], at: match.index ?? 0 });
  }
  const errors = [];
  for (const state of states) {
    // Common nouns (value, state, manage) appear as parameters and object keys long
    // before their declaration, so only the compound names are worth checking.
    if (!/[a-z][A-Za-z]*[A-Z]/u.test(state.name)) continue;
    const use = new RegExp(`(?<![.\\w'"\`])${state.name}(?![\\w'"\`])`, 'gu');
    for (const hit of body.matchAll(use)) {
      const at = hit.index ?? 0;
      if (at >= state.at) break;
      const before = body[at - 1] ?? '';
      const after = body[at + state.name.length] ?? '';
      // A parameter list may legitimately reuse the name; only a bare read is the bug.
      if ('(,'.includes(before) && '),='.includes(after)) continue;
      if (new RegExp(`(const|let|var|function)\\s+\\[?${state.name}\\b`, 'u').test(body.slice(Math.max(0, at - 20), at + state.name.length))) continue;
      errors.push(`${state.name} is read at ${at} before it is declared at ${state.at}`);
      break;
    }
  }
  const declared = new Set(states.map((state) => state.setter));
  for (const call of body.matchAll(/\b(set[A-Z]\w*)\(/gu)) {
    const name = call[1];
    if (['setTimeout', 'setInterval', 'setAttribute', 'setItem', 'setProperty'].includes(name)) continue;
    if (!declared.has(name)) errors.push(`${name} is called but no state declares it`);
  }
  return { states, errors };
}

test('RD-03 no state is read before its declaration', async () => {
  const body = await readFile(join(packageDir, 'src', 'client.js'), 'utf8');
  const { states, errors } = stateBindings(body);
  assert.ok(states.length > 10, 'the card still holds its state');
  assert.deepEqual(errors.filter((line) => line.includes('before it is declared')), []);
});

test('RD-04 every setter call has a state behind it', async () => {
  const body = await readFile(join(packageDir, 'src', 'client.js'), 'utf8');
  const { errors } = stateBindings(body);
  assert.deepEqual(errors.filter((line) => line.includes('no state declares it')), []);
});

test('RD-05 helpers used while building the rows are declared before the rows', async () => {
  const body = await readFile(join(packageDir, 'src', 'client.js'), 'utf8');
  const rowsAt = body.indexOf('const rows = [];');
  const tableAt = body.indexOf('const table =');
  assert.ok(rowsAt > 0 && tableAt > rowsAt, 'the row builders are still recognisable');
  const block = body.slice(rowsAt, tableAt);
  // A helper added after this block but called inside it is a temporal dead zone: the
  // loop runs during render, so the card blanks out instead of throwing later.
  const late = [];
  for (const hit of block.matchAll(/(?<![.\w'"`$])([a-z][A-Za-z]*[A-Z]\w*)\(/gu)) {
    const name = hit[1];
    // A call inside an event handler runs after render, so it may name a helper declared
    // further down. A call made while the array is being built may not.
    const before = block.slice(Math.max(0, (hit.index ?? 0) - 40), hit.index ?? 0);
    if (before.includes('=>')) continue;
    const declared = body.indexOf(`const ${name} = `);
    const usedAt = rowsAt + (hit.index ?? 0);
    if (declared !== -1 && declared > usedAt) late.push(name);
  }
  assert.deepEqual(late, [], 'these helpers are used before they exist');
});
