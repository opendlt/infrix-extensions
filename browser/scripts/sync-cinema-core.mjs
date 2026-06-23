// Copyright 2024 The Infrix Authors
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.

// Sync the canonical Cinema core into the extension from @infrix/cinema-core.
//
// The browser extension is a separately-packaged artifact, so it ships a
// BYTE-IDENTICAL mirror of the @infrix/cinema-core package (classic scripts +
// css; the ESM loader.js is excluded — the extension loads the classic scripts
// directly). Rather than fork a second renderer, it mirrors the canonical core
// and verifies the copy with tests/cinema_core_mirror.test.mjs — there is
// exactly one Cinema implementation. Run whenever the package updates:
//
//   node scripts/sync-cinema-core.mjs

import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.dirname(here);
// Source of truth: the @infrix/cinema-core package (a devDependency).
const src = path.dirname(require.resolve('@infrix/cinema-core/package.json'));
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

await mkdir(dest, { recursive: true });
let n = 0;
for (const f of MIRROR) {
  const body = await readFile(path.join(src, f), 'utf8');
  // The mirror is byte-identical to the source (the fence compares raw bytes).
  await writeFile(path.join(dest, f), body);
  n++;
}
process.stderr.write(`[sync-cinema-core] mirrored ${n} files from @infrix/cinema-core into cinema-core/\n`);

// Sanity: warn if the package has browser-mountable files the mirror list omits.
const present = new Set(await readdir(src));
for (const f of present) {
  if (f === 'loader.js') continue;
  if ((f.endsWith('.js') || f.endsWith('.css')) && !MIRROR.includes(f)) {
    process.stderr.write(`[sync-cinema-core] WARNING: ${f} exists in @infrix/cinema-core but is not in the mirror list\n`);
  }
}
