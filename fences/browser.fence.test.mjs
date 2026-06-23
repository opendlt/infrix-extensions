// Relocated browser-extension fences (from the infrix monorepo Go fences
// pkg/devnet/p2_003_extension_release_hardening, gap15_extension_disclosure_headers,
// and p3_20_extension_plan_approval). These are structural/text invariants —
// they read the extension source as text, exactly as the Go originals did, so
// no build is needed. The monorepo-only halves (verify-js wiring, rpc_handler.go
// method parity) stay in the monorepo; these are the extension-internal halves.
//   node --test "fences/*.test.mjs"

import test from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ext = path.join(repo, 'browser');
const read = (rel) => readFileSync(path.join(ext, rel), 'utf8');

// Strip // line comments and /* */ block comments so prose mentions of forbidden
// names don't trip token-shaped scans (mirrors the Go fence's stripJSComments).
function stripComments(src) {
  let out = '';
  for (let i = 0; i < src.length; ) {
    if (src[i] === '/' && src[i + 1] === '*') { const j = src.indexOf('*/', i + 2); if (j < 0) break; i = j + 2; continue; }
    if (src[i] === '/' && src[i + 1] === '/') { const j = src.indexOf('\n', i); if (j < 0) break; i = j; continue; }
    out += src[i++];
  }
  return out;
}
const isIdent = (c) => /[A-Za-z0-9_$]/.test(c || '');
// Mirrors the Go containsMethodDecl: name as an object-literal/concise method.
function hasMethodDecl(src, name) {
  for (const suffix of [`${name}: function(`, `${name}: function (`, `${name}:function(`, `${name} (`, `${name}(`]) {
    let idx = 0;
    while (true) {
      const j = src.indexOf(suffix, idx);
      if (j < 0) break;
      if (j > 0 && isIdent(src[j - 1])) { idx = j + suffix.length; continue; }
      if (suffix === `${name}(`) {
        let k = j - 1;
        while (k >= 0 && (src[k] === ' ' || src[k] === '\t')) k--;
        if (k < 0 || src[k] === ',' || src[k] === '{') return true;
        idx = j + suffix.length; continue;
      }
      return true;
    }
  }
  return false;
}

// --- P2-003: release-hardening harness structure ---------------------------

const REQUIRED_HARNESS = [
  'package.json', 'scripts/lint.mjs', 'tests/harness.mjs',
  'tests/content.test.mjs', 'tests/manifest.test.mjs',
  'tests/background.test.mjs', 'tests/integration.test.mjs',
];
test('P2-003: extension test-harness files exist and are non-empty', () => {
  for (const rel of REQUIRED_HARNESS) {
    const full = path.join(ext, rel);
    assert.ok(existsSync(full), `missing harness file: ${rel}`);
    assert.ok(statSync(full).size > 0, `harness file is empty: ${rel}`);
  }
});

test('P2-003: package.json is type:module and exposes the canonical npm scripts', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.type, 'module', 'package.json must declare "type":"module"');
  for (const s of ['lint', 'test', 'test:provider', 'test:background', 'test:integration', 'build']) {
    assert.ok(pkg.scripts && pkg.scripts[s], `package.json missing script: ${s}`);
  }
});

const FORBIDDEN_PROVIDER_METHODS = [
  'deploy', 'call', 'upgrade', 'query', 'invoke', 'sendTransaction', 'signTransaction',
  'signTypedData', 'eth_sendTransaction', 'eth_call', 'eth_signTransaction', 'eth_sign',
  'eth_signTypedData', 'wallet_addEthereumChain', 'wallet_switchEthereumChain',
  'wallet_requestPermissions', 'request', 'enable',
];
test('P2-003: content.js declares no forbidden window.infrix provider methods', () => {
  const stripped = stripComments(read('content.js'));
  const offenders = FORBIDDEN_PROVIDER_METHODS.filter((n) => hasMethodDecl(stripped, n));
  assert.deepEqual(offenders, [], `content.js exposes raw/EIP-1193 methods: ${offenders.join(', ')} — every state change must flow through submitIntent`);
});

test('P2-003: background.js routes wallet.submitIntent through augmentDisclosureContext', () => {
  const src = read('background.js');
  assert.ok(src.includes('function augmentDisclosureContext('), 'background.js must define augmentDisclosureContext()');
  const idx = src.indexOf("case 'wallet.submitIntent':");
  assert.ok(idx >= 0, "background.js missing wallet.submitIntent case arm");
  const tail = src.slice(idx + 1);
  const next = tail.indexOf("case 'wallet.");
  const body = next < 0 ? tail : tail.slice(0, next);
  assert.ok(body.includes('augmentDisclosureContext('), 'wallet.submitIntent handler must call augmentDisclosureContext(...) before forwarding');
});

// --- Gap-15: widget disclosure headers --------------------------------------

