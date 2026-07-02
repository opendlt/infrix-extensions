# WB-07 — Ledger governed approval (real transport + pairing + device-confirm UI)

> ## ⛔ STATUS: PARKED (fundamental protocol incompatibility) — 2026-06-27
>
> Investigation against the real artifacts (`app-accumulate` device firmware +
> `opendlt-javascript-v2v3-sdk` Ledger client) found that **this runbook's
> premise is not achievable with the Accumulate Ledger app as it exists.**
>
> - The Accumulate Ledger app's `SIGN_TX (0x06)` signs a **serialized Accumulate
>   transaction envelope** (parsed + hashed on-device). It does **not** sign
>   arbitrary bytes, and **does not blind-sign** — the official SDK proves it:
>   `ledger-api.ts → LedgerKey.signRaw` throws *"The Ledger app does not support
>   blind signing or non-transactions"* for any non-`Transaction`.
> - Infrix governance approvals sign a **bespoke** payload,
>   `infrix-approval-v1:intentId:planHash:signerIdentity`
>   (`background.js::approvalSignaturePayload`) — **not** an Accumulate
>   transaction. So the Ledger app cannot sign an Infrix approval; `SIGN_TX`
>   would return `ACC_TYPE_NOT_FOUND` / throw.
>
> **Unblock conditions (any one):**
> 1. Infrix approvals are reshaped to be Accumulate transactions the app parses
>    + signs (governance-model change: spine + verifier + this wallet), **or**
> 2. The Accumulate Ledger app + its SDK gain real blind-sign-a-hash support,
>    and the Infrix spine verifier accepts that signature shape, **or**
> 3. Scope Ledger to what it CAN do for Infrix — provide the public key + sign
>    Accumulate *transactions* (the `submitIntent` path), explicitly NOT the
>    approval payload (this is the "Real driver, honestly scoped" option).
>
> Until then the hardware scaffold stays quarantined per **WB-11 §A** (banners +
> contract-test labels), and the signer seam (WB-06) is ready to accept a real
> Ledger producer the moment one of the above lands. The real protocol is now
> documented above in `app-accumulate/doc/COMMANDS.md` (CLA `0xE0`;
> `GET_PUBLIC_KEY 0x05` with a BIP32 path; `SIGN_TX 0x06`) for whoever resumes.

**Resolves:** review §1.1, §1.2(ledger), §2.1
**Depends on:** WB-06
**Scope:** `wallet/hardware/ledger.js`, build tooling (decision below), `popup/signer.js`,
`popup/plan-approval.js`, `popup/popup.html/js`, manifest (maybe), tests
**Size:** L (1–2 weeks)

## Goal
Let a user approve a governed plan **on their Ledger's own screen**: the device
displays the plan hash, the user confirms, and the resulting Ed25519 signature
over the canonical approval payload verifies on-chain. The signer-selector in the
approval sheet shows "Sign with: Ledger (connected)".

## Background (why)
The current `ledger.js` is a contract sketch: hand-rolled APDU framing, no BIP32
path in `GET_PUBLIC_KEY` (`ledger.js:69`), and no real handshake/chunking. It is
also never wired (§1.1). Real signing must run in the **popup** (WebHID is absent
in the SW — handled by WB-06).

## Decision point — transport & bundling (pick one, record it)
The extension is "plain JS, no bundler". A real Ledger transport
(`@ledgerhq/hw-transport-webhid` + the Accumulate/Ed25519 app client) is npm/ESM.
Options:
- **(A) Introduce a bundler** (esbuild) that emits a single classic
  `vendor/ledger.bundle.js` loaded by the popup. Cleanest, but adds a build step
  and a fence ("popup loads vendor/ledger.bundle.js"); keep it out of `cinema-core`.
- **(B) Vendor a minimal WebHID APDU transport** as classic JS (handshake, 64-byte
  HID report framing, APDU chunking, status words) + a thin Accumulate-app client.
  No bundler, more code to own/verify.
