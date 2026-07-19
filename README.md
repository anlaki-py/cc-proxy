# cc-proxy

A Node.js proxy that lets **Claude Code** talk to any **OpenAI-compatible**
`/v1/chat/completions` endpoint (Ollama, OpenAI, OpenRouter, vLLM, etc.).
Zero dependencies. Node 18+.

```
Claude Code  --[Anthropic Messages API]-->  cc-proxy  --[OpenAI Chat Completions]-->  upstream
```

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

## Setup

You need Node 18+ and the Claude Code CLI (`claude`).

### Linux / macOS

```sh
# 1. Get the proxy script
curl -O https://raw.githubusercontent.com/you/cc-proxy/main/proxy.js
# (or just copy proxy.js from this repo)

# 2. Check your Node version
node --version    # needs to print v18.x or higher

# 3. Start the proxy
node proxy.js --base https://api.openai.com/v1 --key sk-xxx --port 8082
```

You should see:

```
Anthropic <-> OpenAI proxy listening on http://localhost:8082
  upstream: https://api.openai.com/v1
  auth:     bearer ***xxxx
```

Leave that terminal open. Open a new one and run Claude Code.

### Windows (PowerShell)

```powershell
# 1. Get the proxy script
# Download proxy.js from the repo and put it in a folder, e.g. C:\tools\cc-proxy\

# 2. Check your Node version
node --version    # needs to print v18.x or higher

# 3. Start the proxy
cd C:\tools\cc-proxy
node proxy.js --base https://api.openai.com/v1 --key sk-xxx --port 8082
```

You should see:

```
Anthropic <-> OpenAI proxy listening on http://localhost:8082
  upstream: https://api.openai.com/v1
  auth:     bearer ***xxxx
```

Leave that PowerShell window open. Open a new one for Claude Code.

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

| Flag          | Env var           | Default                          |
|---------------|-------------------|----------------------------------|
| `-b, --base`  | `OPENAI_BASE_URL` | `http://localhost:11434/v1`      |
| `-k, --key`   | `OPENAI_API_KEY`  | _empty_                          |
| `-p, --port`  | `PORT`            | `8082`                           |
| `-m, --model` | `MODEL_OVERRIDE`  | _empty_                          |
|               | `LOG=1`           | _off_ — log every request        |

## What it does

- Strips `?beta=true` from `/v1/messages` (Claude Code sends it)
- Translates Anthropic `messages[].content` blocks to OpenAI shapes
- Cleans up tool schemas (strips `format: "uri"`, schema-level `strict`,
  re-derives `required` to only truly-required params)
- Caps `max_tokens` per model family (gpt-4o=16k, o1=100k, etc.)
- Maps `thinking.budget_tokens` to `reasoning_effort` /
  `thinking_budget` for o-series, gpt-5, Grok, Gemini, Qwen, DeepSeek
- Stitches streaming tool-call deltas by OpenAI's `index` field
- Emits proper Anthropic SSE events: `message_start`, `content_block_*`,
  `message_delta`, `message_stop`
- `HEAD /` and `GET /health` for Claude Code's startup probes
- `GET /v1/models` passes through to upstream
