# WB-02 — Encrypted backup: export / import / restore + "back up" nudge

**Resolves:** review §1.5(a), §2.3(a)
**Depends on:** WB-01
**Scope:** `background.js`, `popup/popup.html`, `popup/popup.js`, `tests/background.test.mjs`
**Size:** M (1 day)

## Goal
Let a user export their (already passphrase-encrypted) keystore as a portable
file and restore it on another browser/profile, closing the silent-data-loss
gap. Until a backup exists, nudge the user to make one.

## Background (why)
Keys live only in `chrome.storage.local`. Clearing browser data or losing the
profile = permanent loss with no warning. The store is *already* AES-GCM
encrypted under the passphrase, so export is safe to hand to the user as-is.

## Steps
1. **Background — export.** Add message `wallet.exportBackup`:
   - Load the raw store (`getKeystore()._loadStore()` is private; instead read `chrome.storage.local` for `infrix.keystore.v1` directly in a small helper, or add a public `exportStore()` to `EncryptedKeystore` that returns the raw store object). Prefer a public `EncryptedKeystore.exportStore()` returning the JSON object (no decryption — ciphertext only).
   - Return `{ backup: { format: 'infrix-keystore-backup', version: 2, exportedAt: <ISO>, store } }`. **Never** include plaintext keys or the passphrase.
2. **Background — import/restore.** Add `wallet.importBackup`:
   - Validate `backup.format === 'infrix-keystore-backup'` and `backup.store.version` ∈ {1,2} and `backup.store.salt`/`checkCiphertext` present.
   - Refuse to clobber a non-empty keystore unless `message.overwrite === true` (the popup confirms first).
   - Write via `EncryptedKeystore.importStore(store)` (new public method → `_saveStore`). Do **not** unlock — the user unlocks with their passphrase afterward (this proves the backup matches their passphrase).
   - Return `{ imported: true, keyCount: store.keys.length }`.
3. **Background — backed-up flag.** Track `walletState.backedUpAt` (ISO) set when `wallet.exportBackup` succeeds; persist in `walletState`; include it in `wallet.getState` so the popup can show/hide the nudge.
4. **Popup — Settings surface.** Add a small "Settings" affordance (gear in the header `header-right`, or a 4th tab). In it:
   - **Export backup** button → `wallet.exportBackup` → trigger a download of `infrix-backup-<adi-name>-<date>.json` via a Blob + `URL.createObjectURL` + a synthetic `<a download>` click.
   - **Restore backup** button → file `<input type="file">` → read JSON → `wallet.importBackup` (confirm overwrite if keys exist) → on success `refreshState()` and prompt unlock.
5. **Popup — nudge chip.** When `state.backedUpAt` is falsy and `keyCount > 0`, render a persistent amber chip under the identity card: "⚠ Back up your account" → opens the export flow. Hide once `backedUpAt` is set.

## Tests (`tests/background.test.mjs`)
- `wallet.exportBackup` returns a backup whose `store.keys` is present and whose ciphertext is unchanged; contains **no** plaintext/private fields (assert no `priv`/`plaintext`/`passphrase` keys anywhere in the JSON).
- `wallet.importBackup` refuses to overwrite a non-empty keystore without `overwrite:true`, and succeeds with it; round-trip: export from A-state, reset, import, `listKeys` matches.
- `wallet.getState` exposes `backedUpAt` (null before export, ISO after).

## Verification
```
cd browser && npm test && npm run build && npm run vendor:check
( cd .. && npm run test:fences )
```
Manual (unpacked extension): create account → see nudge → Export downloads a
file → Restore in a fresh profile → unlock with the same passphrase → keys present.

## Definition of Done
- [ ] `exportBackup`/`importBackup` messages + public `exportStore`/`importStore` on the keystore.
- [ ] Export downloads an encrypted JSON; restore re-imports it; overwrite guarded.
- [ ] Backup never contains plaintext keys or the passphrase (test-asserted).
- [ ] "Back up your account" nudge shows until a backup is taken.
- [ ] Suite + fences + lint + vendor:check green.

## Risk / Rollback
Backup file is ciphertext-only — safe to store, useless without the passphrase
(state this in the export UI). Import overwrite is destructive → guard with an
explicit confirm and the `overwrite` flag. Rollback = revert files; no schema
change to the live store (export/import read/write the existing shape).
