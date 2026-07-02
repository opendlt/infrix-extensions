// Priority 05 — the extension's Cinema core is a verified mirror of @infrix/cinema-core.
//
// The extension ships a copy of the canonical Cinema core (cinema-core/) so the
// popup can mount it without a build step. This fence guarantees the copy stays
// BYTE-IDENTICAL to the @infrix/cinema-core browser-mountable core — exactly one
// Cinema implementation, no silent drift. If it fails: npm run vendor
//
// The file set and the comparison are DERIVED from the canonical package via the
// shared manifest (scripts/cinema-mirror-manifest.mjs) — the same module the
// sync script uses — so the fence and the sync can never disagree about what
// "the mirror" is. There is no hand-maintained list to fall behind.
//
// Source resolution is local-first (INFRIX_CINEMA_CORE_SRC → installed package →
// sibling working copy). When NONE resolve the byte checks SKIP (the committed
// mirror still ships and the popup tests exercise it); CI sets
// INFRIX_CINEMA_CORE_SRC so the fence enforces independently of publishing.

import test from 'node:test';
import { strict as assert } from 'node:assert';
import { access } from 'node:fs/promises';
import path from 'node:path';
import {
  resolveSrcForCheck, mirrorDir, computeMirrorPlan, htmlBlocksStatus,
} from '../scripts/cinema-mirror-manifest.mjs';

// If INFRIX_CINEMA_CORE_SRC is explicitly set this throws on a bad path (a
// misconfigured CI fails loudly rather than skipping). Otherwise it is
// best-effort and an unresolvable source skips the byte checks.
const resolved = resolveSrcForCheck();
const skip = resolved
  ? false
  : '@infrix/cinema-core not resolvable (no INFRIX_CINEMA_CORE_SRC, package, or sibling repo) — drift check skipped';

test('extension cinema-core mirror is byte-identical to @infrix/cinema-core', { skip }, async () => {
  const plan = await computeMirrorPlan(resolved.dir, mirrorDir);
  assert.deepEqual(
    plan.add, [],
    `mirror is MISSING canonical files — run npm run vendor: ${plan.add.join(', ')}`,
  );
  assert.deepEqual(
    plan.update, [],
    `mirror has DRIFTED from canonical — run npm run vendor: ${plan.update.join(', ')}`,
  );
});

test('extension cinema-core mirror ships no files canonical lacks', { skip }, async () => {
  const plan = await computeMirrorPlan(resolved.dir, mirrorDir);
  assert.deepEqual(
    plan.remove, [],
    `mirror has STALE files canonical no longer ships — run npm run vendor: ${plan.remove.join(', ')}`,
  );
});

test('extension does not ship the ESM loader (classic scripts only)', async () => {
  let present = true;
  try { await access(path.join(mirrorDir, 'loader.js')); } catch { present = false; }
  assert.equal(present, false, 'the extension mirror must not include loader.js (it loads classic scripts directly)');
});

test('cinema host pages load the full mirrored core in canonical loader order', { skip }, async () => {
  const status = await htmlBlocksStatus(resolved.dir);
  assert.equal(
    status.current, true,
    'a cinema host page load block is stale (' + status.stale.join(', ') + ') — run npm run vendor',
  );
});
