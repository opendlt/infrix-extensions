// Copyright 2024 The Infrix Authors
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.

// Sync the canonical Cinema core into the extension from @infrix/cinema-core.
//
// The browser extension is a separately-packaged artifact, so it ships a
// BYTE-IDENTICAL mirror of the @infrix/cinema-core browser-mountable core
// (classic scripts + css; the ESM loader.js is excluded — the extension loads
// the classic scripts directly). Rather than fork a second renderer, it mirrors
// the canonical core and verifies the copy with tests/cinema_core_mirror.test.mjs
// — there is exactly one Cinema implementation.
//
// The file set is DERIVED from the canonical package (every mountable asset),
// not hand-enumerated, so a new canonical module can never be silently missed.
// The mirror directory is fully regenerated and pruned to match canonical.
//
//   node scripts/sync-cinema-core.mjs            # mirror
//   node scripts/sync-cinema-core.mjs --dry-run  # report only, write nothing

import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import {
  resolveSrc, mirrorDir, computeMirrorPlan, normalizeLF,
  parseLoaderOrder, renderPopupCinemaBlock, replacePopupCinemaBlock,
  POPUP_BLOCK_BEGIN, cinemaHtmlTargets,
} from './cinema-mirror-manifest.mjs';

// --dry-run reports every action it would take without writing or deleting
// anything — a safe pre-flight and the way to verify source resolution in
// isolation.
const DRY_RUN = process.argv.includes('--dry-run');

const resolved = resolveSrc();
const src = resolved.dir;
const dest = mirrorDir;
process.stderr.write(`[sync-cinema-core] source: ${src} (via ${resolved.via})${DRY_RUN ? ' [DRY RUN]' : ''}\n`);

if (!DRY_RUN) await mkdir(dest, { recursive: true });

const plan = await computeMirrorPlan(src, dest);

// ---- Copy / update every changed mountable canonical asset (byte-identical). ----
for (const f of [...plan.add, ...plan.update]) {
  const verb = plan.add.includes(f) ? 'add   ' : 'update';
  if (DRY_RUN) {
    process.stderr.write(`[sync-cinema-core]   ${verb} ${f}\n`);
  } else {
    // Write LF-normalized so the mirror is platform-deterministic (see normalizeLF).
    await writeFile(path.join(dest, f), normalizeLF(await readFile(path.join(src, f))), 'utf8');
  }
}

// ---- Prune core assets the mirror has but canonical no longer does. ----
// Only .js/.css files are eligible (computeMirrorPlan.remove); unrelated files
// are never touched. A stale module, a renamed file, or a stray loader.js all
// get removed so the mirror is EXACTLY canonical's mountable set.
for (const f of plan.remove) {
  if (DRY_RUN) {
    process.stderr.write(`[sync-cinema-core]   remove ${f} (no longer in canonical)\n`);
  } else {
    await unlink(path.join(dest, f));
  }
}

process.stderr.write(
  `[sync-cinema-core] ${DRY_RUN ? 'would apply' : 'applied'}: ` +
  `${plan.add.length} added, ${plan.update.length} updated, ${plan.remove.length} removed, ` +
  `${plan.unchanged.length} unchanged (${plan.want.length} mountable files in canonical)\n`,
);

// ---- Regenerate the cinema-core load block in every host page. ----
// The set of files is mirrored above; this guarantees each host page (the
// popup and the expanded console) actually LOADS every mirrored module, in the
// canonical loader's dependency order (app.js last). The block lives between
// the cinema-core:begin/end markers; everything else in the page is untouched.
const order = await parseLoaderOrder(src);
const block = renderPopupCinemaBlock(order);
for (const target of cinemaHtmlTargets()) {
  const name = path.basename(target);
  const html = normalizeLF(await readFile(target));
  if (html.indexOf(POPUP_BLOCK_BEGIN) === -1) {
    process.stderr.write(`[sync-cinema-core] ${name}: no cinema-core markers — skipped\n`);
    continue;
  }
  const next = replacePopupCinemaBlock(html, block);
  if (next === html) {
    process.stderr.write(`[sync-cinema-core] ${name} load block already current\n`);
  } else if (DRY_RUN) {
    process.stderr.write(`[sync-cinema-core]   would update ${name} load block (${order.scripts.length} scripts, ${order.styles.length} styles)\n`);
  } else {
    await writeFile(target, next, 'utf8');
    process.stderr.write(`[sync-cinema-core] updated ${name} load block (${order.scripts.length} scripts, ${order.styles.length} styles)\n`);
  }
}
