# WB-11 — Hardware honesty + test-confidence

**Resolves:** review §1.1, §1.7, §3.4, §3.5
**Depends on:** §A none (run first); §B after WB-07 + WB-08
**Scope:** `wallet/hardware/*.js`, `wallet/hardware/hardware.test.mjs`, `wallet/keystore.test.mjs`, `fences/browser.fence.test.mjs`
**Size:** §A S (30 min) · §B S (½ day)

## Goal
Stop green CI from implying hardware works while it's unwired/non-functional, and
close the keystore test gaps. Split into an immediate honesty stopgap (§A, run
before the hardware build) and a post-wiring reconciliation (§B).

## §A — Interim honesty (run FIRST, before WB-07/08)
1. **Mark the drivers as not-wired scaffolds.** Add a top-of-file banner to
   `hardware.js`, `ledger.js`, `yubikey.js`: "STATUS: NOT WIRED — contract sketch.
   Not used by the extension; see docs/runbooks/WB-06..08. `yubikey.sign` does NOT
   produce a chain-verifiable signature." (Matches reality from review §1.1/§1.2.)
2. **Relabel the tests as contract tests.** Rename the `hardware.test.mjs` suite
   header/describe to "hardware driver CONTRACT (scaffold) — not a real-device or
   on-chain-verification test", and add a comment that a passing run does **not**
   imply working hardware. Add a `// TODO(WB-07/08): replace with real-transport tests`.
3. **Add a fence** in `fences/browser.fence.test.mjs`: assert that no shipping
   (non-test) code imports the hardware drivers **until** a `HARDWARE_WIRED` marker
   exists — i.e. the dead-code state is *intentional and labelled*, not accidental.
   (After WB-07/08 wire it, this fence flips to assert the drivers ARE imported by
   `popup/signer.js`.)

## §B — Post-wiring reconciliation (after WB-07 + WB-08)
1. Remove the "NOT WIRED" banners; flip the WB-11§A fence to assert
   `popup/signer.js` imports the drivers and the software fallback exists.
2. Replace scaffold-contract tests with real-transport tests (fake HID emulating
   the Accumulate Ledger app incl. BIP32 path + a real Ed25519 keypair so the
   signature **verifies**; YubiKey tests reflect the WB-08 role — no fake-Ed25519).
3. Delete any remaining "64-byte Ed25519 signature" claims from `yubikey.js`.

## Keystore test gaps (run with §A; review §1.7)
Add to `wallet/keystore.test.mjs`:
- **idle auto-lock:** `setIdleTimeout(small)`, unlock, wait/advance, assert
  `isUnlocked()===false` and `getKey` throws `locked`.
- **getKey after explicit `lock()`** throws.
- **zeroize-on-rotate:** spy `_encryptBytes` to capture the plaintext buffer
  reference passed during rotate, then assert it is all-zero after `rotate`
  resolves (proves the `.fill(0)` from WB-01 ran).
- (from WB-01) **AAD tamper rejected** + **v1→v2 migration**.

## Verification
```
cd browser && npm test && npm run build && npm run vendor:check
( cd .. && npm run test:fences )
```
§A expect: banners present, contract-test label present, honesty fence green,
new keystore tests green. §B expect: wired fence green, real-transport tests green.

## Definition of Done
- [ ] §A: drivers banner-labelled NOT WIRED; tests relabelled as contract; honesty fence added; keystore idle/lock/zeroize tests pass.
- [ ] §B (post WB-07/08): banners removed; fence asserts drivers are wired; real-transport + correct-role tests replace scaffolds; no fake-Ed25519 claims remain.
- [ ] Suite + fences + lint + vendor:check green at both stages.

## Risk / Rollback
§A is documentation + tests only (zero runtime risk) — do it immediately. §B is
bookkeeping that must land **with** WB-07/08 so the fence and reality agree.
Rollback = revert banners/fence; no behavior change.
