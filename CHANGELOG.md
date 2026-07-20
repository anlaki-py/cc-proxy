# Changelog

All notable changes to cc-proxy are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2026-07-20

### Added
- Initial npm-packaged release. The proxy logic itself is unchanged from
  the pre-npm `proxy.js` script; this release packages it as an
  installable, tested, linted npm package.
- `bin/cc-proxy.js` wrapper with Node 18+ version guard.
- Comprehensive test suite using Node's built-in `node:test` runner
  (unit + integration tests).
- CI workflow testing on Node 18, 20, 22, 24 across Linux and Windows.
- ESLint and Prettier configuration.
- Trusted-publishing release workflow with provenance attestation.
- `CONTRIBUTING.md` and `SECURITY.md`.
