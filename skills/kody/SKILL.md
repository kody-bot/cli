---
name: kody
description: >
  Install Kody as a remote MCP server, then use `search` and `execute`
  from the host agent. Use when the user mentions Kody, kody.codes,
  durable agent tasks, or wants to search/execute via Kody.
---

# Kody

Kody is a remote MCP personal assistant. **Long term, install it as an MCP
server in this agent** and call `search` / `execute` directly. Do not keep
using the CLI as the everyday interface once the server is connected.

`@kodycodes/cli` is a bootstrapper: it writes host MCP config and can act as
a local client when MCP is not available.

## Install the MCP server (recommended)

```bash
npx @kodycodes/cli install
```

That command lists **running local** agents and writes each host's remote
MCP entry for `https://kody.codes/mcp`. Host OAuth stays in that client —
do not run `kody login` for the host connection.

After install, prefer the Kody MCP tools in this agent:

- `search` — discover capabilities, packages, and entity detail
- `execute` — run one-off modules against those capabilities

Prefer `search` before `execute`. If Kody is already connected here, skip
the CLI and use those tools.

For web-based clients (ChatGPT, Claude.ai, Grok), point the user at
https://kody.codes/onboarding.

To copy this skill into Claude Code / Cursor / Agents:

```bash
npx @kodycodes/cli skill install
```

## CLI fallback

Use the CLI only for bootstrap, scripting, or when this agent cannot reach
Kody over MCP.

```bash
npm install -g @kodycodes/cli
kody login
kody search "what can you do"
kody search --domain email
kody execute --code "import { kody } from 'kody:runtime'\nexport default async function main() { return await kody.search({ query: 'what can you do' }) }"
kody status
kody whoami
kody logout
```

The CLI opens a browser for Kody OAuth (PKCE + Client ID Metadata Documents).
If a browser cannot open, it prints the URL. Tokens (access + refresh) are
stored in the OS keychain on macOS, Windows, and Linux. Linux without Secret
Service falls back to a `0600` file under `$XDG_CONFIG_HOME/kody`.

Never ask the user to paste tokens into chat.

Override the MCP URL with `--mcp-url` or `KODY_MCP_URL` for preview or local
servers. Default: `https://kody.codes/mcp`.
