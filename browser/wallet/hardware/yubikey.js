// Copyright 2024 The Infrix Authors
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.

// ============================================================================
// STATUS: NOT WIRED — contract sketch only. (WB-11 §A)
//
// This driver is NOT used by the extension. Critically, its sign() returns a
// WebAuthn ASSERTION signature (over authenticatorData ‖ SHA-256(clientDataJSON)),
// which is NOT a raw Ed25519 signature over the message and will NOT verify
// against the Infrix approval payload — despite the "ED25519 signature" wording
// below. The rpId default ('infrix.local') is also invalid for a
// chrome-extension origin. Do NOT wire this as a transaction signer.
//
// The correct, achievable role (WB-08 Path A) is YubiKey as a 2FA *unlock*
// factor (WebAuthn user-verification gating keystore unlock), which needs no
// device app and produces no signature. A passing hardware.test.mjs run does
// NOT imply a working hardware signer.
// ============================================================================

// G-25 phase 1b — YubiKey ED25519 driver (scaffold).
//
// Drives a YubiKey via WebAuthn for ED25519 signatures. WebAuthn
// is the canonical browser API for FIDO2 hardware tokens; newer
// YubiKey 5 series devices expose ED25519 directly via the
// COSE_Algorithm.EDDSA (-8) algorithm identifier.
//
// Protocol shape (WebAuthn assertion):
//   - registerCredential(rpId, userHandle): get a fresh ED25519 keypair
//     bound to (rpId, userHandle); device prompts for user presence
//   - sign(challenge, allowCredentials): assertion-mode signing;
//     device prompts for user presence and returns a CBOR-encoded
//     authenticatorData + clientDataJSON + ed25519 signature
//
// The driver implements the two-call shape; production wiring
// uses the browser's `navigator.credentials.create` /
// `navigator.credentials.get` directly. Tests pass a fake
// credentialsAdapter to exercise the contract.

const COSE_ALG_EDDSA = -8;

/**
 * YubiKeyEd25519Driver dispatches WebAuthn calls to a connected
 * YubiKey for ED25519 signing. The driver is constructor-injected
 * with the credentialsAdapter (defaults to navigator.credentials)
 * so tests pass a fake.
 */
export class YubiKeyEd25519Driver {
  /**
   * @param {object} opts
   * @param {object=} opts.credentials WebAuthn-shaped credentials
   *   adapter (must expose .create and .get). Defaults to
   *   navigator.credentials when available.
   * @param {string=} opts.rpId Relying-party identifier; defaults
   *   to "infrix.local". Production wiring sets this to the
   *   operator's actual extension origin.
   */
  constructor(opts = {}) {
    this.credentials = opts.credentials || null;
    if (!this.credentials && typeof globalThis !== 'undefined' &&
        globalThis.navigator && globalThis.navigator.credentials) {
      this.credentials = globalThis.navigator.credentials;
    }
    this.rpId = opts.rpId || 'infrix.local';
    this.name = 'yubikey';
  }

  /**
   * Returns true if a WebAuthn-capable credentials adapter is
   * available. WebAuthn does not provide a "list connected
   * authenticators" API — we proxy via the platform-credentials
   * detection method when the adapter exposes one.
   */
  async available() {
    if (!this.credentials) return false;
    if (typeof this.credentials.isUserVerifyingPlatformAuthenticatorAvailable === 'function') {
      try {
        return await this.credentials.isUserVerifyingPlatformAuthenticatorAvailable();
      } catch (_) {
        return false;
      }
    }
    // Fallback: declare available if the adapter exposes the
    // canonical create/get pair. Tests that pass a fake adapter
    // exercising a YubiKey path land here.
    return typeof this.credentials.create === 'function' &&
           typeof this.credentials.get === 'function';
  }

  /**
   * Register a fresh ED25519 keypair on the YubiKey. The device
   * prompts for user presence + PIN. Returns the credential ID
   * (32-byte handle) the caller stores alongside the wallet ADI;
   * subsequent sign calls reference this handle.
   */
  async registerCredential(userHandle, displayName) {
    if (!this.credentials) {
      throw new Error('yubikey: WebAuthn unavailable');
    }
    const challenge = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const cred = await this.credentials.create({
      publicKey: {
        rp: { id: this.rpId, name: 'Infrix Wallet' },
        user: {
          id: userHandle,
          name: displayName || 'wallet',
          displayName: displayName || 'wallet',
        },
        pubKeyCredParams: [{ type: 'public-key', alg: COSE_ALG_EDDSA }],
        authenticatorSelection: {
          authenticatorAttachment: 'cross-platform',
          userVerification: 'required',
        },
        challenge,
        timeout: 60_000,
      },
    });
    if (!cred) {
      throw new Error('yubikey: credential creation declined');
    }
    return new Uint8Array(cred.rawId);
  }

  /**
   * Sign a message via WebAuthn assertion. The challenge is the
   * raw message bytes (the Infrix wallet wraps governance plan
   * hashes here so the device prompts the user with a stable
   * digest). Returns the device's 64-byte ED25519 signature
   * over the assertion structure (clientDataHash || authData).
   *
   * @param {Uint8Array} message
   * @returns {Promise<Uint8Array>} 64-byte signature
   */
  async sign(message) {
    if (!(message instanceof Uint8Array)) {
      throw new TypeError('yubikey.sign: message must be Uint8Array');
    }
    if (!this.credentials) {
      throw new Error('yubikey: WebAuthn unavailable');
    }
    if (!this._credentialId) {
      throw new Error('yubikey: registerCredential must be called first');
    }
    const assertion = await this.credentials.get({
      publicKey: {
        challenge: message,
        rpId: this.rpId,
        allowCredentials: [{ type: 'public-key', id: this._credentialId }],
        userVerification: 'required',
        timeout: 60_000,
      },
    });
    if (!assertion || !assertion.response || !assertion.response.signature) {
      throw new Error('yubikey: assertion declined or malformed');
    }
    return new Uint8Array(assertion.response.signature);
  }

  /**
   * Bind the credentialId returned by registerCredential. Tests
   * call this directly with a synthetic ID to skip the registration
   * round-trip; production code calls registerCredential at first
   * use and persists the result alongside the wallet ADI.
   */
  setCredentialId(credentialId) {
    if (!(credentialId instanceof Uint8Array)) {
      throw new TypeError('yubikey.setCredentialId: must be Uint8Array');
    }
    this._credentialId = credentialId;
  }
}
