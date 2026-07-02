// Copyright 2024 The Infrix Authors
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.

// G-25 phase 1b — hardware-key dispatcher CONTRACT (scaffold) tests.
//
// IMPORTANT (WB-11 §A): these exercise the SCAFFOLD contract only. They do NOT
// run against a real device, do NOT use the real Accumulate Ledger protocol
// (app-accumulate/doc/COMMANDS.md), and do NOT prove on-chain-verifiable
// signatures. A green run here does NOT mean hardware signing works — the
// drivers are NOT WIRED into the extension (see their file banners + WB-07
// PARKED / WB-08). Replace with real-transport + on-chain-verification tests
// when a hardware producer is actually wired into popup/signer.js.
//
// Run with: node --test extension/wallet/hardware/hardware.test.mjs
// Requires Node 20+ (built-in webcrypto + node:test).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HardwareKeyDispatcher } from './hardware.js';
import { LedgerEd25519Driver } from './ledger.js';
import { YubiKeyEd25519Driver } from './yubikey.js';

// Fake transport that mimics WebHID's getDevices + exchange shape.
function fakeLedgerTransport({ available = true, signature = null }) {
  return {
    async getDevices() {
      return available ? [{ vendorId: 0x2c97 }] : [];
    },
    async exchange(apdu) {
      // Ledger APDUs end with SW1/SW2. Echo a status of 0x9000
      // followed by the requested data. INS at apdu[1].
      const ins = apdu[1];
      if (ins === 0x02) {
        // GET_PUBLIC_KEY → 32 bytes pub + 0x9000
        const out = new Uint8Array(34);
        for (let i = 0; i < 32; i++) out[i] = i + 1;
        out[32] = 0x90;
        out[33] = 0x00;
        return out;
      }
      if (ins === 0x04) {
        // SIGN_MESSAGE → 64 bytes sig (only on last chunk) + 0x9000
        const p1 = apdu[2];
        if (p1 === 0x80 && signature) {
          const out = new Uint8Array(66);
          out.set(signature, 0);
          out[64] = 0x90;
          out[65] = 0x00;
          return out;
        }
        // Intermediate chunk — empty body + OK
        return new Uint8Array([0x90, 0x00]);
      }
      throw new Error(`fake ledger: unexpected INS ${ins}`);
    },
  };
}

test('dispatcher returns null when no hardware', async () => {
  const dispatcher = new HardwareKeyDispatcher({
    ledger: new LedgerEd25519Driver({ transport: fakeLedgerTransport({ available: false }) }),
    yubikey: new YubiKeyEd25519Driver({ credentials: null }),
    detectionTimeoutMs: 50,
  });
  const driver = await dispatcher.detect();
  assert.equal(driver, null);
});

test('dispatcher detects Ledger when available', async () => {
  const dispatcher = new HardwareKeyDispatcher({
    ledger: new LedgerEd25519Driver({ transport: fakeLedgerTransport({ available: true }) }),
    yubikey: new YubiKeyEd25519Driver({ credentials: null }),
    detectionTimeoutMs: 50,
  });
  const driver = await dispatcher.detect();
  assert.notEqual(driver, null);
  assert.equal(driver.name, 'ledger');
});

test('dispatcher.sign falls back to software when no hardware', async () => {
  const dispatcher = new HardwareKeyDispatcher({
    ledger: new LedgerEd25519Driver({ transport: fakeLedgerTransport({ available: false }) }),
    yubikey: new YubiKeyEd25519Driver({ credentials: null }),
    detectionTimeoutMs: 50,
  });
  const message = new Uint8Array(32).fill(0x42);
  const result = await dispatcher.sign(message);
  assert.equal(result.signature, null);
  assert.equal(result.driver, null);
  assert.equal(result.fallback, 'software');
});

test('dispatcher.sign routes through Ledger when available', async () => {
  const sig = new Uint8Array(64);
  for (let i = 0; i < 64; i++) sig[i] = i;
  const dispatcher = new HardwareKeyDispatcher({
    ledger: new LedgerEd25519Driver({ transport: fakeLedgerTransport({ available: true, signature: sig }) }),
    yubikey: new YubiKeyEd25519Driver({ credentials: null }),
    detectionTimeoutMs: 50,
  });
  const message = new Uint8Array(32).fill(0x42);
  const result = await dispatcher.sign(message);
  assert.equal(result.driver, 'ledger');
  assert.equal(result.fallback, null);
  assert.deepEqual(result.signature, sig);
});

