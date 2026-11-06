/**
 * Pure core: catalog validation (`C-*`), the three-level decision (`D-*`),
 * text folding (`X-*`) and reconciliation (`R-*`).
 * @module file-maid/test/core
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { validateCatalog } from '../src/core/catalog.js';
import { checkName, decide } from '../src/core/decide.js';
import { reconcile } from '../src/core/reconcile.js';
import { sessionTail } from '../src/core/text.js';
import { catalogDocument, validCatalog } from './helpers.js';

/**
 * Build one valid catalog document.
 * @param {object} [overrides] - fields to replace.
 * @returns {object} the document.
 */
function document(overrides = {}) {
  return catalogDocument(overrides);
}

test('C-01 a complete catalog validates and normalizes', () => {
  const verdict = validateCatalog(document());
  assert.equal(verdict.ok, true);
  assert.equal(verdict.catalog.rootDefault, '80-Outputs');
  assert.deepEqual(
    verdict.catalog.dirs.map((dir) => dir.path),
    ['00-Specs', '10-Projects', '30-Media', '80-Outputs'],
  );
});

test('C-02 version must be 1', () => {
  const verdict = validateCatalog(document({ version: 2 }));
  assert.equal(verdict.ok, false);
  assert.equal(verdict.errors[0].code, 'E_MAID_SCHEMA');
});

test('C-03 dirs must be non-empty and paths unique', () => {
  assert.equal(validateCatalog(document({ dirs: [] })).ok, false);
  const duplicate = document();
  duplicate.dirs.push({ ...duplicate.dirs[0] });
  const verdict = validateCatalog(duplicate);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.errors[0].code, 'E_MAID_PATH');
});

test('C-03b a retired role field is accepted and never written back', async () => {
  const doc = document();
  doc.dirs[0].role = 'autonomous';
  const verdict = validateCatalog(doc);
  assert.equal(verdict.ok, true, 'an older catalog keeps loading');
  assert.equal('role' in verdict.catalog.dirs[0], false, 'the projection carries no role');
});

test('C-04 root_default must be one of the declared directories', () => {
  assert.equal(validateCatalog(document({ root_default: '90-Missing' })).ok, false);
  const anyDir = document();
  anyDir.root_default = '10-Projects';
  assert.equal(validateCatalog(anyDir).ok, true, 'any declared directory can be the default');
});

test('C-05 an empty purpose loads with a warning', () => {
  const doc = document();
  doc.dirs[2].purpose = '';
  const verdict = validateCatalog(doc);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.warnings.some((entry) => entry.code === 'E_MAID_PURPOSE_MISSING'), true);
});

test('C-06 a rule pointing at an undeclared directory is dropped', () => {
  const verdict = validateCatalog(document({ rules: [{ match: '报告', dir: '99-Nowhere' }] }));
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.catalog.rules, []);
  assert.equal(verdict.warnings.some((entry) => entry.code === 'E_MAID_SCHEMA'), true);
});

test('C-07 path traversal and reserved segments are refused', () => {
  for (const path of ['../escape', '.maid', '00-Specs/../../x', 'a/b/c/d']) {
    const doc = document();
    doc.dirs[0].path = path;
    assert.equal(validateCatalog(doc).ok, false, `expected refusal for ${path}`);
  }
});

test('C-08 naming declarations are reported as not implemented', () => {
  const verdict = validateCatalog(document({ naming: { pattern: '^[a-z]+$' } }));
  assert.equal(verdict.ok, true);
  assert.equal(verdict.warnings.some((entry) => entry.code === 'E_MAID_NOT_IMPLEMENTED'), true);
});

test('D-01 a rule wins over the caller directory and reports overridden', () => {
  const catalog = validCatalog(document({ rules: [{ match: '规范', dir: '00-Specs' }] }));
  const decision = decide({ catalog, name: '规范附录.md', intent: '写规范', dir: '80-Outputs' });
  assert.equal(decision.ok, true);
  assert.equal(decision.dir, '00-Specs');
  assert.equal(decision.decided_by, 'rule');
  assert.equal(decision.overridden, true);
});

test('D-02 the caller directory wins over the default', () => {
  const catalog = validCatalog(document());
  const decision = decide({ catalog, name: 'a.md', intent: '项目里的事', dir: '10-Projects' });
  assert.equal(decision.dir, '10-Projects');
  assert.equal(decision.decided_by, 'agent');
  assert.equal(decision.overridden, false);
});

