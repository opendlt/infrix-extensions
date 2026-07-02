// Copyright 2024 The Infrix Authors
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.

// G-25 phase 1a — encrypted keystore for the wallet extension.
//
// Implements passphrase-encrypted storage of ED25519 signing keys
// using Web Crypto's PBKDF2 (key derivation) + AES-GCM (AEAD) so
// the popup never holds plaintext keys at rest. Auto-locks after a
// configurable inactivity timeout. Supports key rotation: a new
// passphrase encrypts a fresh wrapping key; old wrapping keys
// decrypt-only until rotated to.
//
// Web Crypto choice rationale:
//   - PBKDF2 with 600k iterations meets OWASP 2024 guidance for
//     password-based key derivation and is natively supported by
//     every browser the extension targets. Argon2id offers stronger
//     guarantees but requires a 60KB polyfill; we accept the
//     PBKDF2 trade-off for a stdlib-only build.
//   - AES-GCM is the canonical AEAD for Web Crypto. Equivalent
//     security to ChaCha20-Poly1305 for the wallet's threat model
//     (offline ciphertext attacker after extension uninstall;
//     on-device passphrase brute-force).
//
// Storage layout (chrome.storage.local under "infrix.keystore.v1"):
//   {
//     version: 1,
//     salt:    base64(16-byte random salt, fixed at first init),
//     checkIv: base64(12-byte AES-GCM IV for passphrase verification),
//     checkCiphertext: base64(AES-GCM ciphertext + tag for fixed verifier),
//     keys: [
//       {
//         keyId:        string (uuid-v4),
//         iv:           base64(12-byte AES-GCM IV),
//         ciphertext:   base64(AES-GCM ciphertext + tag),
//         createdAt:    ISO 8601 timestamp,
//         pubKey:       base64(ED25519 public key) for fast lookup
//       }
//     ]
//   }

const STORAGE_KEY = 'infrix.keystore.v1';
const PBKDF2_ITERATIONS = 600_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const CHECK_PLAINTEXT = 'infrix.keystore.v1.passphrase.check';

// Storage format version. v2 binds every ciphertext to its slot via AES-GCM
// additional authenticated data (AAD); v1 (no AAD) is still readable so an
// existing keystore migrates transparently on first unlock. STORAGE_KEY stays
// "infrix.keystore.v1" for backward-compatible reads — the schema version lives
// in the `version` field, not the key name.
const STORE_VERSION = 2;

// AAD binds an encrypted record to its identity so a storage-write attacker
// cannot swap one entry's ciphertext for another's (both would otherwise
// decrypt under the single wrapping key). The passphrase-check record uses a
// fixed tag; each key record is bound to its keyId.
const CHECK_AAD = new TextEncoder().encode('infrix.keystore.check');
const SEED_AAD = new TextEncoder().encode('infrix.keystore.seed');
function keyAAD(keyId) {
  return new TextEncoder().encode('infrix.keystore.key:' + keyId);
}

// Default auto-lock idle timeout: 15 minutes. Operators with stricter
// policies override via setIdleTimeout().
const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Encrypted Keystore: persists ED25519 signing keys encrypted under
 * a passphrase-derived wrapping key. Goroutine-safe is irrelevant
 * for browser JS, but every async operation is independently safe
 * (no shared mutable state outside `this.unlocked`).
 */
export class EncryptedKeystore {
  /**
   * @param {object} storage — chrome.storage.local-shaped object
   *   exposing get(key) and set(obj). Tests pass an in-memory shim;
   *   production passes chrome.storage.local.
   */
  constructor(storage) {
    if (!storage) throw new Error('EncryptedKeystore: storage adapter required');
    this.storage = storage;
    this.unlocked = null; // { wrappingKey, salt, lockTimer }
    this.idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS;
    this.subtle = (globalThis.crypto && globalThis.crypto.subtle);
    if (!this.subtle) {
      throw new Error('EncryptedKeystore: globalThis.crypto.subtle unavailable');
    }
  }

  setIdleTimeout(ms) {
    if (typeof ms !== 'number' || ms < 1000) {
      throw new Error('idle timeout must be ≥1000ms');
    }
    this.idleTimeoutMs = ms;
    if (this.unlocked) this._resetIdleTimer();
  }

