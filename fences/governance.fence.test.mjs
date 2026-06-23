// Relocated VS Code "Infrix Governance Spine" fences (from the monorepo Go fences
// pkg/intent/g21_vscode_extension_fence and p2_004_vscode_smoke_test_fence). The
// monorepo-only halves (verify-js wiring) stay in the monorepo; these are the
// extension-internal structure + disclosure invariants.
//   node --test "fences/*.test.mjs"

import test from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ext = path.join(repo, 'vscode-governance');
const read = (rel) => readFileSync(path.join(ext, rel), 'utf8');

const REQUIRED_FILES = [
  'package.json', 'tsconfig.json', 'README.md',
  'src/extension.ts', 'src/api-client.ts', 'src/governance-tree.ts',
  'src/webviews/plan-view.ts', 'src/webviews/evidence-view.ts',
  // p2-004 test infra:
  'tests/tsconfig.json', 'tests/api-client.test.ts',
];
test('g21/p2-004: the governance-sidebar scaffold + test infra are present', () => {
  for (const rel of REQUIRED_FILES) {
    const full = path.join(ext, rel);
    assert.ok(existsSync(full), `missing required file: ${rel}`);
    assert.ok(statSync(full).size > 0, `required file is empty: ${rel}`);
  }
});

test('g21: manifest declares the infrix.governanceTree view + onView activation', () => {
  const pj = JSON.parse(read('package.json'));
  const views = pj.contributes?.views?.infrix || [];
  assert.ok(views.some((v) => v.id === 'infrix.governanceTree'), 'manifest missing infrix.governanceTree view');
  const events = pj.activationEvents || [];
  assert.ok(events.includes('onView:infrix.governanceTree'), "manifest missing 'onView:infrix.governanceTree' activation event");
});

test('p2-004: package.json exposes build + node --test, and the workflowInstance setting', () => {
  const pj = JSON.parse(read('package.json'));
  for (const s of ['build', 'test']) assert.ok(pj.scripts?.[s], `package.json missing script: ${s}`);
  assert.ok(pj.scripts.test.includes('node --test'), `npm test must invoke node --test; got "${pj.scripts.test}"`);
  assert.ok(pj.contributes?.configuration?.properties?.['infrix.workflowInstance'], 'manifest must contribute the infrix.workflowInstance setting');
});

test('g21/p2-004: api-client injects the disclosure trio + isConnected guard', () => {
  const src = read('src/api-client.ts');
  for (const h of ['"X-Actor"', '"X-Purpose"', '"X-Workflow-Instance"']) {
    assert.ok(src.includes(h), `api-client.ts missing disclosure header ${h}`);
  }
  assert.ok(src.includes('isConnected'), 'api-client.ts missing isConnected guard');
});

test('g21: README keeps the governance-first framing', () => {
  const src = read('README.md');
  for (const want of ['Governance Spine', 'sidebar', 'X-Actor']) {
    assert.ok(src.includes(want), `README missing ${want}`);
  }
});
