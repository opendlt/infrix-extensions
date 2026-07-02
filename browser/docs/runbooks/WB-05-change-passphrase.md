# WB-05 — Change passphrase (wire `rotate`)

**Resolves:** review §1.3(a), §2.5
**Depends on:** WB-01 (zeroize/AAD in rotate), WB-04 (unlock model)
**Scope:** `background.js`, `popup/popup.html`, `popup/popup.js`, `tests/background.test.mjs`
**Size:** S (½ day)

## Goal
Surface the keystore's existing, tested `rotate(old,new)` as a "Change passphrase"
flow so users can rotate credentials (routine hygiene + incident response).

## Background (why)
`keystore.rotate()` is implemented and unit-tested but has **zero call sites** —
there is no way to change a passphrase from the UI.

## Steps
1. **Background.** Add `wallet.rotatePassphrase { oldPassphrase, newPassphrase }`:
   - Guard: both non-empty; `new !== old`.
   - `await getKeystore().rotate(oldPassphrase, newPassphrase)` (rotate re-derives + re-encrypts all keys + the seed record under the new passphrase). On success the keystore is left **unlocked** under the new key (rotate already sets `this.unlocked`).
   - Return `{ rotated: true, keyCount }` or `{ error }` (normalize "invalid passphrase" from a wrong `old`).
2. **Popup — Settings.** In the Settings surface (added in WB-02): "Change passphrase" → three fields (current / new / confirm) + the onboarding strength meter (`passStrength`). Submit → `wallet.rotatePassphrase`. On success: clear fields, set `keyPassphraseInput.value = new` so the session stays unlocked, `applyLockUI()`, toast "Passphrase changed".
   - Errors (wrong current, mismatch, weak) surface in the inline error banner.
3. **Seed safety (if WB-03 landed):** confirm `rotate` re-encrypts `store.seed` too (extend `rotate` to carry the seed record forward under the new wrapping key). Add this to WB-01/WB-03 if not already; WB-05 must verify it.

## Tests (`tests/background.test.mjs`)
- `wallet.rotatePassphrase` with the wrong current passphrase → `{ error: /invalid/ }`, store unchanged (old still unlocks).
- happy path: rotate, then `wallet.verifyPassphrase`(new) ok and (old) fails; `wallet.sign` still works (keys re-encrypted, signature verifies under the same pubkey).
- with a seed account: after rotate, `wallet.revealMnemonic`(new) returns the same mnemonic (seed survived rotation).
- `new === old` rejected.

## Verification
```
cd browser && npm test && npm run build && npm run vendor:check
( cd .. && npm run test:fences )
```
Manual: change passphrase → old no longer unlocks, new does, keys + seed intact.

## Definition of Done
- [ ] `wallet.rotatePassphrase` wired to `keystore.rotate`; old-passphrase failure is safe (no partial write).
- [ ] Settings "Change passphrase" with strength meter; stays unlocked after.
- [ ] Seed record (if present) re-encrypted under the new passphrase.
- [ ] Tests + fences + lint + vendor:check green.

## Risk / Rollback
`rotate` rebuilds the whole store; it unlocks with the old passphrase first
(verified) and writes the new store atomically. A wrong `old` throws before any
write. Rollback = revert the handler + UI; the keystore method is unchanged.
