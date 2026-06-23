// Priority 05 — the extension's Cinema core is a verified mirror of @infrix/cinema-core.
//
// The extension ships a copy of the canonical Cinema core (cinema-core/) so the
// popup can mount it without a build step. This fence guarantees the copy stays
// BYTE-IDENTICAL to the @infrix/cinema-core package — exactly one Cinema
// implementation, no silent drift. If it fails: node scripts/sync-cinema-core.mjs
//
// @infrix/cinema-core is a devDependency. When it is not installed, the byte-drift
// checks SKIP (the committed mirror still ships and the popup tests exercise it);
// the drift check enforces once the package is present (CI installs it).

import test from 'node:test';
import { strict as assert } from 'node:assert';
import { readFile, readdir, access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.dirname(here);
const mirrorDir = path.join(extensionRoot, 'cinema-core');

const require = createRequire(import.meta.url);
let srcDir = null;
try {
  srcDir = path.dirname(require.resolve('@infrix/cinema-core/package.json'));
} catch {
  srcDir = null;
}
const skip = srcDir ? false : '@infrix/cinema-core not installed — drift check skipped';

const MIRROR = [
  'visualVocabulary.js', 'disclosureView.js', 'renderer.js', 'dataSources.js',
  'detailsPanel.js', 'controls.js', 'timelineAdapter.js', 'legend.js',
  'exportPanel.js', 'proofPanel.js',
  'narrativeTemplates.js', 'narrativePanel.js', 'narrativeSync.js',
  'app.js',
  'cinemaTokens.css', 'styles.css',
];

test('extension cinema-core mirror is byte-identical to @infrix/cinema-core', { skip }, async () => {
  for (const f of MIRROR) {
    const a = await readFile(path.join(srcDir, f));
    const b = await readFile(path.join(mirrorDir, f));
    assert.ok(a.equals(b), `cinema-core/${f} drifted from @infrix/cinema-core/${f} — run node scripts/sync-cinema-core.mjs`);
  }
});

test('extension does not ship the ESM loader (classic scripts only)', async () => {
  let present = true;
  try { await access(path.join(mirrorDir, 'loader.js')); } catch { present = false; }
  assert.equal(present, false, 'the extension mirror must not include loader.js (it loads classic scripts directly)');
});

test('the mirror covers every browser-mountable core file', { skip }, async () => {
  const srcFiles = (await readdir(srcDir)).filter((f) => (f.endsWith('.js') || f.endsWith('.css')) && f !== 'loader.js');
  for (const f of srcFiles) {
    assert.ok(MIRROR.includes(f), `core file ${f} is not in the extension mirror list — add it to sync-cinema-core.mjs + this fence`);
  }
});
