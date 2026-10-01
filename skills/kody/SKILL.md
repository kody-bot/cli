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
stored in the OS keychain on macOS, Windows, and Linux (Secret Service).
Linux without Secret Service — including headless machines that only have an
in-memory kernel keyring — falls back to a `0600` file under
`$XDG_CONFIG_HOME/kody`.

Never ask the user to paste tokens into chat.

Override the MCP URL with `--mcp-url` or `KODY_MCP_URL` for preview or local
servers. Default: `https://kody.codes/mcp`.

To run execute with a scoped API token and **no** `kody login`, set
`KODY_API_TOKEN` (or `--token`). Cloud execute (no `--local`) goes through
CapabilityProxy → `kody.execute`. Add `--local` to run the module on this
machine instead (Node.js 22 or newer; older Node fails before workerd starts).
Modules with static `kody:@…` imports keep `--local`: the CLI fetches stamped
package modules via `POST /v1/local-execute/package-graph` and embeds them in
local workerd (CapabilityProxy only for per-call `kody:runtime` hops — not a
whole-module cloud defer). If that package-graph API is missing, `--local`
fails clearly rather than silently billing a remote execute.

For `execute --local` auth: `--token` / `KODY_API_TOKEN` wins when set;
otherwise a stored token from `kody auth bootstrap --code` (after MCP
`cliCredentialBootstrap`); otherwise a valid `kody login` session (OAuth
access token as Bearer — never print it, never mint via `tokenCreate` under
the hood). Prefer bootstrap over `tokenCreate` for agents already on MCP so
`kody_at_…` never appears in chat. Until the Open API accepts MCP OAuth on
CapabilityProxy / package-graph
(https://github.com/kentcdodds/kody/issues/2812), use bootstrap or mint a
scoped token with the MCP `api` tool `tokenCreate` — include `local-execute`
plus the capability scopes the module calls — and pass `--token` or
`KODY_API_TOKEN`. If none of those are available, the CLI error says that
(bootstrap → login → tokenCreate for CI). `insufficient_scope` means the
token is missing a scope; `feature_disabled` means the account
`local-execute` flag is off. Never read MCP OAuth tokens from the host.

```bash
# Agents on MCP:
# cliCredentialBootstrap → { bootstrap_code, cli_command }
npx @kodycodes/cli auth bootstrap --code 'kody_bc_…'
npx @kodycodes/cli execute --local --file ./task.js --params '{"q":"email"}'

npx @kodycodes/cli login
npx @kodycodes/cli execute --local --file ./task.js --params '{"q":"email"}'
# Or with an explicit scoped token (wins over login / bootstrap store):
KODY_API_TOKEN=… npx @kodycodes/cli execute --local --file ./task.js --params '{"q":"email"}'
```
