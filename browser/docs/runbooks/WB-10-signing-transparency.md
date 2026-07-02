# WB-10 — Signing transparency (exact-bytes display + single chokepoint)

**Resolves:** review §2.6, surfaces §1.3 lock-state
**Depends on:** WB-04 (lock-state), benefits from WB-06 (chokepoint)
**Scope:** `background.js`, `popup/plan-approval.js`, `popup/popup.html/js`, tests
**Size:** S (½ day)

## Goal
"Trust you can read": before signing, show the user the **exact bytes** they are
about to sign, and guarantee those bytes are produced by a single canonical
function — so the device screen, the popup, and the chain all agree.

## Background (why)
`approvalSignaturePayload` (`background.js:460-465`) builds
`infrix-approval-v1:intentId:planHash:signer` — but the user never sees it, and a
hardware device (WB-07) shows only a hash. Making the payload visible + canonical
closes the "sign blind" gap at the crypto layer (the cinema scene shows *what
happens*; this shows *what you cryptographically commit to*).

## Steps
1. **Single chokepoint.** Export `approvalSignaturePayload` (or a pure
   `canonicalApprovalPayload(intentId, planHash, signer)`) and ensure **every**
   signer (software via `wallet.signPayload`, Ledger, YubiKey-PathB) signs bytes
   produced by exactly this function. Add a unit test pinning the exact string
   format so it can never silently change.
2. **Reveal in the approval sheet.** In `plan-approval.js`, add a "What you're
   signing" disclosure: the canonical payload string (mono, copyable) + its
   SHA-256 (the value a Ledger shows). Render it from the same function (fetch via
   a `wallet.previewSignaturePayload { intentId, planHash }` background message, or
   compute client-side from the already-known fields). Caption: "Your device will
   display this hash — they must match."
3. **Lock-state surfacing (from WB-04).** Show the unlock countdown next to the
   Sign button ("Unlocked · locks in 12:43") so the user knows the session state at
   the moment of signing.
4. **Tamper alignment.** When a hardware signer is used, after signing, verify the
   returned signature against the canonical payload + the signer's pubkey **in the
   popup** before submit; mismatch → block with "device signed a different payload".

## Tests
- Unit: `canonicalApprovalPayload('i','h','acc://a')` === the pinned exact string;
  changing any input changes the output deterministically.
- `wallet.previewSignaturePayload` returns the same string the signer signs.
- popup: the approval sheet renders the payload + hash; (with a fake signer) a
  mismatched signature is rejected pre-submit.

## Verification
```
cd browser && npm test && npm run build && npm run vendor:check
( cd .. && npm run test:fences )
```
Manual: open an approval → expand "What you're signing" → string + hash shown →
(Ledger) device hash matches the shown hash.

## Definition of Done
- [ ] One canonical payload function; all signers consume it (test-pinned format).
- [ ] Approval sheet reveals the exact payload + its hash; lock countdown shown at sign time.
- [ ] Popup verifies a hardware signature against the canonical payload before submit.
- [ ] Tests + fences + lint + vendor:check green.

## Risk / Rollback
Display-only + a verification guard; no envelope change. Keep the payload string
**identical** to today's (`background.js:464`) or you break verification — the
pinned test enforces this. Rollback = hide the disclosure; chokepoint refactor is
behavior-preserving.
