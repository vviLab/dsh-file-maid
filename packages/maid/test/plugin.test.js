/**
 * Assembly (`P-*`): what the plugin registers, and in what order it releases.
 * @module file-maid/test/plugin
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { apply, inject, name } from '../src/plugin.js';

/**
 * Build a context stub that records every registration.
 * @param {{ systemPrompt?: boolean }} [options] - service switches.
 * @returns {{ ctx: object, log: object }} the stub and its registration log.
 */
function stubContext(options = {}) {
  const log = { sections: [], tools: [], events: [], effects: 0, disposed: [] };
  const ctx = {
    logger: () => ({ debug() {}, warn() {} }),
    get: (id) => {
      if (id === 'workingDirectory') return { get: (session) => session?.header?.cwd };
      if (id === 'permissionPresets') return { current: () => 'workspace-write' };
      return undefined;
    },
    sessions: { get: () => ({ deriveMessages: () => [] }) },
    tools: {
      register(definition) {
        log.tools.push(definition.name);
        return () => log.disposed.push(definition.name);
      },
    },
    systemPrompt: {
      context(entry) {
        assert.equal(typeof entry.text, 'function');
        log.sections.push({ name: entry.name, order: entry.order });
        return () => log.disposed.push(entry.name);
      },
    },
    on(event, handler, prepend) {
      log.events.push({ event, prepend });
      return () => log.disposed.push(event);
    },
    effect(fn) {
      log.effects += 1;
      const dispose = fn();
      return () => {
        if (typeof dispose === 'function') dispose();
      };
    },
  };
  if (options.systemPrompt === false) delete ctx.systemPrompt;
  return { ctx, log };
}

test('PL-01 the plugin exports one name and the services it needs', () => {
  assert.equal(name, 'dsh-file-maid');
  assert.deepEqual(inject, ['tools', 'systemPrompt', 'sessions']);
});

test('PL-02 apply registers one prompt section, five tools, five hooks and two lifecycle handlers', () => {
  const { ctx, log } = stubContext();
  apply(ctx);
  assert.equal(log.effects, 1);
  assert.deepEqual(log.sections, [{ name: 'file-maid:catalog', order: 300 }]);
  assert.deepEqual(log.tools, ['maid_put', 'maid_route', 'maid_init', 'maid_review', 'maid_scan']);
  assert.deepEqual(
    log.events.map((entry) => entry.event).sort(),
    [
      'agent/created',
      'agent/disposed',
      'fs/delete-intent',
      'fs/edit-intent',
      'fs/observed',
      'fs/write-intent',
      'tools/pre-execute',
    ].sort(),
  );
  for (const entry of log.events) {
    // The ledger listener is a plain recorder: it must not run before the guard.
    const recorder = entry.event === 'fs/observed';
    const guard = entry.event.startsWith('fs/') || entry.event === 'tools/pre-execute';
    assert.equal(entry.prepend, recorder ? undefined : guard ? true : undefined, `${entry.event} prepend flag`);
  }
});

test('PL-03 a host without the prompt service fails the mount instead of loading silently', () => {
  const { ctx } = stubContext({ systemPrompt: false });
  assert.throws(() => apply(ctx), /systemPrompt\.context is unavailable/u);
});
