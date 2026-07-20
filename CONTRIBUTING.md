# Contributing

Thanks for your interest in contributing to cc-proxy.

## Local setup

```sh
git clone https://github.com/anlaki-py/cc-proxy.git
cd cc-proxy
npm install        # installs the two dev dependencies (eslint, prettier)
npm test           # runs `npm run build` first, then unit + integration tests
npm run lint       # runs ESLint (excludes the auto-generated lib/proxy.js)
npm run format     # checks Prettier formatting (excludes lib/proxy.js)
```

## Layout

`src/` holds the proxy source, split into one module per domain:

- `cli.js` — argv parsing and `--help`
- `request.js` — Anthropic→OpenAI message/tool/choice translation
- `stream.js` — `StreamBuilder` (frozen API) and SSE parsing
- `images.js` — image source resolution (base64 / url / file)
- `schema.js` — `cleanupSchemaForChatCompletions` (frozen API)
- `thinking.js` — per-model reasoning/thinking field mapping
- `models.js` — model context/max-token tables and token estimation
- `retry.js` — retry/backoff/deadline logic
- `errors.js` — Anthropic error envelope + JSON error responses
- `ids.js` — id generators and SSE wire formatter
- `server.js` — `http.createServer` factory
- `main.js` — entry point: parses argv + env, calls `startServer(config).listen()`

`scripts/build.js` concatenates the modules (in dep order) into the
shipped artifact `lib/proxy.js`. `lib/proxy.js` is git-tracked but
auto-generated — never edit it by hand.

## The important design constraint

The proxy implements a tight translation between two wire protocols.
Several of its specific behaviors exist because of direct experience with
how Claude Code's SDK parses responses — for example, the SSE
ping-keepalive cadence, the reasoning-content-before-text block ordering,
and the retry-before-first-byte-only rule. A change that looks like a
harmless cleanup to someone unfamiliar with that context can silently
break Claude Code compatibility for every user of the package.

If you are touching `src/` logic:

1. Add or update tests in `test/` for any behavioral change.
2. Explain _why_ a behavior change is correct (ideally with a reference
   to Claude Code's or the relevant upstream's documented behavior)
   rather than just _that_ it passes tests.
3. Be aware that the test suite intentionally has dense coverage of
   `cleanupSchemaForChatCompletions` and `StreamBuilder` — those are
   the two areas where silent regressions have the highest blast radius.
4. After editing, run `npm run build` (or just `npm test`) to regenerate
   `lib/proxy.js`. The build is idempotent — diffing two consecutive
   builds should produce no output.

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
