# `wallet/vendor/` — vendored, integrity-pinned third-party crypto

These files are **vendored verbatim** from audited upstream sources and used only
by the background service worker (a `type:module` worker) for seed-phrase
recovery (WB-03). They are **not hand-edited**. Each is pinned by SHA-256 and
gated in `tests/mnemonic.test.mjs`; a modified or mis-fetched file fails CI.

| File | Upstream | Version | Integrity |
| --- | --- | --- | --- |
| `noble-ed25519.js` | `@noble/ed25519` (MIT, audited) | 2.1.0 | file SHA-256 `39fb70069dd6668828313d76f40229c1d771609cff786192e2868b68ca7b492f` |
| `bip39-english.js` | bitcoin/bips `bip-0039/english.txt` (canonical 2048-word list) | — | `sha256(words.join("\n") + "\n")` = `2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda` |

## Why vendored (not stdlib, not a build dep)

Web Crypto cannot derive an Ed25519 **public** key from a seed, which true BIP39
recovery requires. `@noble/ed25519` v2 is a single self-contained file whose
async API wires SHA-512 to Web Crypto (`crypto.subtle`), so the vendored surface
is exactly one file — no bundler, no transitive deps. All other hashing
(SHA-256, HMAC-SHA512, PBKDF2-SHA512) is Web Crypto in `wallet/mnemonic.js`.

## Updating

1. Re-fetch the exact upstream version.
2. Update the SHA-256 constant(s) in `tests/mnemonic.test.mjs`.
3. Run `npm test` — the official BIP39 / SLIP-0010 vectors and the Web-Crypto
   cross-check must still pass. Never edit these files by hand.