Recommendation: **(A) esbuild for the hardware vendor bundle only** — owning a
correct Ledger HID transport by hand (B) is a long, error-prone tail. Whichever is
chosen, the driver must speak the **Accumulate Ledger app** APDUs, not a generic
sketch.

## Steps
1. **Replace the driver internals.** `LedgerEd25519Driver` keeps its shape
   (`available()`, `getPublicKey()`, `sign(message)`, `name`) but delegates to the
   real transport (A or B). `getPublicKey()` sends the **BIP32 derivation path**
   in the APDU data (path stored with the account). `sign()` signs the **canonical
   payload bytes** WB-06 passes (`infrix-approval-v1:…`) and returns the 64-byte
   Ed25519 signature.
2. **First-run pairing (popup, user gesture).** Add `WalletSigner.pairLedger()`:
   `navigator.hid.requestDevice({ filters:[{ vendorId:0x2c97 }] })` behind a click,
   open the device, read the pubkey at the chosen path, and persist
   `{ signer:'ledger', vendorId, path, publicKey, addedAt }` in `walletState`
   (background message `wallet.addHardwareSigner`). Show pairing status + the
   device pubkey for the user to confirm against the device screen.
3. **Detection.** `WalletSigner.availableSigners()` calls `ledger.available()`
   (granted devices via `navigator.hid.getDevices()`); surfaces "Ledger connected"
   only when a paired device is present.
4. **Signer selector (approval sheet).** In `plan-approval.js` render a selector
   above the actions: "Sign with: ◉ Ledger (connected) ○ This device". Default to
   Ledger when paired+connected. On Ledger: show "Confirm on your Ledger…" with the
   plan hash mirrored and a live status; the device prompt drives the rest. On
   software: existing unlock+sign.
5. **Submit.** Hardware signature → `wallet.submitApproval { …, signer:'ledger',
   signerPublicKey:<ledger pubkey>, signatureAlgorithm:'ed25519' }`. The spine
   verifies Ed25519 over the canonical payload — identical verification path to
   software (no backend change needed for Ledger).
6. **Manifest.** WebHID needs no manifest permission entry (per-device user grant),
   so the permission-lock fence stays green. If the chosen approach needs anything,
   change `tests/manifest.test.mjs` deliberately and document why.

## Tests
- Driver contract tests stay (now exercise the real framing via a fake HID device
  that emulates the Accumulate app's APDUs incl. the BIP32 path echo).
- `getPublicKey` sends a non-empty path; round-trips a known pubkey from the fake.
- `sign` over a canonical payload returns 64 bytes; the fake's signature verifies
  with a test Ed25519 key whose pubkey the fake reports (closes the §1.2 "signs the
  wrong thing" gap by construction).
- Popup signer test (vm/jsdom): selector shows Ledger when a fake device is paired;
  software fallback when not.

## Verification
```
cd browser && npm test && npm run build && npm run vendor:check
( cd .. && npm run test:fences )
```
Manual (real Ledger): pair → approve a plan → device shows the hash → confirm →
`approval.submit` accepted; reject on device → clean error in the popup.

## Definition of Done
- [ ] Real Ledger transport (A or B) wired; `getPublicKey` includes the BIP32 path.
- [ ] Pairing flow persists the device + path + pubkey; detection accurate.
- [ ] Approval sheet signer-selector; Ledger path produces an on-chain-verifiable Ed25519 signature over the canonical payload.
- [ ] Build/bundle decision recorded; mirror + permission fences green.
- [ ] Suite + fences + lint + vendor:check green; real-device manual pass logged.

## Risk / Rollback
Largest runbook; touches build. Keep the software signer as default until a Ledger
is paired. If the bundle path proves heavy, ship behind a "Connect hardware
(beta)" flag. Rollback = remove the signer option + revert the driver; WB-06's
software path is unaffected.