  isUnlocked() {
    return this.unlocked !== null;
  }

  /**
   * Initialize a fresh keystore with a passphrase. Generates a
   * random salt and wrapping key. If a keystore already exists,
   * throws — callers must use rotate() to change passphrase.
   */
  async initialize(passphrase) {
    if (typeof passphrase !== 'string' || passphrase.length === 0) {
      throw new Error('passphrase required');
    }
    const existing = await this._loadStore();
    if (existing) throw new Error('keystore already initialized; use rotate()');
    const salt = globalThis.crypto.getRandomValues(new Uint8Array(SALT_BYTES));
    const wrappingKey = await this._deriveWrappingKey(passphrase, salt);
    const check = await this._encryptBytes(new TextEncoder().encode(CHECK_PLAINTEXT), wrappingKey, CHECK_AAD);
    const store = {
      version: STORE_VERSION,
      salt: bytesToB64(salt),
      checkIv: bytesToB64(check.iv),
      checkCiphertext: bytesToB64(check.ciphertext),
      keys: [],
    };
    await this._saveStore(store);
    this.unlocked = { wrappingKey, salt };
    this._resetIdleTimer();
  }

  /**
   * Unlock an existing keystore with the supplied passphrase.
   * Throws if the passphrase is wrong (AES-GCM decryption failure
   * surfaces as a crypto OperationError; we normalize to a clear
   * message).
   */
  async unlock(passphrase) {
    const store = await this._loadStore();
    if (!store) throw new Error('keystore not initialized');
    const salt = b64ToBytes(store.salt);
    const wrappingKey = await this._deriveWrappingKey(passphrase, salt);
    // Verify the passphrase even when no keys exist yet. Without a
    // check record, an empty keystore would accept any passphrase.
    try {
      await this._verifyPassphraseCheck(store, wrappingKey);
    } catch (err) {
      throw new Error('invalid passphrase');
    }
    this.unlocked = { wrappingKey, salt };
    // Upgrade a legacy (pre-AAD) keystore in place now that the passphrase is
    // proven correct. Re-encrypts every record under the SAME wrapping key with
    // AAD binding. No user action, no data loss; idempotent for v2 stores.
    if (store.version !== STORE_VERSION) {
      await this._migrateToCurrent(store, wrappingKey);
    }
    this._resetIdleTimer();
  }

  /** Forget the in-memory wrapping key. Required after every signing operation per OWASP. */
  lock() {
    if (this.unlocked && this.unlocked.lockTimer) {
      clearTimeout(this.unlocked.lockTimer);
    }
    this.unlocked = null;
  }

  /**
   * Add a key to the unlocked keystore. Stores an encrypted record
   * keyed by the supplied keyId; pubKey is stored alongside in
   * plaintext for fast lookup. Both privKey and pubKey are byte
   * arrays (Uint8Array).
   */
  async addKey(keyId, privKey, pubKey, meta = {}) {
    this._requireUnlocked();
    if (!keyId || !privKey || !pubKey) {
      throw new Error('addKey: keyId, privKey, pubKey are required');
    }
    const { iv, ciphertext } = await this._encryptBytes(privKey, this.unlocked.wrappingKey, keyAAD(keyId));
    const store = await this._loadStore();
    const prior = store.keys.find(k => k.keyId === keyId);
    const entry = {
      keyId,
      iv: bytesToB64(iv),
      ciphertext: bytesToB64(ciphertext),
      // Preserve creation time when overwriting an existing slot.
      createdAt: (prior && prior.createdAt) || new Date().toISOString(),
      pubKey: bytesToB64(pubKey),
      // Provenance: 'seed' (BIP39/SLIP-0010 derived) or 'random'. derivationPath
      // is the SLIP-0010 path for seed keys. Used by recovery + key-identity.
      source: meta.source || 'random',
      derivationPath: meta.derivationPath || '',
      // Key identity (WB-09): a human label + optional purpose + last-used time.
      label: meta.label || (prior && prior.label) || '',
      purpose: meta.purpose || (prior && prior.purpose) || '',
      lastUsedAt: (prior && prior.lastUsedAt) || '',
    };
    store.keys = store.keys.filter(k => k.keyId !== keyId);
    store.keys.push(entry);
    await this._saveStore(store);
    this._resetIdleTimer();
  }

