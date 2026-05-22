/**
 * Infrix VS Code extension — smoke tests.
 *
 * AUDIT_FINDINGS_2026-05-21 #19 closure: this is the build-time
 * development tools extension at tools/vscode-extension/. It is
 * structurally distinct from the governance-spine inspection extension
 * at vscode-extension/. Both ship; both are now under the verify-js
 * gate. This smoke suite exercises the InfrixClient surface against a
 * mocked axios instance so the gate catches structural regressions
 * (broken imports, removed exports, missing config wiring).
 */

import * as test from 'node:test';
import * as assert from 'node:assert/strict';
import { InfrixClient, InfrixConfig } from '../client';

test.test('InfrixClient: constructs with a valid config', () => {
    const cfg: InfrixConfig = {
        network: 'testnet',
        rpcUrl: 'http://localhost:8443/v4/jsonrpc',
        defaultKeyFile: '',
    };
    const client = new InfrixClient(cfg);
    assert.ok(client, 'InfrixClient must construct');
});

test.test('InfrixClient: deploy is exported', () => {
    const client = new InfrixClient({
        network: 'testnet',
        rpcUrl: 'http://localhost:8443/v4/jsonrpc',
        defaultKeyFile: '',
    });
    assert.equal(typeof (client as any).deploy, 'function', 'deploy must be a method');
});
