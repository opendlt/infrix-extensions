// Copyright 2024 The Infrix Authors
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.

// Fail fast if browser/cinema-core/ has drifted from canonical @infrix/cinema-core.
//
// This is the enforcement entry point used by the pre-commit hook and CI
// (npm run vendor:check). It reuses the SAME comparison the sync uses
// (computeMirrorPlan), so "the check passes" is exactly "the sync would change
// nothing".
//
//   - drift found            → print the offending files + remedy, exit 1
//   - in sync                → print OK, exit 0
//   - canonical unresolvable → print a skip notice, exit 0
//
// The unresolvable case skips (rather than fails) so a checkout that lacks the
// canonical source — e.g. a clone of infrix-extensions without the sibling repo
// — does not block unrelated commits. CI provides INFRIX_CINEMA_CORE_SRC, so the
// gate still enforces there regardless of publishing.

import {
  resolveSrcForCheck, mirrorDir, computeMirrorPlan, planHasDrift, popupBlockStatus,
} from './cinema-mirror-manifest.mjs';

// When INFRIX_CINEMA_CORE_SRC is set, resolution must succeed — a bad path
// fails the gate (exit 1) rather than skipping it. Otherwise resolution is
// best-effort and an unresolvable source skips gracefully.
let resolved;
try {
  resolved = resolveSrcForCheck();
} catch (e) {
  process.stderr.write(`[check-cinema-mirror] ${e.message}\n`);
  process.exit(1);
}

if (!resolved) {
  process.stderr.write(
    '[check-cinema-mirror] @infrix/cinema-core not resolvable — cannot verify the mirror; skipping. ' +
    'Set INFRIX_CINEMA_CORE_SRC or place the infrix-cinema-core repo as a sibling to enforce locally.\n',
  );
  process.exit(0);
}

const plan = await computeMirrorPlan(resolved.dir, mirrorDir);
const popup = await popupBlockStatus(resolved.dir);
const drift = planHasDrift(plan) || !popup.current;

if (drift) {
  process.stderr.write(`[check-cinema-mirror] DRIFT — extension is out of sync with canonical (via ${resolved.via}):\n`);
  for (const f of plan.add) process.stderr.write(`  missing (canonical has, mirror lacks): ${f}\n`);
  for (const f of plan.update) process.stderr.write(`  changed (bytes differ):               ${f}\n`);
  for (const f of plan.remove) process.stderr.write(`  stale   (mirror has, canonical lacks): ${f}\n`);
  if (!popup.current) process.stderr.write('  popup.html load block does not match the canonical loader order\n');
  process.stderr.write('\nFix: npm run vendor   (then commit the regenerated cinema-core/ + popup.html)\n');
  process.exit(1);
}

process.stderr.write(
  `[check-cinema-mirror] OK — cinema-core/ is byte-identical to canonical and popup.html load block is current ` +
  `(${plan.want.length} files, ${popup.scripts} scripts + ${popup.styles} styles, via ${resolved.via}).\n`,
);
