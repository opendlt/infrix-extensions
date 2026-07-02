# WB-09 — Key identity (labels, per-key identicon, last-used, purpose scopes)

**Resolves:** review §2.4
**Depends on:** WB-01
**Scope:** `wallet/keystore.js`, `background.js`, `popup/popup.html`, `popup/popup.js`, tests
**Size:** M (1 day)

## Goal
Turn anonymous hex keys into first-class, named, purposeful identities: each key
has a label, a deterministic identicon, a creation + last-used time, and can be
scoped to a purpose (tied to session-key scopes). A governance-native superpower
no consumer wallet offers.

## Background (why)
The keystore already supports multiple keys (`keyId`, `listKeys`), but the UI shows
`7f3a…b21c` with a Delete button — no name, no purpose, no usage. Users can't tell
their "trading key" from their "admin key".

## Steps
1. **Keystore — metadata.** Extend the entry with optional `label` and
   `lastUsedAt`:
   - `addKey(keyId, privKey, pubKey, meta = {})` stores `label: meta.label || ''`,
     `purpose: meta.purpose || ''`, `derivationPath` (from WB-03 if present).
   - On `getKey(keyId)`, set `lastUsedAt = new Date().toISOString()` and persist
     (cheap write). `listKeys()` returns `{ keyId, pubKey, label, purpose, createdAt, lastUsedAt }`.
   - New `setKeyLabel(keyId, label)` for rename. All AAD-bound (WB-01).
2. **Background.** `wallet.generateKey` accepts `{ label, purpose }`; `wallet.listKeys`
   passes the new fields through; add `wallet.renameKey { keyId, label }`.
3. **Popup — Keys tab.** Render each key as a card: per-key identicon
   (`InfrixWalletData.identiconSvg(pubKey)`), the label (inline-editable → `renameKey`),
   short pubkey (mono), `created` + `last used` (relative), purpose chip, Delete.
   "Generate new key" opens a small dialog asking for a **name** and an optional
   **purpose** (free text or a preset: Trading / Admin / Read-only).
4. **Purpose ↔ session scopes.** When creating a session key (`wallet.createSession`),
   let the user pick which named key authorizes it and prefill the scope from the
   key's purpose preset (e.g. "Trading" → the trading contracts/functions). Display
   the authorizing key's identicon on each session row.
5. **Identity card.** Show the *active signing key's* identicon + label next to the
   ADI (distinct from the ADI identicon), so the user always knows which key signs.

## Tests
- keystore: `addKey` with `{label,purpose}` persists them; `listKeys` returns them;
  `getKey` updates `lastUsedAt`; `setKeyLabel` renames; AAD still binds (tamper test from WB-01 still passes with the new fields).
- background: `wallet.generateKey {label}` then `wallet.listKeys` shows the label;
  `wallet.renameKey` updates it.
- popup boot smoke: Keys tab renders a labelled key card with an `<svg>` identicon
  (extend `tests/popup_boot.test.mjs` dashboard case with a labelled key in the
  `wallet.listKeys` stub).

## Verification
```
cd browser && npm test && npm run build && npm run vendor:check
( cd .. && npm run test:fences )
```
Manual: generate "Trading key" → shows named card + identicon; rename inline;
create a session authorized by it → session row shows its identicon.

## Definition of Done
- [ ] Keys carry label + purpose + createdAt + lastUsedAt (AAD-bound).
- [ ] Keys tab shows named cards with per-key identicons; inline rename; create-dialog asks name/purpose.
- [ ] Session keys reference a named authorizing key; identity card shows the active key.
- [ ] Tests + fences + lint + vendor:check green.

## Risk / Rollback
Additive metadata; legacy keys (no label) render with a default name ("Key 1").
`lastUsedAt` write-on-read adds a storage write per sign — keep it a single
`set`; acceptable. Rollback = revert; metadata fields are ignored by old code.
