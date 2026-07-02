# WB-01 — Keystore crypto hardening (AAD + zeroize-on-rotate + v2 migration)

**Resolves:** review §1.6, §3.1, §3.2, part of §1.7
**Depends on:** none
**Scope:** `wallet/keystore.js`, `wallet/keystore.test.mjs`
**Size:** S (½ day)

## Goal
Bind every encrypted key record to its `keyId` with AES-GCM additional
authenticated data (AAD) so storage tampering / entry-swapping is detected on
decrypt, and guarantee decrypted private keys are zeroized after use in
`rotate()`. Ship a `v1 → v2` migration so existing keystores keep working.

## Background (why)
- `addKey`/`_encryptBytes` (`keystore.js:157`, `:285`) call AES-GCM with **no
  `additionalData`**, so ciphertexts aren't bound to their slot; a storage-write
  attacker can swap entry ciphertexts and both still decrypt under the one
  wrapping key.
- `rotate()` (`keystore.js:218-253`) decrypts every private key into `oldKeys[].priv`
  and never `.fill(0)`s them — plaintext keys linger for GC. (`signWithStoredKey`
  in `background.js:445` already zeroizes; rotate just forgot.)

## Steps
1. **Add a store version constant + AAD helper.** In `keystore.js`:
   - `const STORE_VERSION = 2;`
   - `function keyAAD(keyId) { return new TextEncoder().encode('infrix.key:' + keyId); }`
   - For the passphrase check record use a fixed AAD: `const CHECK_AAD = new TextEncoder().encode('infrix.check');`
2. **Thread AAD through encrypt/decrypt.** Change `_encryptBytes(bytes, wrappingKey, aad)` and `_decryptEntry(entry, wrappingKey, aad)` to pass `additionalData: aad` into `subtle.encrypt`/`subtle.decrypt` when `aad` is provided.
   - `addKey`: encrypt with `keyAAD(keyId)`; write `aad: 2` marker on the entry (or rely on store `version`).
   - `_verifyPassphraseCheck`: decrypt the check record with `CHECK_AAD` for v2 stores; for v1 stores (no version or version 1) decrypt **without** AAD.
   - `rotate`: re-encrypt each key with `keyAAD(k.keyId)` and the check record with `CHECK_AAD`; write `version: STORE_VERSION`.
3. **Migration in `unlock()`.** After a successful passphrase verify:
   - If `store.version !== STORE_VERSION`: decrypt every entry with the **legacy (no-AAD)** path, re-encrypt with `keyAAD`, re-encrypt the check record with `CHECK_AAD`, set `version: STORE_VERSION`, `_saveStore`. Zeroize the transient plaintexts. This upgrades in place on first unlock; no user action.
   - `_decryptEntry` must accept an `aad` arg of `null` to support the legacy read during migration.
4. **Zeroize in `rotate()`.** After `_encryptBytes(k.priv, …)` for each key, `k.priv.fill(0)`. Wrap the loop in `try/finally` so plaintexts are zeroized even if a later encrypt throws.
5. **Keep `initialize()` writing `version: STORE_VERSION`** and the check record with `CHECK_AAD`.

## Tests (add to `keystore.test.mjs`)
- **AAD tamper rejected:** init, addKey('a',…), addKey('b',…); in the raw store swap entry a's `ciphertext`/`iv` with b's; `getKey('a')` rejects (GCM auth failure), not silently returns b's key.
- **v1 store migrates on unlock:** hand-craft a v1 store (no `version`, no AAD — encrypt with a no-AAD helper in the test), `unlock()`, assert `store.version === 2` afterward and `getKey` round-trips.
- **rotate still round-trips** under v2 (existing test should pass unchanged).
- **legacy unlock still verifies** (wrong passphrase still rejected on a v1 store).

## Verification
```
cd browser
npm test -- # or: node --test --test-reporter=spec wallet/keystore.test.mjs
npm run build && npm run vendor:check
( cd .. && npm run test:fences )
```
Expect: all keystore tests green incl. the 4 new ones; lint clean; mirror untouched; fences green.

## Definition of Done
- [ ] AES-GCM AAD binds `keyId` (and a fixed tag for the check record) on all writes.
- [ ] `rotate()` zeroizes every decrypted private key (incl. error paths).
- [ ] Existing v1 keystores transparently upgrade to v2 on first unlock; no data loss.
- [ ] 4 new tests pass; full suite + fences + lint + vendor:check green.

## Risk / Rollback
Migration touches stored ciphertext. Mitigate: migration only runs **after** a
verified unlock (correct passphrase proven), re-encrypts from freshly-decrypted
plaintext, and `_saveStore` is a single atomic `chrome.storage.local.set`. If a
write fails mid-migration the original store is unchanged (set is all-or-nothing
per key). Rollback = revert the file; v2 stores remain readable by the reverted
v1 code only if you keep the no-AAD fallback — so **do not** delete the legacy
read path.