  /** Rename a key's human label. Metadata-only; does not unlock. */
  async setKeyLabel(keyId, label) {
    if (!keyId) throw new Error('setKeyLabel: keyId required');
    const store = await this._loadStore();
    if (!store) return false;
    const entry = store.keys.find(k => k.keyId === keyId);
    if (!entry) return false;
    entry.label = String(label || '');
    await this._saveStore(store);
    return true;
  }

  /**
   * Retrieve and decrypt a key by ID. Returns the plaintext
   * Uint8Array. The caller must zeroize the result after use.
   */
  async getKey(keyId) {
    this._requireUnlocked();
    const store = await this._loadStore();
    const entry = store.keys.find(k => k.keyId === keyId);
    if (!entry) throw new Error(`key ${keyId} not found`);
    const plaintext = await this._decryptEntry(entry, this.unlocked.wrappingKey, keyAAD(keyId));
    // Stamp last-used (WB-09) so the UI can show key activity. Single cheap write.
    entry.lastUsedAt = new Date().toISOString();
    await this._saveStore(store);
    this._resetIdleTimer();
    return plaintext;
  }

  async deleteKey(keyId) {
    if (!keyId) throw new Error('deleteKey: keyId required');
    const store = await this._loadStore();
    if (!store) return false;
    const before = store.keys.length;
    store.keys = store.keys.filter(k => k.keyId !== keyId);
    if (store.keys.length === before) return false;
    await this._saveStore(store);
    if (this.unlocked) this._resetIdleTimer();
    return true;
  }

  /**
   * Store the BIP39 recovery phrase (mnemonic), encrypted under the wrapping
   * key with seed-bound AAD. Storing the mnemonic (not just the derived seed)
   * lets the user reveal it later and lets the wallet derive further keys.
   * Requires an unlocked keystore.
   */
  async setSeed(mnemonic) {
    this._requireUnlocked();
    if (typeof mnemonic !== 'string' || mnemonic.length === 0) {
      throw new Error('setSeed: mnemonic required');
    }
    const { iv, ciphertext } = await this._encryptBytes(
      new TextEncoder().encode(mnemonic), this.unlocked.wrappingKey, SEED_AAD,
    );
    const store = await this._loadStore();
    store.seed = { iv: bytesToB64(iv), ciphertext: bytesToB64(ciphertext) };
    await this._saveStore(store);
    this._resetIdleTimer();
  }

  /** Decrypt and return the stored recovery phrase. Requires unlock. */
  async getSeed() {
    this._requireUnlocked();
    const store = await this._loadStore();
    if (!store || !store.seed) throw new Error('no recovery phrase stored');
    const pt = await this._decryptEntry(store.seed, this.unlocked.wrappingKey, SEED_AAD);
    this._resetIdleTimer();
    return new TextDecoder().decode(pt);
  }

  /** True if a recovery phrase is stored (does not unlock). */
  async hasSeed() {
    const store = await this._loadStore();
    return !!(store && store.seed);
  }

  /**
   * Export the raw encrypted store for backup. Ciphertext only — performs no
   * decryption and requires no unlock, so a backup never exposes a plaintext
   * key or the passphrase. Returns null when no keystore exists yet.
   */
  async exportStore() {
    return await this._loadStore();
  }

  /**
   * Replace the keystore with an imported store object (ciphertext only).
   * Validates the minimal on-disk shape and does NOT unlock — the user proves
   * the passphrase afterward by unlocking. Overwrite policy (refusing to clobber
   * an existing keystore) is enforced by the caller, not here.
   */
  async importStore(store) {
    if (!store || typeof store !== 'object') {
      throw new Error('importStore: store object required');
    }
    if (!store.salt || !store.checkIv || !store.checkCiphertext) {
      throw new Error('importStore: store missing salt / passphrase-check record');
    }
    if (!Array.isArray(store.keys)) {
      throw new Error('importStore: store.keys must be an array');
    }
    if (store.version !== 1 && store.version !== STORE_VERSION) {
      throw new Error('importStore: unsupported store version ' + store.version);
    }
    this.lock();
    await this._saveStore(store);
  }

