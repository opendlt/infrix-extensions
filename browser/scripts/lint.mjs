// Copyright 2024 The Infrix Authors
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.

// P2-003 lint harness for the browser-extension JS surface.
//
// This is a deliberately minimal lint pass — Node's built-in syntax
// checker (`node --check <file>`) catches parse errors and obvious
// typos without a heavyweight ESLint install / config / version-pin
// dance that the rest of the JS workspace does not currently use.
// The tests themselves (tests/*.test.mjs) are the authoritative
// behavioural guard; this lint is the "did the file even parse"
// guard. Any future move to ESLint should add a config under
// extension/.eslintrc.json and rewire this script.

import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.dirname(here);

const skipDirs = new Set(['node_modules', 'icons', 'scripts', 'tests']);

async function* walkJS(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.isDirectory()) {
      if (skipDirs.has(e.name)) continue;
      yield* walkJS(path.join(dir, e.name));
      continue;
    }
    if (!e.isFile()) continue;
    const name = e.name;
    if (!name.endsWith('.js') && !name.endsWith('.mjs')) continue;
    if (name.endsWith('.test.mjs')) continue;
    yield path.join(dir, name);
  }
}

const failures = [];
for await (const file of walkJS(extensionRoot)) {
  const rel = path.relative(extensionRoot, file).replaceAll('\\', '/');
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (r.status === 0) {
    process.stderr.write(`[lint] ok  ${rel}\n`);
    continue;
  }
  failures.push({ rel, stderr: r.stderr });
  process.stderr.write(`[lint] FAIL ${rel}\n${r.stderr}\n`);
}

if (failures.length > 0) {
  process.stderr.write(`[lint] ${failures.length} file(s) failed parse\n`);
  process.exit(1);
}
process.stderr.write('[lint] all extension JS files parse cleanly\n');
