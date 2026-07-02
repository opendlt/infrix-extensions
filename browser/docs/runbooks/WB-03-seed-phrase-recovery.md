# WB-03 — Seed-phrase recovery (BIP39 + SLIP-0010) + restore-from-seed

**Resolves:** review §1.5(b), §2.3(b)
**Depends on:** WB-01, WB-02
**Scope:** new `wallet/mnemonic.js` (+ test), `wallet/keystore.js`, `background.js`,
`popup/popup.html`, `popup/popup.js`
**Size:** L (2–3 days)

## Goal
Give every account a universally-understood recovery backbone: a 12-word BIP39
mnemonic from which signing keys are deterministically derived (SLIP-0010 over
Ed25519). New accounts show "write down your 12 words" + a verify step; existing
users can "Restore from recovery phrase". Stdlib-only (no bundler/deps).

## Background (why)
WB-02 backs up the *encrypted store* (needs the passphrase). A seed phrase is the
human recovery path that survives a forgotten passphrase / lost device, and it's
the mental model every wallet user already has → zero onboarding friction.

## Design decisions
- **Stdlib-only crypto:** BIP39 = wordlist + PBKDF2-HMAC-SHA512 (Web Crypto has
  PBKDF2 + HMAC SHA-512). SLIP-0010 Ed25519 = HMAC-SHA512 chain (Web Crypto
  `subtle.sign('HMAC', …, 'SHA-512')`). Ed25519 public key from the 32-byte seed:
  Web Crypto `Ed25519` `importKey('raw'|'jwk')` cannot import a raw scalar
  directly → derive the keypair with a tiny vendored ed25519 scalar-basepoint mult,
  **or** import via PKCS8 by wrapping the 32-byte seed in the fixed PKCS8 prefix
  for Ed25519 (`302e020100300506032b657004220420 ‖ seed`) and `importKey('pkcs8')`.
  Use the **PKCS8-wrap trick** — it is stdlib-only and avoids vendoring curve math.
- **Account seed binding:** the mnemonic → 64-byte BIP39 seed → SLIP-0010 master →
  derive path `m/44'/<coin>'/0'/0'/<index>'`. Store the **encrypted mnemonic seed**
  in the keystore (new record), and derive key #index on demand; `addKey` for a
  derived key stores the derived pubkey + the path (no separate random privkey).
- **Backward compat:** existing random keys (pre-seed) keep working; seed-derived
  keys are additive. The store grows a `seed` section (`{ iv, ciphertext }`,
  AES-GCM under the wrapping key) + per-key `derivationPath`.

## Steps
1. **`wallet/mnemonic.js` (new, classic-or-ESM module, pure + testable):**
   - `generateMnemonic(words=12)` → uses `crypto.getRandomValues` for entropy +
     the 2048-word BIP39 English list (embed the list, or a checksummed subset —
     embed the full list; ~13KB) → returns the phrase + validates checksum.
   - `validateMnemonic(phrase)` → boolean (wordlist membership + checksum).
   - `mnemonicToSeed(phrase, passphrase='')` → PBKDF2-HMAC-SHA512(phrase, "mnemonic"+passphrase, 2048, 64).
   - `slip10DeriveEd25519(seed, path)` → 32-byte private scalar (HMAC-SHA512 chain).
   - `ed25519FromSeed(scalar32)` → `{ privatePkcs8, publicKeyRaw }` via the PKCS8-wrap import + `exportKey('raw', pub)`.
   - Export for Node tests (`module.exports`) and `window` (classic) like `api.js`.
2. **Keystore — seed record.** Add to `EncryptedKeystore`:
   - `async setSeed(seedBytes)` — encrypt under wrapping key, store as `store.seed`.
   - `async getSeed()` — decrypt (requires unlocked); caller zeroizes.
   - `async hasSeed()` — boolean from store.
   - `addKey` gains optional `derivationPath`/`source:'seed'|'random'` metadata.
3. **Background:**
   - `wallet.createFromMnemonic { mnemonic, passphrase }` — validate, `mnemonicToSeed`, `setSeed`, derive index 0, `addKey` with path `m/44'/.../0'`, return pubkey. Used by onboarding "Create" (replaces raw random gen) and "Restore".
   - `wallet.revealMnemonic { passphrase }` — unlock, return the mnemonic **only** if the popup is showing the reveal screen (one-shot; never logged). Consider returning it once and requiring re-unlock to view again.
   - `wallet.generateKey` for seed accounts derives the next index from the seed instead of random; random path stays for legacy.
4. **Onboarding (popup):** after "Create my account", generate a mnemonic →
   **Reveal screen** ("Write these 12 words down, in order") → **Verify screen**
   (re-enter 3 random positions) → only then finish (setADI + createFromMnemonic).
   Add a "Restore from recovery phrase" entry on the onboarding import pane: 12-word
   input (with per-word validation) + passphrase → `createFromMnemonic`.
5. **Settings:** "Reveal recovery phrase" (re-unlock gated) with a blur-until-hold
   reveal and a "screenshot is unsafe" caption.

## Tests (`wallet/mnemonic.test.mjs` + background)
- BIP39 vectors: known entropy → known phrase; known phrase+passphrase → known 64-byte seed (use the official BIP39 test vectors).
- `validateMnemonic` rejects bad checksum / non-wordlist words.
- SLIP-0010 Ed25519 vectors (the SLIP-0010 test vectors for ed25519) → known private/public at known paths.
- `ed25519FromSeed` pubkey verifies a signature made with the matching key (round-trip via `subtle.sign/verify`).
- background: `createFromMnemonic` then `wallet.sign` produces a signature verifiable under the returned pubkey; restoring the **same** mnemonic on a fresh state yields the **same** pubkey (determinism).

## Verification
```
cd browser && npm test && npm run build && npm run vendor:check
( cd .. && npm run test:fences )
```
Manual: create → write words → verify → dashboard; wipe; restore with the same
words + passphrase → same ADI key recovered.

## Definition of Done
- [ ] `wallet/mnemonic.js` passes BIP39 + SLIP-0010 official vectors.
- [ ] New accounts are seed-derived; reveal + verify steps in onboarding.
- [ ] Restore-from-phrase reproduces the identical key deterministically.
- [ ] Reveal-phrase is re-unlock-gated and never logged.
- [ ] Legacy random keys still load/sign.
- [ ] Suite + fences + lint + vendor:check green.

## Risk / Rollback
Changes key provenance → highest-care runbook. Keep the random-key path intact
(additive). The PKCS8-wrap import must be validated against `subtle` on all target
browsers in the manual pass. Rollback = revert; seed records are additive and
ignored by the reverted code (legacy keys unaffected).
