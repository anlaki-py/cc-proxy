# Contributing

Thanks for your interest in contributing to cc-proxy.

## Local setup

```sh
git clone https://github.com/anlaki-py/cc-proxy.git
cd cc-proxy
npm install        # installs the two dev dependencies (eslint, prettier)
npm test           # runs unit + integration tests
npm run lint       # runs ESLint
npm run format     # checks Prettier formatting
```

## The important design constraint

`lib/proxy.js` implements a tight translation between two wire protocols.
Several of its specific behaviors exist because of direct experience with
how Claude Code's SDK parses responses — for example, the SSE
ping-keepalive cadence, the reasoning-content-before-text block ordering,
and the retry-before-first-byte-only rule. A change that looks like a
harmless cleanup to someone unfamiliar with that context can silently
break Claude Code compatibility for every user of the package.

If you are touching `lib/proxy.js` logic:

1. Add or update tests in `test/` for any behavioral change.
2. Explain *why* a behavior change is correct (ideally with a reference
   to Claude Code's or the relevant upstream's documented behavior)
   rather than just *that* it passes tests.
3. Be aware that the test suite intentionally has dense coverage of
   `cleanupSchemaForChatCompletions` and `StreamBuilder` — those are
   the two areas where silent regressions have the highest blast radius.

## Pull request expectations

- `npm run lint` and `npm test` must pass in CI.
- Include a new test with any behavioral change.
- Add a `CHANGELOG.md` entry under `[Unreleased]` for anything user-facing.
- Keep PRs small and focused. One logical change per PR.

## Issue triage

When opening an issue about "proxy doesn't work with upstream X," please
include:

- The exact upstream (provider, model, version) and its API URL.
- The full request body and response (with `LOG=1` set).
- The exact `cc-proxy` command line you're using.

This package speaks to a wide variety of OpenAI-compatible upstreams, and
inconsistencies in upstream implementations are by far the most common
source of issues.
