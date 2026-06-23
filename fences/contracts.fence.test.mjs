// Relocated VS Code "Infrix Smart Contracts" fences (from the monorepo Go fences
// pkg/devnet/gap15_vscode_command_palette and gap15_vscode_rpc_url, invariants 1-2).
// Invariant 3 of the rpc-url fence (every this.rpc('METHOD') exists in the devnet
// dispatcher rpc_handler.go) is a CROSS-REPO contract that stays in the monorepo —
// it cannot be checked here without the published RPC contract.
//   node --test "fences/*.test.mjs"

import test from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ext = path.join(repo, 'vscode-contracts');
const read = (rel) => readFileSync(path.join(ext, rel), 'utf8');

const FORBIDDEN_BARE_VERBS = new Set([
  'infrix.deploy', 'infrix.call', 'infrix.upgrade', 'infrix.query',
  'infrix.build', 'infrix.init', 'infrix.generateABI', 'infrix.viewEvents',
]);
const TITLE_BARE_VERB = /^Infrix:\s+(Deploy|Call|Upgrade)\s+Contract\s*$/i;
const REGISTER_CMD = /vscode\.commands\.registerCommand\(\s*['"]([^'"]+)['"]/g;

function tsSources() {
  const dir = path.join(ext, 'src');
  return readdirSync(dir).filter((f) => f.endsWith('.ts')).map((f) => ({ name: f, src: readFileSync(path.join(dir, f), 'utf8') }));
}

test('command palette: no bare contract-first command IDs or titles', () => {
  const manifest = JSON.parse(read('package.json'));
  const cmds = manifest.contributes?.commands || [];
  assert.ok(cmds.length > 0, 'no contributes.commands found — parser drift');
  const offenders = [];
  for (const c of cmds) {
    if (FORBIDDEN_BARE_VERBS.has(c.command)) offenders.push(`${c.command} (bare verb — namespace under infrix.intent.X / infrix.contract.X)`);
    if (TITLE_BARE_VERB.test(c.title || '')) offenders.push(`${c.command} title "${c.title}" (use "Submit CONTRACT_X Intent" / "Query Contract (read-only)")`);
  }
  assert.deepEqual(offenders, [], `command palette governance-first regression: ${offenders.join('; ')}`);
});

test('command palette: every registerCommand id is non-bare and declared in package.json', () => {
  const manifest = JSON.parse(read('package.json'));
  const paletteIds = new Set((manifest.contributes?.commands || []).map((c) => c.command));
  const mismatches = [];
  for (const { name, src } of tsSources()) {
    for (const m of src.matchAll(REGISTER_CMD)) {
      const id = m[1];
      if (!id.startsWith('infrix.')) continue;
      if (FORBIDDEN_BARE_VERBS.has(id)) { mismatches.push(`${name}: registerCommand('${id}') — bare contract-first ID forbidden`); continue; }
      if (!paletteIds.has(id)) mismatches.push(`${name}: registerCommand('${id}') — not declared in package.json contributes.commands`);
    }
  }
  assert.deepEqual(mismatches, [], `registerCommand vs package.json lockstep failure: ${mismatches.join('; ')}`);
});

const RPC_FILES = ['src/client.ts', 'src/extension.ts'];
const FORBIDDEN_SUBSTRINGS = [':26660/v3', '/v3/', 'accumulatenetwork.io'];

test('rpc-url: no L0 substrings on executable (non-comment) lines', () => {
  for (const rel of RPC_FILES) {
    const lines = read(rel).split('\n');
    lines.forEach((line, i) => {
      if (line.trimStart().startsWith('//')) return; // comments may document why these are forbidden
      for (const sub of FORBIDDEN_SUBSTRINGS) {
        assert.ok(!line.includes(sub), `${rel}:${i + 1} forbidden L0 substring ${sub} — the dev tool addresses the Infrix dispatcher (/rpc)`);
      }
    });
  }
});

test('rpc-url: every network-case return URL ends in /rpc', () => {
  const RET = /return\s+['"]([^'"]+)['"]\s*;/;
  for (const rel of RPC_FILES) {
    const lines = read(rel).split('\n');
    let inSwitch = false, lastCase = '';
    lines.forEach((line, i) => {
      const t = line.trim();
      if (t.startsWith('switch (') || t.startsWith('switch(')) { inSwitch = true; return; }
      if (!inSwitch) return;
      if (t.startsWith('}') && !t.includes('case')) { inSwitch = false; return; }
      if (t.startsWith('case ') || t.startsWith("case'") || t.startsWith('case"') || t.startsWith('default:')) { lastCase = t; return; }
      if (!t.startsWith('return')) return;
      const m = line.match(RET);
      if (!m || lastCase === '') return;
      assert.ok(m[1].endsWith('/rpc'), `${rel}:${i + 1} network case (${lastCase}) returns "${m[1]}" — must end in /rpc`);
    });
  }
});
