// Priority 05 — the extension's Cinema core is a verified mirror.
//
// The extension ships a copy of the canonical Cinema core (cinema-core/) so the
// popup can mount it without a build step. This fence guarantees the copy is
// BYTE-IDENTICAL to the source of truth (pkg/nexus/web/cinema-core) — there is
// exactly one Cinema implementation, and the mirror can never silently drift.
// If this fails, run: node extension/scripts/sync-cinema-core.mjs

import test from 'node:test';
import { strict as assert } from 'node:assert';
import { readFile, readdir, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.dirname(here);
const repoRoot = path.dirname(extensionRoot);
const srcDir = path.join(repoRoot, 'pkg', 'nexus', 'web', 'cinema-core');
const mirrorDir = path.join(extensionRoot, 'cinema-core');

const MIRROR = [
  'visualVocabulary.js', 'disclosureView.js', 'renderer.js', 'dataSources.js',
  'detailsPanel.js', 'controls.js', 'timelineAdapter.js', 'legend.js',
  'exportPanel.js', 'proofPanel.js',
  'narrativeTemplates.js', 'narrativePanel.js', 'narrativeSync.js',
  'app.js',
  'cinemaTokens.css', 'styles.css',
];

test('extension cinema-core mirror is byte-identical to the canonical core', async () => {
  for (const f of MIRROR) {
    const a = await readFile(path.join(srcDir, f));
    const b = await readFile(path.join(mirrorDir, f));
    assert.ok(a.equals(b), `extension/cinema-core/${f} drifted from pkg/nexus/web/cinema-core/${f} — run node extension/scripts/sync-cinema-core.mjs`);
  }
});

test('extension does not ship the ESM loader (classic scripts only)', async () => {
  let present = true;
  try { await access(path.join(mirrorDir, 'loader.js')); } catch { present = false; }
  assert.equal(present, false, 'the extension mirror must not include loader.js (it loads classic scripts directly)');
});

test('the mirror covers every browser-mountable core file', async () => {
  const srcFiles = (await readdir(srcDir)).filter((f) => (f.endsWith('.js') || f.endsWith('.css')) && f !== 'loader.js');
  for (const f of srcFiles) {
    assert.ok(MIRROR.includes(f), `core file ${f} is not in the extension mirror list — add it to sync-cinema-core.mjs + this fence`);
  }
});
