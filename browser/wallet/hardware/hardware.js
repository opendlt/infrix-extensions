// Copyright 2024 The Infrix Authors
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.

// G-25 phase 1b — hardware-key dispatcher.
//
// HardwareKeyDispatcher is the single seam the popup's plan-approval
// flow consults to decide between hardware-key signing (Ledger /
// YubiKey via WebHID + WebAuthn) and the software keystore
// fallback. Detection is best-effort: if no device responds within
// the detection budget, the dispatcher reports "no hardware" and
// the caller falls back to the EncryptedKeystore.
//
// The dispatcher is constructor-injected so tests can pass
// fake transport adapters; production passes real WebHID +
// WebAuthn adapters. The protocol shape is the canonical
// `(adapter, sign(message)) → signature` contract every device
// driver implements.
//
// Thread-safety: every signing call is independently safe — the
// dispatcher holds no shared mutable state across calls. The
// underlying transports are responsible for their own connection
// pooling.

import { LedgerEd25519Driver } from './ledger.js';
import { YubiKeyEd25519Driver } from './yubikey.js';

/**
 * HardwareKeyDispatcher dispatches a sign request to the first
 * available hardware key, or reports "no hardware" so the caller
 * can fall back to the software keystore.
 */
export class HardwareKeyDispatcher {
  /**
   * @param {object} opts
   * @param {LedgerEd25519Driver=} opts.ledger
   * @param {YubiKeyEd25519Driver=} opts.yubikey
   * @param {number=} opts.detectionTimeoutMs Default 2000ms.
   */
  constructor(opts = {}) {
    this.ledger = opts.ledger || new LedgerEd25519Driver();
    this.yubikey = opts.yubikey || new YubiKeyEd25519Driver();
    this.detectionTimeoutMs = opts.detectionTimeoutMs || 2000;
  }

  /**
   * Detect any connected hardware key. Returns the first available
   * driver, or null when none responds within the detection budget.
   * Drivers are probed in order: Ledger first (more common in the
   * institutional-pilot demographic), then YubiKey.
   */
  async detect() {
    if (await this._tryAvailable(this.ledger)) return this.ledger;
    if (await this._tryAvailable(this.yubikey)) return this.yubikey;
    return null;
  }

  /**
   * Sign the supplied message with the first available hardware
   * key. If no hardware is available, returns { signature: null,
   * fallback: 'software' } so the caller routes through the
   * software keystore. If a device is present but rejects the
   * signing request, the rejection bubbles as an error.
   *
   * @param {Uint8Array} message
   * @returns {Promise<{signature: Uint8Array|null, driver: string|null, fallback: string|null}>}
   */
  async sign(message) {
    if (!(message instanceof Uint8Array)) {
      throw new TypeError('sign: message must be Uint8Array');
    }
    const driver = await this.detect();
    if (!driver) {
      return { signature: null, driver: null, fallback: 'software' };
    }
    const signature = await driver.sign(message);
    return { signature, driver: driver.name, fallback: null };
  }

  async _tryAvailable(driver) {
    if (!driver || typeof driver.available !== 'function') return false;
    return await this._withTimeout(driver.available(), this.detectionTimeoutMs);
  }

  async _withTimeout(promise, ms) {
    return await Promise.race([
      promise,
      new Promise(resolve => setTimeout(() => resolve(false), ms)),
    ]);
  }
}
