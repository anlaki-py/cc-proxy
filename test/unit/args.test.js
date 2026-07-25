'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { parseArgs, version } = require('../../src/cli.js');

// parseArgs is pure — no server, no env, no side effects. We exercise it
// directly without the old test/loader vm sandbox.
test('parseArgs: long-form flags', () => {
  const r = parseArgs([
    '--base',
    'http://x.com/v1',
    '--key',
    'sk-123',
    '--port',
    '9001',
    '--model',
    'gpt-4o',
    '--image-fetch',
    '--max-image-bytes',
    '1000',
  ]);
  assert.equal(r.base, 'http://x.com/v1');
  assert.equal(r.key, 'sk-123');
  assert.equal(r.port, '9001');
  assert.equal(r.model, 'gpt-4o');
  assert.equal(r.imageFetch, true);
  assert.equal(r.maxImageBytes, '1000');
});

test('parseArgs: short-form flags', () => {
  const r = parseArgs(['-b', 'http://x', '-k', 'k', '-p', '80', '-m', 'gpt']);
  assert.equal(r.base, 'http://x');
  assert.equal(r.key, 'k');
  assert.equal(r.port, '80');
  assert.equal(r.model, 'gpt');
});

test('parseArgs: empty argv returns empty object with no keys', () => {
  assert.equal(Object.keys(parseArgs([])).length, 0);
});

test('parseArgs: unknown flag is ignored', () => {
  const r = parseArgs(['--unknown', 'value', '-b', 'x']);
  assert.equal(r.base, 'x');
  assert.equal(r.unknown, undefined);
});

test('parseArgs: --image-fetch sets boolean true', () => {
  assert.equal(parseArgs(['--image-fetch']).imageFetch, true);
});

// -v / --version: exits process with code 0 and prints the version string.
// We can't call parseArgs(['--version']) directly (it exits), so we spawn a
// child process and capture stdout.
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const CLI = path.join(__dirname, '..', '..', 'bin', 'cc-proxy.js');

test('-v prints version string and exits 0', () => {
  const r = spawnSync(process.execPath, [CLI, '-v'], { encoding: 'utf8' });
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}\nstderr: ${r.stderr}`);
  assert.match(r.stdout, /^cc-proxy\/\d+\.\d+\.\d+ node\/\d+\.\d+\.\d+/);
});

test('--version prints version string and exits 0', () => {
  const r = spawnSync(process.execPath, [CLI, '--version'], { encoding: 'utf8' });
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}\nstderr: ${r.stderr}`);
  assert.match(r.stdout, /^cc-proxy\/\d+\.\d+\.\d+ node\/\d+\.\d+\.\d+/);
});

test('version export matches package.json', () => {
  const pkg = require('../../package.json');
  assert.equal(version, pkg.version);
});

test('-v output contains correct package version', () => {
  const pkg = require('../../package.json');
  const r = spawnSync(process.execPath, [CLI, '-v'], { encoding: 'utf8' });
  assert.ok(r.stdout.includes(`cc-proxy/${pkg.version}`), `stdout: ${r.stdout}`);
});