  /** List keyId + pubKey for every stored key. Does not unlock. */
  async listKeys() {
    const store = await this._loadStore();
    if (!store) return [];
    return store.keys.map(k => ({
      keyId: k.keyId,
      pubKey: b64ToBytes(k.pubKey),
      createdAt: k.createdAt,
      source: k.source || 'random',
      derivationPath: k.derivationPath || '',
      label: k.label || '',
      purpose: k.purpose || '',
      lastUsedAt: k.lastUsedAt || '',
    }));
  }

  /**
   * Rotate the keystore to a new passphrase. The old passphrase
   * must currently unlock; on success every key is re-encrypted
   * under a fresh wrapping key derived from newPassphrase.
   */
  async rotate(oldPassphrase, newPassphrase) {
    if (newPassphrase === oldPassphrase) {
      throw new Error('rotate: new passphrase must differ from old');
    }
    // unlock() verifies the old passphrase and upgrades a legacy store to the
    // current format, so every entry below is AAD-bound under the old key.
    await this.unlock(oldPassphrase);
    const store = await this._loadStore();
    const oldKeys = [];
    // Zeroize every decrypted private key on every exit path — including a
    // failure mid-decrypt — so plaintext keys never linger for GC. The decrypt
    // loop is inside the try precisely so a partial decrypt is still cleaned up.
    try {
      for (const entry of store.keys) {
        const pt = await this._decryptEntry(entry, this.unlocked.wrappingKey, keyAAD(entry.keyId));
        oldKeys.push({ keyId: entry.keyId, pubKey: b64ToBytes(entry.pubKey), priv: pt, createdAt: entry.createdAt });
      }
      const newSalt = globalThis.crypto.getRandomValues(new Uint8Array(SALT_BYTES));
      const newWrappingKey = await this._deriveWrappingKey(newPassphrase, newSalt);
      const check = await this._encryptBytes(new TextEncoder().encode(CHECK_PLAINTEXT), newWrappingKey, CHECK_AAD);
      const newEntries = [];
      for (const k of oldKeys) {
        const encrypted = await this._encryptBytes(k.priv, newWrappingKey, keyAAD(k.keyId));
        newEntries.push({
          keyId: k.keyId,
          iv: bytesToB64(encrypted.iv),
          ciphertext: bytesToB64(encrypted.ciphertext),
          // Preserve the original key age across rotation.
          createdAt: k.createdAt || new Date().toISOString(),
          pubKey: bytesToB64(k.pubKey),
        });
      }
      // Carry the recovery-phrase record forward under the new wrapping key so
      // rotating the passphrase never drops the seed. this.unlocked still holds
      // the OLD wrapping key here (reassigned only after the save below).
      let seedRecord = null;
      if (store.seed) {
        const seedPt = await this._decryptEntry(store.seed, this.unlocked.wrappingKey, SEED_AAD);
        try {
          const e = await this._encryptBytes(seedPt, newWrappingKey, SEED_AAD);
          seedRecord = { iv: bytesToB64(e.iv), ciphertext: bytesToB64(e.ciphertext) };
        } finally {
          seedPt.fill(0);
        }
      }
      const newStore = {
        version: STORE_VERSION,
        salt: bytesToB64(newSalt),
        checkIv: bytesToB64(check.iv),
        checkCiphertext: bytesToB64(check.ciphertext),
        keys: newEntries,
      };
      if (seedRecord) newStore.seed = seedRecord;
      await this._saveStore(newStore);
      this.unlocked = { wrappingKey: newWrappingKey, salt: newSalt };
      this._resetIdleTimer();
    } finally {
      for (const k of oldKeys) {
        if (k.priv) k.priv.fill(0);
      }
    }
  }

  // --- internals -----------------------------------------------

  async _deriveWrappingKey(passphrase, salt) {
    const baseKey = await this.subtle.importKey(
      'raw',
      new TextEncoder().encode(passphrase),
      { name: 'PBKDF2' },
      false,
      ['deriveKey'],
    );
    return this.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  }

