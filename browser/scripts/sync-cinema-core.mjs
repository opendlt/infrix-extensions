// Copyright 2024 The Infrix Authors
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.

// Priority 05 — sync the canonical Cinema core into the extension.
//
// The browser extension is a separately-packaged artifact, so it cannot load
// the core by relative path at runtime. Rather than fork a second renderer,
// it ships a BYTE-IDENTICAL mirror of pkg/nexus/web/cinema-core, produced by
// this script and verified by tests/cinema_core_mirror.test.mjs. Run it
// whenever the canonical core changes:
//
//   node extension/scripts/sync-cinema-core.mjs
//
// The mirror is the SAME code Nexus, the standalone product, and the portable
// proof viewer mount — there is exactly one Cinema implementation.

import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.dirname(here);
const repoRoot = path.dirname(extensionRoot);
const src = path.join(repoRoot, 'pkg', 'nexus', 'web', 'cinema-core');
const dest = path.join(extensionRoot, 'cinema-core');

// Only the browser-mountable core (classic scripts + css). The ESM loader.js
// is excluded — the extension loads the classic scripts directly.
const MIRROR = [
  'visualVocabulary.js', 'disclosureView.js', 'renderer.js', 'dataSources.js',
  'detailsPanel.js', 'controls.js', 'timelineAdapter.js', 'legend.js',
  'exportPanel.js', 'proofPanel.js',
  'narrativeTemplates.js', 'narrativePanel.js', 'narrativeSync.js',
  'app.js',
  'cinemaTokens.css', 'styles.css',
];

const banner = '/* GENERATED MIRROR — do not edit. Source of truth: pkg/nexus/web/cinema-core.\n   Regenerate with: node extension/scripts/sync-cinema-core.mjs */\n';

await mkdir(dest, { recursive: true });
let n = 0;
for (const f of MIRROR) {
  const body = await readFile(path.join(src, f), 'utf8');
  // The mirror is byte-identical to the source (the fence compares raw bytes).
  await writeFile(path.join(dest, f), body);
  n++;
}
process.stderr.write(`[sync-cinema-core] mirrored ${n} files into extension/cinema-core/\n`);

// Sanity: warn if the source has files the mirror list does not cover.
const present = new Set(await readdir(src));
for (const f of present) {
  if (f === 'loader.js') continue;
  if ((f.endsWith('.js') || f.endsWith('.css')) && !MIRROR.includes(f)) {
    process.stderr.write(`[sync-cinema-core] WARNING: ${f} exists in source but is not in the mirror list\n`);
  }
}
void banner;