const WIDGETS = ['cinema-widget.js', 'debug-panel.js'];
const HEADER_LITERALS = [
  "'X-Actor'", "'X-Purpose'", "'X-Workflow-Instance'",
  'this.disclosure.actor', 'this.disclosure.purpose', 'this.disclosure.workflowInstance',
];
test('Gap-15: widgets inject the X-Actor/X-Purpose/X-Workflow-Instance trio', () => {
  for (const w of WIDGETS) {
    const src = read(w);
    for (const lit of HEADER_LITERALS) {
      assert.ok(src.includes(lit), `${w} must inject disclosure header literal ${lit}`);
    }
  }
});
test('Gap-15: widgets fail loud (constructor throws) on incomplete disclosure', () => {
  for (const w of WIDGETS) {
    const src = read(w);
    assert.ok(src.includes('throw new Error('), `${w} constructor must throw on incomplete disclosure`);
    for (const field of ['disclosure.actor', 'disclosure.purpose', 'disclosure.workflowInstance']) {
      assert.ok(src.includes(field), `${w} guard must reference ${field}`);
    }
  }
});
test('Gap-15: widgets inject headers unconditionally (no if-guard drop)', () => {
  const forbidden = /if\s*\(\s*this\.disclosure\.(?:actor|purpose|workflowInstance)\s*\)\s*headers\['X-/;
  for (const w of WIDGETS) {
    assert.ok(!forbidden.test(read(w)), `${w} has a conditional disclosure-header injection — must be unconditional (constructor throw guarantees the fields)`);
  }
});
test('Gap-15: popup.js builds a disclosure context for the widgets', () => {
  const src = read('popup/popup.js');
  for (const tok of [
    'wallet.getState', 'disclosureCinema', 'disclosureDebug',
    "purpose: 'wallet-preview'", "purpose: 'wallet-analyze'", 'workflowInstance',
    'new window.CinemaWidget', 'new window.DebugPanel',
  ]) {
    assert.ok(src.includes(tok), `popup.js must contain ${tok} so widgets receive a disclosure context`);
  }
});

// --- P3-20: plan-approval default affordance --------------------------------

test('P3-20: plan-approval.js exports the rich PlanApprovalView (no JSON-RPC anti-pattern)', () => {
  const src = read('popup/plan-approval.js');
  for (const frag of [
    'class PlanApprovalView', 'window.PlanApprovalView', 'intent.plan', 'intent.steps',
    'approval.get', 'plan-trust-pill', 'plan-step-kind', 'signAndApprove', 'runtimeSend',
  ]) {
    assert.ok(src.includes(frag), `plan-approval.js missing required fragment: ${frag}`);
  }
  assert.ok(!src.includes("this.rpc('wallet.approveRequest'"), 'plan-approval.js must send wallet.approveRequest via runtimeSend, not the JSON-RPC proxy');
});
test('P3-20: popup.html loads plan-approval.js and defines its styling', () => {
  const src = read('popup/popup.html');
  assert.ok(src.includes('<script src="plan-approval.js"></script>'), 'popup.html must load plan-approval.js');
  assert.ok(src.includes('.plan-card '), 'popup.html must define .plan-card CSS');
});
test('P3-20: popup.js dispatches plan-approval requests through PlanApprovalView', () => {
  const src = read('popup/popup.js');
  for (const frag of ['window.PlanApprovalView', 'isPlanApprovalRequest', 'sendRPCThroughBackground', 'wallet.rpc']) {
    assert.ok(src.includes(frag), `popup.js missing ${frag}`);
  }
});
test('P3-20: background wallet.approveIntent queues (no confused-deputy auto-submit) + wallet.rpc proxy', () => {
  const src = read('background.js');
  const idx = src.indexOf("case 'wallet.approveIntent':");
  assert.ok(idx >= 0, 'background.js missing wallet.approveIntent case arm');
  const region = src.slice(idx, Math.min(idx + 1500, src.length));
  const codeOnly = region.split('\n').map((l) => { const i = l.indexOf('//'); return i >= 0 ? l.slice(0, i) : l; })
    .filter((l) => !l.trim().startsWith('//')).join('\n');
  for (const bad of ['rpcProxy(', 'approval.submit', 'fetch(']) {
    assert.ok(!codeOnly.includes(bad), `wallet.approveIntent must not auto-submit (${bad}) — it must queue a pending request`);
  }
  assert.ok(codeOnly.includes('pendingRequests.set'), 'wallet.approveIntent must enqueue into pendingRequests');
  for (const frag of ["case 'wallet.rpc'", 'augmentDisclosureContext', 'rpcProxy(message.method', 'Plan hash mismatch', 'approval.submit']) {
    assert.ok(src.includes(frag), `background.js missing ${frag} (wallet.rpc proxy / plan-hash guard)`);
  }
});
