# Security Policy

## Reporting a vulnerability

Please report security vulnerabilities privately via
[GitHub's private vulnerability reporting](https://github.com/anlaki-py/cc-proxy/security/advisories/new)
for this repository. Do not open a public GitHub issue for a suspected
security problem.

You should receive an initial response within a few days. If you do not,
please follow up on the advisory thread.

## Supported versions

Only the latest published version of cc-proxy receives security fixes.

## In-scope concerns

The proxy's security-relevant surface is, in summary:

- **API key in process memory.** The `--key` / `OPENAI_API_KEY` value is
  held in process memory for the lifetime of the running process and is
  sent as a Bearer token on every upstream request.
- **HTTP server with no built-in authentication.** cc-proxy binds a
  plain HTTP server to a local port. It is intended to be run locally
  or in a trusted network context, not exposed directly to the public
  internet. If you need to expose it, put it behind a reverse proxy that
  enforces authentication.
- **`--image-fetch` and SSRF.** When the `--image-fetch` flag is on, the
  proxy makes outbound HTTP requests to URLs that ultimately originate
  from model output or user input. This is a classic SSRF-adjacent
  pattern; if you are running cc-proxy in a less-trusted environment,
  leave `--image-fetch` off, or place the proxy behind a network that
  restricts outbound traffic.

## Out of scope

- Bugs in upstream OpenAI-compatible APIs.
- Issues in the Claude Code CLI itself.
- The fact that this tool exists to forward API keys to third-party
  services. The tool's purpose is visible in the README.

## Disclosure policy

Once a fix is available, a CVE will be requested (if applicable) and an
advisory will be published with full credit to the reporter.
