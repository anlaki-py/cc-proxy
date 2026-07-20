'use strict';

// Cross-shell / cross-Node test runner.
//
// Problem this solves: `npm test` previously used a shell glob
// (`test/unit/*.test.js`) that bash expands on Linux but PowerShell does
// NOT expand on Windows — so CI's Windows job received the literal string
// `*.test.js` and node could not find it. Node's `--test` directory-arg
// support landed only in v22.x and is flaky relative to v18/v20 in our
// matrix. Instead we expand the globs ourselves with node:fs and pass an
// explicit file list to `node --test`. Works on every shell and every
// Node version we support (>=18).

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

function listTests(dir) {
  const abs = path.join(root, dir);
  return fs
    .readdirSync(abs)
    .filter((f) => f.endsWith('.test.js'))
    .map((f) => path.join(dir, f));
}

// `args` is the rest of process.argv: one or more test directories
// (e.g. `test/unit`). Coverage flag is forwarded if present.
const argv = process.argv.slice(2);
const coverage = argv.includes('--coverage');
const dirs = argv.filter((a) => !a.startsWith('--'));

const files = dirs.flatMap(listTests);
if (files.length === 0) {
  process.stderr.write(`no test files found under: ${dirs.join(', ')}\n`);
  process.exit(1);
}

const nodeArgs = ['--test'];
if (coverage) nodeArgs.push('--experimental-test-coverage');
// Run unit tests one file at a time. The HTTP-server-based retry tests
// are flaky when many files spin up loopback servers concurrently on
// Windows; serializing is fast enough that it's a clear win. Integration
// tests already serialize themselves via spawned child processes.
const concurrency = 1;
nodeArgs.push(`--test-concurrency=${concurrency}`);

const result = spawnSync(process.execPath, [...nodeArgs, ...files], {
  stdio: 'inherit',
  cwd: root,
});
process.exit(result.status ?? 1);
