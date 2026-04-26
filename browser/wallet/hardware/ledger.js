// Copyright 2024 The Infrix Authors
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.

// G-25 phase 1b — Ledger ED25519 driver.
//
// Drives a Ledger device over WebHID for ED25519 signing. The
// transport is constructor-injected so tests can pass a fake
// WebHID device; production passes navigator.hid (or a thin
// wrapper that handles the native WebHID resync semantics).
//
// Protocol shape (Ledger ED25519 app):
//   - GET_PUBLIC_KEY: CLA=0xE0 INS=0x02
//   - SIGN_MESSAGE:   CLA=0xE0 INS=0x04 (chunked for messages > 200B)
//
// This driver implements the protocol shape, NOT a full Ledger
// transport. Real production wiring uses @ledgerhq/hw-transport-webhid
// or an equivalent library that handles the device handshake,
// chunking, and APDU framing. The shape here is the contract every
// such driver satisfies; tests exercise the contract via a fake
// transport.

const LEDGER_VENDOR_ID = 0x2c97; // Ledger
const APDU_CLA = 0xe0;
const INS_GET_PUBLIC_KEY = 0x02;
const INS_SIGN_MESSAGE = 0x04;
const APDU_CHUNK_BYTES = 200;
const APDU_OK = 0x9000;

/**
 * LedgerEd25519Driver is the dispatcher-callable Ledger driver.
 */
export class LedgerEd25519Driver {
  /**
   * @param {object} opts
   * @param {object=} opts.transport WebHID-shaped transport; defaults to
   *   `navigator.hid` if available, else null (driver reports unavailable).
   */
  constructor(opts = {}) {
    this.transport = opts.transport || null;
    if (!this.transport && typeof globalThis !== 'undefined' &&
        globalThis.navigator && globalThis.navigator.hid) {
      this.transport = globalThis.navigator.hid;
    }
    this.name = 'ledger';
  }

  /**
   * Returns true if a Ledger device is currently reachable.
   */
  async available() {
    if (!this.transport) return false;
    try {
      const devices = await this.transport.getDevices();
      return Array.isArray(devices) && devices.some(d => d.vendorId === LEDGER_VENDOR_ID);
    } catch (_) {
      return false;
    }
  }

  /**
   * Returns the device's ED25519 public key. Cached per session
   * so repeat signatures don't re-prompt the user.
   */
  async getPublicKey() {
    if (this._cachedPubKey) return this._cachedPubKey;
    const apdu = framedAPDU(APDU_CLA, INS_GET_PUBLIC_KEY, 0x00, 0x00, new Uint8Array(0));
    const response = await this._exchange(apdu);
    const { data, sw } = unpackResponse(response);
    if (sw !== APDU_OK) {
      throw new Error(`ledger: GET_PUBLIC_KEY status ${sw.toString(16)}`);
    }
    if (data.length < 32) {
      throw new Error(`ledger: GET_PUBLIC_KEY returned ${data.length} bytes, want ≥32`);
    }
    this._cachedPubKey = data.slice(0, 32);
    return this._cachedPubKey;
  }

  /**
   * Sign the supplied message. Chunks the message at 200-byte
   * boundaries per Ledger APDU constraints; the last chunk
   * triggers the user prompt on the device screen.
   *
   * @param {Uint8Array} message
   * @returns {Promise<Uint8Array>} 64-byte ED25519 signature
   */
  async sign(message) {
    if (!(message instanceof Uint8Array)) {
      throw new TypeError('ledger.sign: message must be Uint8Array');
    }
    if (!this.transport) {
      throw new Error('ledger: transport unavailable');
    }
    let signature = null;
    for (let off = 0; off < Math.max(message.length, 1); off += APDU_CHUNK_BYTES) {
      const chunk = message.subarray(off, Math.min(off + APDU_CHUNK_BYTES, message.length));
      const isLast = off + APDU_CHUNK_BYTES >= message.length;
      const p1 = isLast ? 0x80 : 0x00; // 0x80 = "last chunk, sign now"
      const apdu = framedAPDU(APDU_CLA, INS_SIGN_MESSAGE, p1, 0x00, chunk);
      const response = await this._exchange(apdu);
      const { data, sw } = unpackResponse(response);
      if (sw !== APDU_OK) {
        throw new Error(`ledger: SIGN_MESSAGE status ${sw.toString(16)}`);
      }
      if (isLast) {
        if (data.length !== 64) {
          throw new Error(`ledger: SIGN_MESSAGE returned ${data.length} bytes, want 64`);
        }
        signature = data;
      }
    }
    if (!signature) {
      throw new Error('ledger: signature absent on last chunk');
    }
    return signature;
  }

  async _exchange(apdu) {
    if (typeof this.transport.exchange !== 'function') {
      throw new Error('ledger: transport.exchange unavailable');
    }
    return await this.transport.exchange(apdu);
  }
}

// framedAPDU produces a properly-framed APDU command per Ledger's
// contract: CLA INS P1 P2 LC DATA. LC is omitted when DATA is empty.
function framedAPDU(cla, ins, p1, p2, data) {
  const lc = data.length;
  const out = new Uint8Array(5 + lc);
  out[0] = cla;
  out[1] = ins;
  out[2] = p1;
  out[3] = p2;
  out[4] = lc;
  out.set(data, 5);
  return out;
}

// unpackResponse separates the response data from the SW1/SW2
// status pair. Ledger appends two status bytes to every response;
// 0x9000 is OK, anything else is an error.
function unpackResponse(response) {
  if (!(response instanceof Uint8Array) || response.length < 2) {
    throw new Error('ledger: response too short');
  }
  const data = response.slice(0, response.length - 2);
  const sw = (response[response.length - 2] << 8) | response[response.length - 1];
  return { data, sw };
}