  async _decryptEntry(entry, wrappingKey, aad) {
    const iv = b64ToBytes(entry.iv);
    const ct = b64ToBytes(entry.ciphertext);
    const params = { name: 'AES-GCM', iv };
    if (aad) params.additionalData = aad;
    const pt = await this.subtle.decrypt(params, wrappingKey, ct);
    return new Uint8Array(pt);
  }

  async _encryptBytes(bytes, wrappingKey, aad) {
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const params = { name: 'AES-GCM', iv };
    if (aad) params.additionalData = aad;
    const ct = await this.subtle.encrypt(params, wrappingKey, bytes);
    return { iv, ciphertext: new Uint8Array(ct) };
  }

  async _verifyPassphraseCheck(store, wrappingKey) {
    if (!store.checkIv || !store.checkCiphertext) {
      throw new Error('keystore missing passphrase verification record');
    }
    // v2 records bind the check with CHECK_AAD; v1 records carry no AAD. Choose
    // by the store's declared version so a legacy store still verifies (and can
    // then migrate). A wrong passphrase fails GCM auth either way.
    const aad = store.version === STORE_VERSION ? CHECK_AAD : null;
    const pt = await this._decryptEntry(
      { iv: store.checkIv, ciphertext: store.checkCiphertext },
      wrappingKey,
      aad,
    );
    const decoded = new TextDecoder().decode(pt);
    if (decoded !== CHECK_PLAINTEXT) {
      throw new Error('keystore passphrase verification mismatch');
    }
  }

  // _migrateToCurrent upgrades a legacy (v1, no-AAD) store to the current
  // format: it re-encrypts every record under the SAME wrapping key with AAD
  // binding and stamps `version`. Called from unlock() only after the
  // passphrase is verified, so it never runs on an unverified store. Transient
  // plaintexts are zeroized; the save is a single atomic write.
  async _migrateToCurrent(store, wrappingKey) {
    const newKeys = [];
    for (const entry of store.keys) {
      const pt = await this._decryptEntry(entry, wrappingKey, null); // legacy: no AAD
      try {
        const { iv, ciphertext } = await this._encryptBytes(pt, wrappingKey, keyAAD(entry.keyId));
        newKeys.push({ ...entry, iv: bytesToB64(iv), ciphertext: bytesToB64(ciphertext) });
      } finally {
        pt.fill(0);
      }
    }
    const check = await this._encryptBytes(new TextEncoder().encode(CHECK_PLAINTEXT), wrappingKey, CHECK_AAD);
    const migrated = {
      ...store,
      version: STORE_VERSION,
      checkIv: bytesToB64(check.iv),
      checkCiphertext: bytesToB64(check.ciphertext),
      keys: newKeys,
    };
    await this._saveStore(migrated);
  }

  async _loadStore() {
    const raw = await this.storage.get(STORAGE_KEY);
    if (!raw) return null;
    if (raw[STORAGE_KEY]) return raw[STORAGE_KEY];
    // Direct-shape fallback (store stored without the key wrapper). Accept any
    // known schema version so both v1 (pre-migration) and v2 load.
    if (typeof raw.version === 'number') return raw;
    return null;
  }

  async _saveStore(store) {
    await this.storage.set({ [STORAGE_KEY]: store });
  }

  _requireUnlocked() {
    if (!this.unlocked) throw new Error('keystore is locked');
  }

  _resetIdleTimer() {
    if (this.unlocked.lockTimer) clearTimeout(this.unlocked.lockTimer);
    this.unlocked.lockAt = Date.now() + this.idleTimeoutMs;
    this.unlocked.lockTimer = setTimeout(() => this.lock(), this.idleTimeoutMs);
    if (typeof this.unlocked.lockTimer.unref === 'function') {
      this.unlocked.lockTimer.unref();
    }
  }

  /**
   * Milliseconds until the idle auto-lock fires, or 0 when locked. Lets the
   * popup render a live "locks in M:SS" countdown. (In an MV3 service worker
   * the worker may be evicted before the timer fires — eviction is itself an
   * auto-lock, since the in-memory wrapping key is lost.)
   */
  remainingMs() {
    if (!this.unlocked || !this.unlocked.lockAt) return 0;
    return Math.max(0, this.unlocked.lockAt - Date.now());
  }
}

// --- base64 helpers -------------------------------------------

function bytesToB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