test('Ledger.getPublicKey caches across calls', async () => {
  const transport = fakeLedgerTransport({ available: true });
  let calls = 0;
  const wrapped = {
    ...transport,
    async exchange(apdu) {
      calls++;
      return await transport.exchange(apdu);
    },
  };
  const ledger = new LedgerEd25519Driver({ transport: wrapped });
  const pk1 = await ledger.getPublicKey();
  const pk2 = await ledger.getPublicKey();
  assert.deepEqual(pk1, pk2);
  assert.equal(calls, 1, 'second getPublicKey should hit cache');
});

test('Ledger.sign chunks long messages', async () => {
  const sig = new Uint8Array(64).fill(0xee);
  const transport = fakeLedgerTransport({ available: true, signature: sig });
  const exchanges = [];
  const wrapped = {
    ...transport,
    async exchange(apdu) {
      exchanges.push(apdu);
      return await transport.exchange(apdu);
    },
  };
  const ledger = new LedgerEd25519Driver({ transport: wrapped });
  // 500 bytes → 3 chunks (200 + 200 + 100), last chunk has p1=0x80
  const message = new Uint8Array(500).fill(0x33);
  const got = await ledger.sign(message);
  assert.deepEqual(got, sig);
  assert.equal(exchanges.length, 3, 'expected 3 SIGN_MESSAGE chunks for 500-byte message');
  // First two chunks p1=0x00; last p1=0x80
  assert.equal(exchanges[0][2], 0x00);
  assert.equal(exchanges[1][2], 0x00);
  assert.equal(exchanges[2][2], 0x80);
});

test('YubiKey reports unavailable when no credentials adapter', async () => {
  const yk = new YubiKeyEd25519Driver({ credentials: null });
  const ok = await yk.available();
  assert.equal(ok, false);
});

test('YubiKey.sign rejects without registered credential', async () => {
  const yk = new YubiKeyEd25519Driver({
    credentials: {
      async create() { return { rawId: new ArrayBuffer(32) }; },
      async get() { return { response: { signature: new ArrayBuffer(64) } }; },
    },
  });
  await assert.rejects(
    () => yk.sign(new Uint8Array(32)),
    /registerCredential must be called first/,
  );
});

test('YubiKey.sign produces signature when credential bound', async () => {
  const expectedSig = new Uint8Array(64).fill(0x77);
  const yk = new YubiKeyEd25519Driver({
    credentials: {
      async create(req) {
        return { rawId: new Uint8Array(32).fill(1).buffer };
      },
      async get(req) {
        return {
          response: { signature: expectedSig.buffer.slice(0) },
        };
      },
    },
  });
  yk.setCredentialId(new Uint8Array(32).fill(1));
  const sig = await yk.sign(new Uint8Array(32).fill(2));
  assert.deepEqual(sig, expectedSig);
});

test('dispatcher prefers Ledger over YubiKey when both available', async () => {
  const ledgerSig = new Uint8Array(64).fill(0xaa);
  const yubikeyAdapter = {
    async create() { return { rawId: new ArrayBuffer(32) }; },
    async get() { return { response: { signature: new ArrayBuffer(64) } }; },
    // declared available
    async isUserVerifyingPlatformAuthenticatorAvailable() { return true; },
  };
  const dispatcher = new HardwareKeyDispatcher({
    ledger: new LedgerEd25519Driver({ transport: fakeLedgerTransport({ available: true, signature: ledgerSig }) }),
    yubikey: new YubiKeyEd25519Driver({ credentials: yubikeyAdapter }),
    detectionTimeoutMs: 50,
  });
  const driver = await dispatcher.detect();
  assert.equal(driver.name, 'ledger', 'Ledger should win when both available');
  const result = await dispatcher.sign(new Uint8Array(32).fill(3));
  assert.deepEqual(result.signature, ledgerSig);
});
