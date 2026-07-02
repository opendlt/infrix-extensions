# WB-06 — Signing-locus refactor (popup-orchestrated signer seam)

**Resolves:** review §1.2 (architectural), prerequisite for §2.1
**Depends on:** WB-04
**Scope:** `background.js`, `popup/popup.js`, `popup/plan-approval.js`, new `popup/signer.js`, `tests/background.test.mjs`
**Size:** M (1–2 days)

## Goal
Introduce a clean **signer seam** so a signature can come from either the software
keystore (background) or a hardware device (popup), with the background remaining
the sole assembler/submitter of the approval envelope. This unblocks hardware
signing, which is impossible where signing lives today.

## Background (why)
WebHID (`navigator.hid`) and WebAuthn (`navigator.credentials`) **do not exist in
an MV3 service worker**. Signing currently happens entirely in `background.js`, so
hardware can never participate. The fix is not "call the device from background"
(impossible) — it's to let the **popup** obtain a hardware signature and hand it to
background for envelope assembly + `approval.submit`.

## Design — the seam
A signature request resolves to one of two producers:
- **software:** popup asks background `wallet.signPayload { payload }` → background
  signs with the unlocked keystore and returns `{ signature, publicKey, algorithm }`.
- **hardware:** popup (window context) drives the device, producing
  `{ signature, publicKey, algorithm:'ed25519'|'webauthn' }` itself.
Either way the popup calls `wallet.submitApproval { intentId, planHash, signerIdentity, signerPublicKey, signature, signatureAlgorithm, signaturePayload, signer:'software'|'ledger'|'yubikey' }`; background validates the plan-hash binding (existing confused-deputy guard) and calls `approval.submit`.

## Steps
1. **Background — split sign from submit.**
   - Add `wallet.signPayload { payload, keyId? }` → returns a detached signature over the exact `payload` bytes using the unlocked keystore (reuses `signWithStoredKey`; requires WB-04 unlock). Never assembles an envelope.
   - Add `wallet.submitApproval { … }` (fields above) → keep the **plan-hash mismatch guard** (`background.js:234-238`), build the envelope via `augmentDisclosureContext`, call `rpcProxy('approval.submit', …)`. Accept a `signatureAlgorithm` so a future WebAuthn signer is representable.
   - Keep `wallet.approveRequest` working (delegate internally to signPayload+submitApproval for the software path) so existing tests/flows pass.
2. **Popup — `signer.js` (new).** A `WalletSigner` that, given `{ payload, intentId, planHash }`, returns a signature via the selected producer:
   - `software`: `sendMessage({type:'wallet.signPayload', payload})`.
   - `ledger`/`yubikey`: delegate to the hardware drivers (WB-07/08) **in the popup context**.
   - Exposes `availableSigners()` (software always; hardware iff a device is detected) for the signer-selector UI.
3. **plan-approval.js — route through the signer.** `signAndApprove` becomes:
   `payload = infrix-approval-v1:intentId:planHash:signerIdentity` → `signer.sign(...)` → `wallet.submitApproval`. The canonical payload string stays the single chokepoint (feeds WB-10).
4. **No behavior change yet** for software — this runbook only refactors the seam; WB-07/08 add the hardware producers. Verify the software path is byte-for-byte equivalent on the wire.

## Tests (`tests/background.test.mjs` + integration)
- `wallet.signPayload` returns a signature that verifies under the returned pubkey over the exact payload.
- `wallet.submitApproval` still aborts on plan-hash mismatch (confused-deputy guard) and otherwise lands `approval.submit` on the mock server with the disclosure envelope (extend `integration.test.mjs`).
- `wallet.approveRequest` end-to-end still passes unchanged (delegation intact).

## Verification
```
cd browser && npm test && npm run build && npm run vendor:check
( cd .. && npm run test:fences )
```
Fences: keep all Gap-15 / P3-20 tokens (`plan-approval.js` keeps `signAndApprove`,
`runtimeSend`, `intent.plan/steps`, `approval.get`; popup keeps the disclosure
context + `window.CinemaWidget`/`DebugPanel`).

## Definition of Done
- [ ] `wallet.signPayload` + `wallet.submitApproval` exist; `approveRequest` delegates to them.
- [ ] Software approval is wire-identical to before (integration test proves it).
- [ ] `popup/signer.js` exposes `availableSigners()` + `sign()`; plan-approval routes through it.
- [ ] All fence tokens preserved; suite + fences + lint + vendor:check green.

## Risk / Rollback
Pure refactor of the signing path — highest regression risk is the wire envelope.
Mitigate with the integration test asserting the exact `approval.submit` params
before/after. Rollback = revert; `approveRequest`'s original inline path is the
fallback.
