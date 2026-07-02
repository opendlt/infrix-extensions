# Wallet runbooks

Execution playbooks that resolve every issue from the `browser/wallet/` review
(keystore + hardware). Each runbook is PR-sized, independently verifiable, and
written to be run **one at a time** in the listed order (dependencies are
explicit). When a runbook is done, every box in its **Definition of Done** is
checked and its **Verification** commands are green.

## Standing conventions (apply to every runbook)

- **Branch:** work on `tier0-schema-extraction` (or a child branch); never commit
  straight to `main`.
- **Commits:** one-line messages, no co-author / Claude trailer (house style).
- **Never edit `browser/cinema-core/`** — it is the generated mirror. After any
  change, `npm run vendor:check` must still report the mirror byte-identical and
  both host pages in sync.
- **Permission lock:** `manifest.json` permissions must stay `["storage","activeTab"]`
  and host_permissions localhost-only (enforced by `tests/manifest.test.mjs`). A
  runbook that genuinely needs a new permission must change that fence
  deliberately and say so in its steps — not drift it.
- **Fences:** `tests/cinema_core_mirror.test.mjs`, `fences/browser.fence.test.mjs`
  (Gap-15 / P3-20 tokens), and the popup-boot smoke must stay green.
- **Gate before "done":** from `browser/`
  ```
  npm run build        # lint
  npm test             # full unit suite (add the runbook's new tests)
  npm run vendor:check  # cinema mirror untouched
  ( cd .. && npm run test:fences )
  ```

## Execution order & dependencies

| # | Runbook | Resolves (review §) | Depends on |
|---|---------|---------------------|------------|
| WB-01 | Keystore crypto hardening (AAD + zeroize-on-rotate + v2 migration) | 1.6, 3.1, 3.2, 1.7(part) | — |
| WB-02 | Encrypted backup: export / import / restore + "back up" nudge | 1.5(a), 2.3(a) | WB-01 |
| WB-03 | Seed-phrase recovery (BIP39 + SLIP-0010) + restore-from-seed | 1.5(b), 2.3(b) | WB-01, WB-02 |
| WB-04 | Unlocked-session signing + visible auto-lock + lock controls | 1.4, 2.2 | WB-01 |
| WB-05 | Change passphrase (wire `rotate`) | 1.3(a), 2.5 | WB-01, WB-04 |
| WB-06 | Signing-locus refactor (popup-orchestrated signer seam) | 1.2(arch) | WB-04 |
| WB-07 | Ledger governed approval (real transport + pairing + device-confirm) | 1.1, 1.2(ledger), 2.1 | WB-06 |
| WB-08 | YubiKey honest role (2FA-unlock; optional WebAuthn-signer) | 1.1, 1.2(yubikey), 2.1 | WB-06 |
| WB-09 | Key identity (labels, per-key identicon, last-used, purpose scopes) | 2.4 | WB-01 |
| WB-10 | Signing transparency (exact-bytes display, single chokepoint) | 2.6, 1.3(lock-state) | WB-04 |
| WB-11 | Hardware honesty + test-confidence (interim quarantine, contract-test labels, keystore idle/zeroize/lock tests) | 1.1, 1.7, 3.4, 3.5 | — (run WB-11 §A first; §B after WB-07/08) |

**Recommended cadence:** WB-11 §A (honesty stopgap, ~30 min) → WB-01 → WB-02 →
WB-03 → WB-04 → WB-05 → WB-09 → WB-10 → WB-06 → WB-07 → WB-08 → WB-11 §B.

Safety (WB-01/02/03) first because unbacked keys are an active liability; the
hardware superpower (WB-06/07/08) is the largest effort and touches the build
and possibly the backend verifier.

## Traceability — every review issue maps to a runbook

- **1.1** hardware dead/unwired → WB-07 + WB-08 (wire it); WB-11§A (interim honesty)
- **1.2** drivers can't run (MV3 ctx / WebAuthn semantics / rpId / Ledger BIP32) → WB-06 (ctx), WB-07 (Ledger), WB-08 (YubiKey/rpId)
- **1.3** no change-passphrase / lock config / lock-state → WB-05 (rotate), WB-04 (timeout + state)
- **1.4** 600k PBKDF2 per sign + auto-lock bypassed → WB-04
- **1.5** no recovery/backup → WB-02 (export/import) + WB-03 (seed phrase)
- **1.6** rotate no-zeroize / no AAD / timer caveat → WB-01
- **1.7** test gaps → WB-01 (crypto), WB-04 (idle-lock), WB-11§B (hardware reality)
- **2.1** hardware governed approval → WB-06 + WB-07 + WB-08
- **2.2** unlocked-session + visible lock → WB-04
- **2.3** recovery & backup → WB-02 + WB-03
- **2.4** key identity → WB-09
- **2.5** change passphrase → WB-05
- **2.6** signing transparency → WB-10 (+ AAD from WB-01)
- **3.1/3.2** zeroize/AAD → WB-01
- **3.4** quarantine vs wire hardware → WB-11§A then WB-07/08
- **3.5** test additions → folded into each runbook + WB-11§B
