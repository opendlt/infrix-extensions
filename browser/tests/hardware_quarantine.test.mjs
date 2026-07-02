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
