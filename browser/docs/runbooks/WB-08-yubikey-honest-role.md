# WB-08 — YubiKey honest role (2FA-unlock primary; WebAuthn-signer optional)

**Resolves:** review §1.1, §1.2(yubikey), §2.1
**Depends on:** WB-06
**Scope:** `wallet/hardware/yubikey.js`, `background.js`, `popup/signer.js`, `popup` Settings, tests; **(Path B only)** `accumen` verifier
**Size:** M (Path A) / L (Path B, cross-repo)

## Goal
Make the YubiKey integration **correct and useful** instead of a signer that emits
signatures the chain can't verify. Two honest paths — pick one.

## Background (why)
`yubikey.sign()` returns `assertion.response.signature`, which signs
`authenticatorData ‖ SHA-256(clientDataJSON)`, **not** the message — so it can
never verify against the spine's `ed25519(infrix-approval-v1:…)`. Also `rpId`
defaults to `'infrix.local'` (`yubikey.js:50`), invalid for a `chrome-extension://`
origin → `SecurityError`. As-is it cannot work as a transaction signer.

## Decision point (pick one; A recommended for this repo)
- **Path A — YubiKey as a second factor for unlock (frontend-only, correct).**
  WebAuthn `userVerification:'required'` gates the keystore *unlock*; the actual
  approval is still signed by the software/Ledger key. Strong UX/security win, no
  backend change, no signature-semantics problem.
- **Path B — YubiKey as a real signer (correct, but backend work).** The spine
  must accept **WebAuthn-format** signatures: verify over `authData ‖
  SHA-256(clientData)` with the credential's COSE EdDSA public key, with the plan
  hash bound into `challenge`. Requires an `accumen` verifier change + a new
  `signatureAlgorithm:'webauthn'` envelope branch. Only do this if device-signer
  YubiKey is a hard requirement.

## Steps — Path A (recommended)
1. **Fix `rpId`.** Default to the extension's WebAuthn-permitted id (the extension
   origin id), not `infrix.local`; make it constructor-injected and set correctly
   from the popup. Validate `available()` against a real `navigator.credentials`
   in the popup context.
2. **Register (Settings → "Add YubiKey as unlock factor").** `registerCredential`
   in the popup (user gesture, `userVerification:'required'`); persist the
   `credentialId` in `walletState` (`wallet.addHardwareSigner { kind:'yubikey-2fa', credentialId }`). It is **not** a signing key — store it as an unlock factor.
3. **Gate unlock.** When a 2FA factor is registered, `WalletSigner`/unlock requires
   a successful `navigator.credentials.get({ allowCredentials:[id], userVerification:'required' })` **before** the passphrase unlock proceeds (assertion validity only — presence/UV — not used as a signature). Reflect "🔑 YubiKey required" in the unlock bar.
4. **Repurpose `yubikey.js`:** keep `registerCredential` + `available`; replace the
   misleading `sign()` (which pretended to be Ed25519) with `assertUserPresence(challenge)` returning `{ ok:true }` on a valid assertion. Remove the "64-byte Ed25519 signature" claim from comments/JSDoc.

## Steps — Path B (only if device-signer required)
1. Keep an honest `sign()` returning the WebAuthn assertion **plus** `authData` +
   `clientDataJSON` (the verifier needs all three) under `signatureAlgorithm:'webauthn'`.
2. `wallet.submitApproval` carries the WebAuthn fields; bind `planHash` into the
   `challenge`. 3. Add the verifier branch in `accumen` (separate repo runbook) +
   tests there. 4. Fix `rpId` as in Path A.

## Tests
- **Path A:** `assertUserPresence` resolves on a valid fake assertion, rejects on a
  declined one; unlock is blocked until the assertion succeeds when a factor is
  registered; `rpId` is the extension id, not `infrix.local`. Update
  `hardware.test.mjs` to stop asserting a fake "Ed25519 signature" from WebAuthn.
- **Path B:** signature + authData + clientData round-trip; backend verifier test
  (in `accumen`) accepts a correctly-formed WebAuthn approval and rejects tamper.

## Verification
```
cd browser && npm test && npm run build && npm run vendor:check
( cd .. && npm run test:fences )
```
Manual (real YubiKey): Path A — register factor → unlock now requires a touch →
approvals proceed. Path B — sign an approval; backend accepts.

## Definition of Done
- [ ] `rpId` valid for the extension origin (no more `infrix.local`).
- [ ] Chosen role implemented; **no code path claims a WebAuthn assertion is a raw Ed25519 signature**.
- [ ] `hardware.test.mjs` reflects the real role (no fake-Ed25519 assertion test).
- [ ] (Path B) backend verifier accepts WebAuthn approvals; tamper rejected.
- [ ] Suite + fences + lint + vendor:check green.

## Risk / Rollback
Path A is contained and correct — prefer it. Path B couples the wallet to a
backend change; do not ship the wallet side until the verifier lands. Rollback =
remove the factor/option; software+Ledger signing unaffected.
