/**
 * Test helpers shared by the runtime and surface suites.
 *
 * A catalog is written through the same pure builder the card uses, never by
 * hand, so the tests exercise the real schema path.
 * @module file-maid/test/helpers
 */
import { validateCatalog } from '../src/core/catalog.js';
import * as store from '../src/state/store.js';

/** A four-directory catalog shaped like the real workspace. */
export const WORKSPACE_DIRS = Object.freeze([
  { path: '00-Specs', purpose: '工作区通用规范文件；制作标准', excludes: ['草稿'] },
  { path: '10-Projects', purpose: '进行中的项目；一个项目一个编号目录', excludes: [] },
  { path: '30-Media', purpose: '图片、音视频与其它媒体素材', excludes: [] },
  { path: '80-Outputs', purpose: '非项目输出物的默认落点', excludes: [] },
]);

/**
 * Build one catalog document.
 * @param {object} [overrides] - fields to replace.
 * @returns {object} the document.
 */
export function catalogDocument(overrides = {}) {
  return {
    version: 1,
    root_default: '80-Outputs',
    dirs: WORKSPACE_DIRS.map((dir) => ({ ...dir, excludes: [...dir.excludes], examples: [] })),
    rules: [],
    ...overrides,
  };
}

/**
 * Validate one catalog document or fail loudly.
 * @param {object} document - catalog document.
 * @returns {object} the validated catalog.
 */
export function validCatalog(document = catalogDocument()) {
  const verdict = validateCatalog(document);
  if (!verdict.ok) throw new Error(`invalid test catalog: ${JSON.stringify(verdict.errors)}`);
  return verdict.catalog;
}

/**
 * Write a catalog for one root and run its baseline scan.
 * @param {object} roots - runtime registry.
 * @param {object} agent - an agent whose session points at the root.
 * @param {object} [document] - catalog document.
 * @returns {Promise<{ entry: object, catalog: object }>} the entry and its catalog.
 */
export async function seed(roots, agent, document = catalogDocument()) {
  const entry = roots.acquire(agent);
  if (entry === undefined) throw new Error('seed failed: the agent has no session cwd');
  const catalog = validCatalog(document);
  await store.writeCatalog(entry.root, store.serializeCatalog(catalog, { root: entry.root }));
  await roots.load(entry);
  await roots.scan(entry, 'test');
  return { entry, catalog };
}
