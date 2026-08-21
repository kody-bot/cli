---
name: kody
description: >
  Use the Kody CLI to log in, search Kody capabilities, and execute
  sandboxed modules against kody.codes. Use when the user mentions Kody,
  kody.codes, durable agent tasks, or wants to search/execute via `kody`.
---

# Kody CLI

Kody is a remote MCP personal assistant. This skill uses the `@kodycodes/cli`
package — a local MCP client — instead of configuring an MCP server by hand.

## Install

```bash
npm install -g @kodycodes/cli
# or
npx @kodycodes/cli --help
```

Then install this skill into the current host if it is not already present:

```bash
npx @kodycodes/cli skill install
```

## Login

```bash
kody login
```

The CLI opens a browser for Kody OAuth (PKCE + Client ID Metadata Documents).
If a browser cannot open, it prints the URL. Tokens (access + refresh) are
stored in the OS keychain on macOS, Windows, and Linux. Linux without Secret
Service falls back to a `0600` file under `$XDG_CONFIG_HOME/kody`.

Never ask the user to paste tokens into chat.

## Use Kody

```bash
kody search "what can you do"
kody search --domain email
kody execute --code "import { kody } from 'kody:runtime'\nexport default async function main() { return await kody.search({ query: 'what can you do' }) }"
```

`search` and `execute` are Kody's only MCP tools. Prefer `kody search` before
`kody execute`. Add `--json` when you need structured output.

```bash
kody status
kody whoami
kody logout
```

Override the MCP URL with `--mcp-url` or `KODY_MCP_URL` for preview or local
servers. Default: `https://kody.codes/mcp`.
