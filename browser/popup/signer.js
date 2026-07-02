/**
 * Infrix Wallet — signer seam (WB-06).
 *
 * Abstracts WHERE an approval signature comes from. The background remains the
 * sole assembler/submitter of the approval envelope; this only PRODUCES the
 * signature over the canonical payload bytes:
 *
 *   - 'software': the background keystore signs (wallet.signPayload).
 *   - 'ledger' / 'yubikey' (WB-07 / WB-08): the device signs here in the popup,
 *     where WebHID / WebAuthn exist (they are unavailable in the MV3 service
 *     worker, which is why signing orchestration lives in the popup).
 *
 * sign() returns { signature, publicKey, algorithm, signer }. availableSigners()
 * lists what the user can pick right now (software always; hardware when a
 * device is detected — hardware producers register via registerHardware()).
 */
(function () {
  'use strict';

  class WalletSigner {
    constructor(sendMessage) {
      this.send = sendMessage;
      this._hardware = []; // [{ id, label, detect(): Promise<bool>, sign({payload}): Promise<{signature,publicKey,algorithm}> }]
    }

    // registerHardware lets WB-07/08 plug in device producers without this file
    // depending on the drivers.
    registerHardware(producer) {
      if (producer && producer.id) this._hardware.push(producer);
    }

    async availableSigners() {
      const list = [{ id: 'software', label: 'This device' }];
      for (const hw of this._hardware) {
        try {
          if (await hw.detect()) list.push({ id: hw.id, label: hw.label });
        } catch (_) { /* a flaky device just doesn't appear in the list */ }
      }
      return list;
    }

    async sign({ payload, signer = 'software', passphrase, keyId }) {
      if (!payload) throw new Error('signer: payload required');
      if (signer === 'software') {
        const res = await this.send({ type: 'wallet.signPayload', payload, passphrase, keyId });
        if (!res || res.error) {
          const e = new Error((res && res.error) || 'signing failed');
          e.code = res && res.code;
          throw e;
        }
        return { signature: res.signature, publicKey: res.publicKey, algorithm: res.algorithm || 'ed25519', signer: 'software' };
      }
      const hw = this._hardware.find((h) => h.id === signer);
      if (!hw) throw new Error('unknown signer: ' + signer);
      const out = await hw.sign({ payload });
      return { signature: out.signature, publicKey: out.publicKey, algorithm: out.algorithm || 'ed25519', signer };
    }
  }

  if (typeof window !== 'undefined') window.WalletSigner = WalletSigner;
})();
