# cc-proxy

A zero-dependency Node.js proxy that lets **Claude Code** talk to any
**OpenAI-compatible** `/v1/chat/completions` endpoint (Ollama, OpenAI,
OpenRouter, vLLM, and others).

[![npm version](https://img.shields.io/npm/v/cc-proxy.svg)](https://www.npmjs.com/package/cc-proxy)
[![Node](https://img.shields.io/badge/node-%3E%3D18-blue.svg)](https://nodejs.org)
[![CI](https://github.com/anlaki-py/cc-proxy/actions/workflows/ci.yml/badge.svg)](https://github.com/anlaki-py/cc-proxy/actions)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

```
Claude Code  --[Anthropic Messages API]-->  cc-proxy  --[OpenAI Chat Completions]-->  upstream
```

## Installation

### Quick start (no installation)

```sh
npx cc-proxy --base https://api.openai.com/v1 --key sk-xxx --port 8082
```

### Global install

```sh
npm install -g cc-proxy
cc-proxy --base https://api.openai.com/v1 --key sk-xxx --port 8082
```

### Manual (no npm)

If you'd rather not use npm, the proxy is still just one file:

```sh
curl -O https://raw.githubusercontent.com/anlaki-py/cc-proxy/main/lib/proxy.js
node proxy.js --base https://api.openai.com/v1 --key sk-xxx --port 8082
```

## Requirements

Node.js 18 or newer. The proxy relies on the global `fetch` API and
`AbortSignal.timeout`, both stable in Node since 18.0, so there is no
polyfill and no way to run this on an older Node release.

## How it works

1. Claude Code sends `POST /v1/messages?beta=true` (Anthropic SSE format).
2. cc-proxy strips the query string, parses the Anthropic request, and
   translates it to OpenAI Chat Completions format. Tool schemas get
   cleaned up, `max_tokens` gets capped per model, `thinking.budget_tokens`
   gets mapped to the upstream's reasoning field.
3. cc-proxy forwards to your upstream's `/v1/chat/completions`.
4. The response is re-emitted as Anthropic SSE events
   (`message_start`, `content_block_delta`, `message_delta`, `message_stop`)
   with tool-call deltas stitched together by OpenAI's `index` field.
5. Claude Code parses the stream like it came from Anthropic's real API.

## Use it with Claude Code

**`--bare` is only needed if you have stored OAuth credentials.** Without
it, Claude Code uses cached OAuth tokens from the OS keychain and ignores
your env vars, hitting `api.anthropic.com` directly. `--bare` forces
Claude Code to use `ANTHROPIC_AUTH_TOKEN` exclusively and skip
OAuth/keychain. If you've never logged into Claude Code on this machine
(or you've revoked its keychain entry), you can skip the flag.

### Linux / macOS

```sh
# Point Claude Code at the proxy
export ANTHROPIC_BASE_URL=http://localhost:8082
export ANTHROPIC_AUTH_TOKEN=any-value
export CLAUDE_CODE_ATTRIBUTION_HEADER=0

# Non-interactive (one-shot prompt)
claude -p --bare "say hi in 5 words"

# Interactive TUI
claude --bare
```

### Windows (PowerShell)

```powershell
# Point Claude Code at the proxy
$env:ANTHROPIC_BASE_URL = "http://localhost:8082"
$env:ANTHROPIC_AUTH_TOKEN = "any-value"
$env:CLAUDE_CODE_ATTRIBUTION_HEADER = "0"

# Non-interactive (one-shot prompt)
claude -p --bare "say hi in 5 words"

# Interactive TUI
claude --bare
```

The `ANTHROPIC_AUTH_TOKEN` value doesn't matter — it's not forwarded; the
proxy uses its own OpenAI key.

To make the env vars stick across shells, put the `export` (Linux/macOS) or
`$env:` (Windows) lines in your shell profile (`~/.bashrc`, `~/.zshrc`,
`$PROFILE`).

## Flags

| Flag                    | Env var           | Default                         |
| ----------------------- | ----------------- | ------------------------------- |
| `-b, --base`            | `OPENAI_BASE_URL` | `http://localhost:11434/v1`     |
| `-k, --key`             | `OPENAI_API_KEY`  | _empty_                         |
| `-p, --port`            | `PORT`            | `8082`                          |
| `-m, --model`           | `MODEL_OVERRIDE`  | _empty_                         |
| `--image-fetch`         | `IMAGE_FETCH=1`   | _off_ — fetch+base64 URL images |
| `--max-image-bytes <n>` | `MAX_IMAGE_BYTES` | `20971520` (20 MB)              |
|                         | `LOG=1`           | _off_ — log every request       |

## What it does

- Strips `?beta=true` from `/v1/messages` (Claude Code sends it)
- Translates Anthropic `messages[].content` blocks to OpenAI shapes
- Cleans up tool schemas (strips `format: "uri"`, schema-level `strict`,
  re-derives `required` to only truly-required params)
- Caps `max_tokens` per model family (gpt-4o=16k, o1=100k, etc.)
- Maps `thinking.budget_tokens` to current OpenAI Chat Completions `reasoning_effort`
  enum (`none|low|medium|high|xhigh`); sends `reasoning_effort: 'none'` when Claude
  Code disables thinking, sends `role: 'developer'` instead of `system` for
  reasoning models, and surfaces `output_tokens_details.reasoning_tokens` in the
  Anthropic `message_delta.usage` so the reasoning cost is visible.
- Stitches streaming tool-call deltas by OpenAI's `index` field
- Emits proper Anthropic SSE events: `message_start`, `content_block_*`,
  `message_delta`, `message_stop`
- Emits a `ping` SSE keepalive after `message_start` and every 15s during
  long-running reasoning calls so intermediate proxies don't RST idle streams
- Retries upstream `fetch` on `429`, `502`, `503`, `504`, `529`, and transient
  network errors (exponential backoff with jitter, honors `Retry-After`,
  30s total deadline). Retries only before the first byte is sent to the
  client — mid-stream retry is unsafe.
- Wraps upstream errors in the Anthropic error envelope
  (`{type: "error", error: {type, message}, request_id: "req_..."}`) so
  Claude Code's SDK can show proper toasts and the `request_id` ends up in
  debug logs
- Scales `input_tokens` / `output_tokens` to a virtual 200k context window
  (using a per-model `MODEL_CONTEXT_LIMITS` table) so Claude Code's
  auto-compaction triggers correctly when the upstream is gpt-4 (8k),
  gpt-5 (1M), DeepSeek (64k), etc. Anthropic-native upstreams are 1:1
  (no scaling).
- Image sources: `base64` is passed through, `url` is passed through
  (or fetched+base64'd server-side with `--image-fetch`), and `file`
  (Anthropic Files API) is rejected with a 400 instead of being silently
  dropped. Image blocks inside `tool_result.content` arrays are routed
  to a follow-up user message since OpenAI tool messages are text-only.
- `HEAD /` and `GET /health` for Claude Code's startup probes
- `GET /v1/models` passes through to upstream

## Updating

```sh
npm update -g cc-proxy     # or: npm install -g cc-proxy@latest
```

`npx cc-proxy` always fetches the latest published version, so it never
needs manual updating.

## Security

The proxy holds an upstream API key in process memory and forwards it as
a Bearer token on every request. It binds an HTTP server to a local port
with no built-in authentication. See [SECURITY.md](SECURITY.md) for
details on what is and isn't in scope for security reports.

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT — see [LICENSE](LICENSE).
