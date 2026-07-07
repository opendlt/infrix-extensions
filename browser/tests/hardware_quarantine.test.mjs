// WB-11 §A — hardware scaffold quarantine fence.
//
// The Ledger/YubiKey hardware drivers are NOT WIRED (WB-07 is PARKED on a
// protocol incompatibility; WB-08 is pending). This fence keeps that state
// HONEST: it fails if a "NOT WIRED" banner is removed, or if any shipping
// (non-test, non-vendor) extension file starts importing a hardware driver
// without the wiring being made real. When hardware is genuinely wired, flip
// this fence to assert popup/signer.js imports the driver(s) instead.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readExtensionFile } from './harness.mjs';

const DRIVERS = ['wallet/hardware/hardware.js', 'wallet/hardware/ledger.js', 'wallet/hardware/yubikey.js'];

test('each hardware driver carries an explicit NOT WIRED banner', async () => {
  for (const f of DRIVERS) {
    const src = await readExtensionFile(f);
    assert.ok(src.includes('STATUS: NOT WIRED'), `${f} must keep its NOT WIRED banner until hardware is genuinely wired`);
  }
});

test('no shipping extension code imports the hardware drivers', async () => {
  // The signer seam (popup/signer.js) can REFERENCE a registerHardware hook,
  // but no shipping file may IMPORT a driver while they are unwired.
  const shipping = [
    'background.js', 'content.js', 'cinema-widget.js', 'debug-panel.js',
    'popup/popup.js', 'popup/plan-approval.js', 'popup/signer.js', 'popup/api.js',
  ];
  const forbidden = /(from|require\()\s*['"][^'"]*wallet\/hardware\/(hardware|ledger|yubikey)\.js['"]/;
  for (const f of shipping) {
    const src = await readExtensionFile(f);
    assert.equal(forbidden.test(src), false, `${f} must not import a hardware driver while it is NOT WIRED`);
  }
});

test('hardware contract tests are labelled as scaffold (not real-device)', async () => {
  const src = await readExtensionFile('wallet/hardware/hardware.test.mjs');
  assert.ok(src.includes('CONTRACT (scaffold)'), 'hardware.test.mjs must declare itself a scaffold/contract test');
});

test('no shipping extension code wires a hardware producer into the signer seam', async () => {
  // popup/signer.js DEFINES registerHardware(producer){...} (the seam), but no
  // shipping file may CALL it while hardware is NOT WIRED. A registered producer
  // is exactly what would surface a Ledger/YubiKey option in
  // WalletSigner.availableSigners() — i.e. a production-facing CLAIM that hardware
  // signing works. Keeping registerHardware un-called guarantees the signer UI is
  // software-only, so the extension never advertises hardware signing as available
  // (pass-19 audit P2-4). This is the structural resolution of P2-4's "remove
  // hardware signing from production-facing claims": enforced by fence, not left
  // to inspection. Flip this to REQUIRE the wiring once a hardware driver is
  // genuinely wired and device-certified.
  const shipping = [
    'background.js', 'content.js', 'cinema-widget.js', 'debug-panel.js',
    'popup/popup.js', 'popup/plan-approval.js', 'popup/api.js',
  ];
  const callsRegister = /\.registerHardware\s*\(/;
  for (const f of shipping) {
    const src = await readExtensionFile(f);
    assert.equal(callsRegister.test(src), false, `${f} must not wire a hardware producer (registerHardware) into the signer seam while hardware is NOT WIRED`);
  }
});
