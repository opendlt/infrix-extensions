# WB-04 — Unlocked-session signing + visible auto-lock + lock controls

**Resolves:** review §1.4, §2.2, part of §1.3, §1.7(idle test)
**Depends on:** WB-01
**Scope:** `background.js`, `popup/popup.html`, `popup/popup.js`, `tests/background.test.mjs`, `wallet/keystore.test.mjs`
**Size:** M (1–2 days)

## Goal
Derive the wrapping key **once per unlock** and keep the keystore unlocked for a
bounded, user-visible idle window — so signing is instant after unlock instead of
paying 600k PBKDF2 iterations on every signature. Surface a live lock countdown
and a "stay unlocked for" control.

## Background (why)
`background.js` runs `unlock()`→`getKey()`→`lock()` on **every** sign (`:448-474`),
i.e. 600k PBKDF2 per signature, while the keystore's `lockTimer`/`idleTimeoutMs`/
`_resetIdleTimer` machinery is never used. We pay the cost and get no benefit. In
MV3 the service worker is also evicted on idle (that *is* the real auto-lock), so
the session model must be eviction-safe: hold the key only in memory, re-unlock
when the SW comes back locked.

## Steps
1. **Background — session unlock.** Replace the unlock-per-op pattern:
   - Add `wallet.unlock { passphrase }` → `getKeystore().unlock(passphrase)` (or `unlockOrInitializeKeystore`), then **do not** `lock()`. Return `{ unlocked: true }` / `{ error }`.
   - Add `wallet.lock` → `getKeystore().lock()`.
   - Add `wallet.lockStatus` → `{ unlocked: ks.isUnlocked(), idleTimeoutMs, remainingMs }`. Track an `unlockedAt`/`lastActivityAt` so `remainingMs` is computable (the keystore resets its timer on each op; mirror that timestamp in `walletState` for reporting).
   - Add `wallet.setIdleTimeout { ms }` → `ks.setIdleTimeout(ms)` (clamp 60s–60min).
2. **Background — signing uses the held key.** Refactor `signWithStoredKey`:
   - If `ks.isUnlocked()`, skip `unlock()` and `lock()`; use the in-memory wrapping key via `ks.getKey()`. Zeroize the returned private bytes after signing (as today).
   - If locked, return a typed `{ error: 'locked', code: 'WALLET_LOCKED' }` so the popup can prompt unlock rather than silently failing. (Do **not** auto-unlock without a passphrase.)
   - `wallet.approveRequest` likewise requires `isUnlocked()`; on locked, return the typed locked error.
3. **Background — keep `generateKey`/`deleteKey`/`rotate` honoring the session** (use the held key when unlocked; require unlock otherwise). Remove the per-op `ks.lock()` calls; locking is now driven only by (a) the idle timer, (b) explicit `wallet.lock`, (c) SW eviction.
4. **Popup — unlock model already exists** (`keyPassphraseInput` + unlock bar from the redesign). Wire it to the new messages:
   - `unlock()` → `wallet.unlock` (not just `wallet.verifyPassphrase`); on success the session is live.
   - On any signing op returning `code:'WALLET_LOCKED'`, reveal the unlock bar + a hint (reuse `requireUnlock`).
   - Poll `wallet.lockStatus` (e.g. every 1s while the popup is open) to drive a **countdown ring** in the lock button ("Locked in 12:43"); at 0 it flips to Locked.
   - Add a "Stay unlocked: 1m / 15m / 1h" control → `wallet.setIdleTimeout`.
   - When the popup opens and `lockStatus.unlocked === false` (e.g. SW was evicted), show Locked and prompt unlock; when `true`, reflect Unlocked without re-deriving.

## Tests
- **keystore (`keystore.test.mjs`):** idle auto-lock fires — `setIdleTimeout(1000)`, unlock, advance fake timers (or wait), assert `isUnlocked()` is false and `getKey` throws `locked`. `getKey` after explicit `lock()` throws.
- **background (`background.test.mjs`):** `wallet.unlock` then two `wallet.sign` calls succeed without a second passphrase; a `wallet.sign` while locked returns `code:'WALLET_LOCKED'`; `wallet.lockStatus` reports unlocked/`remainingMs`.
- **Perf assertion (light):** count `_deriveWrappingKey` invocations via a spy — two signs in one unlocked session derive **once**, not twice.

## Verification
```
cd browser && npm test && npm run build && npm run vendor:check
( cd .. && npm run test:fences )
```
Manual: unlock once → two approvals sign with no re-prompt and no perceptible
delay on the 2nd → countdown visible → relocks at 0 and on popup reopen after SW
eviction.

## Definition of Done
- [ ] One PBKDF2 derivation per unlock (not per signature) — spy-asserted.
- [ ] Signing while locked returns a typed `WALLET_LOCKED`; popup prompts unlock.
- [ ] Idle auto-lock works and is reflected by a live countdown; "stay unlocked" control wired.
- [ ] SW-eviction = locked on next popup open (no secret persisted).
- [ ] Suite (incl. new idle/perf tests) + fences + lint + vendor:check green.

## Risk / Rollback
Holding the wrapping key in memory longer is the intended trade (still memory-only,
auto-locked, eviction-safe). Ensure **no** secret is written to `chrome.storage`.
Rollback = revert to unlock-per-op; the message handlers are additive so the popup
degrades to verify-then-sign.
