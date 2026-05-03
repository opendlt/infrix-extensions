// Copyright 2024 The Infrix Authors
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.

// P2-003 closure — manifest validity fence.
//
// extension/manifest.json drives the Chrome MV3 install: bad fields
// silently break the extension at install time. This fence asserts
// the load-bearing structural invariants the rest of the test suite
// implicitly assumes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readExtensionFile } from './harness.mjs';

let manifest = null;

test('manifest.json parses as JSON', async () => {
  const raw = await readExtensionFile('manifest.json');
  manifest = JSON.parse(raw);
  assert.ok(manifest, 'manifest must parse');
});

test('manifest.json declares MV3', async () => {
  if (!manifest) manifest = JSON.parse(await readExtensionFile('manifest.json'));
  assert.equal(manifest.manifest_version, 3,
    'P2-003: extension must remain on MV3 — MV2 is end-of-life and Chrome will not accept new MV2 installs.');
});

test('manifest.json declares background as a module service worker', async () => {
  if (!manifest) manifest = JSON.parse(await readExtensionFile('manifest.json'));
  assert.ok(manifest.background, 'manifest.background must be set');
  assert.equal(manifest.background.type, 'module',
    'background must declare type=module so background.js can use ESM imports the test harness exercises');
  assert.equal(manifest.background.service_worker, 'background.js',
    'background service_worker must point at background.js');
});

test('manifest.json registers content.js at document_start', async () => {
  if (!manifest) manifest = JSON.parse(await readExtensionFile('manifest.json'));
  assert.ok(Array.isArray(manifest.content_scripts) && manifest.content_scripts.length === 1,
    'exactly one content_scripts entry expected');
  const cs = manifest.content_scripts[0];
  assert.ok(cs.js && cs.js.includes('content.js'), 'content_scripts must include content.js');
  assert.equal(cs.run_at, 'document_start',
    'content script must run_at=document_start so window.infrix is available before dApp code executes');
});

test('manifest.json declares only the storage + activeTab permissions', async () => {
  if (!manifest) manifest = JSON.parse(await readExtensionFile('manifest.json'));
  const perms = (manifest.permissions || []).slice().sort();
  // Locking the permission set is doctrine: surplus permissions widen
  // the trust boundary the user grants on install. Adding anything
  // here is a deliberate doctrine choice, not a quiet drift.
  assert.deepEqual(perms, ['activeTab', 'storage'].sort(),
    'P2-003: extension permissions must remain ["storage", "activeTab"] only; adding any other permission widens the trust boundary the user grants at install.');
});

test('manifest.json declares no broad host permissions outside localhost', async () => {
  if (!manifest) manifest = JSON.parse(await readExtensionFile('manifest.json'));
  const hosts = manifest.host_permissions || [];
  for (const h of hosts) {
    assert.ok(
      h.startsWith('http://localhost') || h.startsWith('https://localhost') || h.startsWith('http://127.0.0.1') || h.startsWith('https://127.0.0.1'),
      'P2-003: host_permissions must be localhost-only in the dev manifest. Production rollouts add the production RPC host explicitly. Saw: ' + h,
    );
  }
});

test('manifest.json popup points at popup/popup.html', async () => {
  if (!manifest) manifest = JSON.parse(await readExtensionFile('manifest.json'));
  assert.ok(manifest.action && manifest.action.default_popup, 'action.default_popup must be set');
  assert.ok(
    manifest.action.default_popup.endsWith('popup.html'),
    'default_popup must end in popup.html — popup/popup.js depends on the canonical popup root.',
  );
});