test('D-03 the default catches everything else', () => {
  const catalog = validCatalog(document());
  const decision = decide({ catalog, name: 'a.md', intent: '随手记' });
  assert.equal(decision.dir, '80-Outputs');
  assert.equal(decision.decided_by, 'default');
});

test('D-04 an undeclared caller directory is refused, not defaulted', () => {
  const catalog = validCatalog(document());
  const decision = decide({ catalog, name: 'a.md', dir: '99-Nowhere' });
  assert.equal(decision.ok, false);
  assert.equal(decision.code, 'E_MAID_DIR');
});

test('D-05 candidates rank accepted purposes above refused ones', () => {
  const catalog = validCatalog(document({ rules: [] }));
  const decision = decide({ catalog, name: '规范草稿.md', intent: '这是一份草稿规范' });
  assert.equal(decision.ok, true);
  assert.equal(decision.candidates[0].dir, '00-Specs');
});

test('D-06 a file name alone can trigger a rule', () => {
  const catalog = validCatalog(document({ rules: [{ match: 'report', dir: '80-Outputs' }] }));
  const decision = decide({ catalog, name: 'report-2026.md' });
  assert.equal(decision.decided_by, 'rule');
  assert.equal(decision.dir, '80-Outputs');
});

test('D-07 names that could escape the directory are refused', () => {
  for (const name of ['../x.md', 'a/b.md', '..', '.maid', '']) {
    assert.equal(checkName(name).ok, false, `expected refusal for ${name}`);
  }
  assert.equal(checkName('ok.md').ok, true);
});

test('X-01 the session tail keeps the newest text within one fence', () => {
  const messages = [{ content: 'old' }, { content: [{ type: 'text', text: 'newer' }] }, { content: 'newest' }];
  assert.equal(sessionTail(messages, 12), 'newer\nnewest');
  assert.equal(sessionTail([], 10), '');
});

test('R-01 the gap is new files minus recorded writes', () => {
  const result = reconcile({
    before: { files: 10, dirs: { '00-Specs': 4, '80-Outputs': 6 } },
    after: { files: 15, dirs: { '00-Specs': 4, '80-Outputs': 11 } },
    recorded: 3,
  });
  assert.equal(result.new_files, 5);
  assert.equal(result.recorded, 3);
  assert.equal(result.gap, 2);
  assert.equal(result.gap_ratio, 0.4);
  assert.deepEqual(result.top_dirs, [{ dir: '80-Outputs', added: 5 }]);
});

test('R-02 the first scan is a baseline and reports no gap', () => {
  const result = reconcile({ after: { files: 5, dirs: { A: 5 } }, recorded: 0 });
  assert.equal(result.baseline, true);
  assert.equal(result.gap, 0);
});

test('R-03 deletions never produce a negative gap', () => {
  const result = reconcile({
    before: { files: 10, dirs: { A: 10 } },
    after: { files: 4, dirs: { A: 4 } },
    recorded: 0,
  });
  assert.equal(result.new_files, 0);
  assert.equal(result.gap, 0);
});

test('R-04 a quiet window reports a zero gap', () => {
  const same = { files: 3, dirs: { A: 3 } };
  const result = reconcile({ before: same, after: { ...same, dirs: { A: 3 } }, recorded: 0 });
  assert.equal(result.new_files, 0);
  assert.equal(result.gap_ratio, 0);
  assert.deepEqual(result.top_dirs, []);
});

test('C-09 a purpose or excludes sentence has a length ceiling', async () => {
  const base = { version: 1, root_default: '80-Outputs', dirs: [], rules: [] };
  const long = '很'.repeat(201);
  const dir = (extra) => ({ path: '80-Outputs', purpose: '收东西', excludes: '', ...extra });

  const ok = validateCatalog({ ...base, dirs: [dir({ purpose: '很'.repeat(200) })] });
  assert.equal(ok.ok, true, 'exactly at the ceiling still loads');

  const tooLong = validateCatalog({ ...base, dirs: [dir({ purpose: long })] });
  assert.equal(tooLong.ok, false);
  assert.equal(tooLong.errors[0].code, 'E_MAID_PURPOSE_LONG');

  const excludes = validateCatalog({ ...base, dirs: [dir({ excludes: long })] });
  assert.equal(excludes.ok, false);
  assert.equal(excludes.errors[0].code, 'E_MAID_EXCLUDES_LONG');
});
