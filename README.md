# @kodycodes/cli

Install [Kody](https://kody.codes) as a remote MCP server in local agents.
Talks MCP `2026-07-28` (Kody's stateless `/mcp` lane) and logs in with Client
ID Metadata Documents (SEP-991).

**Long term, use Kody through the host MCP connection** — `search` and
`execute` in Cursor, Claude Code, or another client. This CLI writes that
config. Keep `kody login` / `kody search` / `kody execute` for bootstrap,
scripts, or hosts that cannot run MCP.

```bash
npx @kodycodes/cli install
npx @kodycodes/cli skill install
```

Copyright © 2026 [Kent C. Dodds](https://kentcdodds.com). MIT licensed.

## Install the MCP server

```bash
npx @kodycodes/cli install
```

`kody install` lists **running local** agents (Cursor, Claude Desktop, VS Code,
Goose, Claude Code, Codex, Windsurf, Zed, and similar) and writes each host's
remote MCP entry for `https://kody.codes/mcp`. Common host formats go through
[`add-mcp`](https://www.npmjs.com/package/add-mcp). It does not list web clients.
For ChatGPT, Claude.ai, and Grok, use [kody.codes/onboarding](https://kody.codes/onboarding).

After install, the CLI prints a prompt you can paste into the configured agent
to continue onboarding. Host OAuth stays in that client — `kody login` is only
for the CLI itself.

```bash
npx @kodycodes/cli skill install
```

copies the getting-started skill into Claude Code / Cursor / Agents. That skill
also tells the agent to prefer the MCP server over the CLI.

`--mcp-url` or `KODY_MCP_URL` overrides the default `https://kody.codes/mcp`.

## CLI as a local client

Optional. Use when you need a scripted or headless client instead of a host
MCP connection.

```bash
npm install -g @kodycodes/cli
kody login
```

Or run via `npx @kodycodes/cli` without a global install.

## Commands

| Command | Purpose |
| --- | --- |
| `kody install` | Detect running local MCP clients, write their config, and start host OAuth. **Recommended long-term path.** |
| `kody skill install` | Copies the getting-started skill into Claude Code / Cursor / Agents. |
| `kody login` | Browser OAuth (CIMD + PKCE) for the CLI itself. Stores access and refresh tokens. |
| `kody logout` | Deletes stored CLI credentials. |
| `kody status` | Shows CLI login state without printing secrets. |
| `kody whoami` | Confirms the CLI MCP connection and lists tools. |
| `kody search [query]` | Calls Kody `search` from the CLI (prefer the host MCP tool). |
| `kody execute` | Calls Kody `execute` from the CLI (`--code`, `--file`, or stdin via `--file -`). |

`--json` prints structured MCP results.

## Token storage

CLI credentials are stored in the OS secret store:

- macOS: Keychain
- Windows: Credential Manager
- Linux: Secret Service / libsecret

If the keychain is unavailable (common on headless Linux), the CLI writes a
`0600` file under `$XDG_CONFIG_HOME/kody` (or `%APPDATA%\kody` on Windows,
`~/Library/Application Support/kody` on macOS). Tokens are never printed.

Access tokens refresh automatically on expiry or HTTP 401.

## Releases

This repo uses [semantic-release](https://github.com/semantic-release/semantic-release)
the same way [match-sorter](https://github.com/kentcdodds/match-sorter) does:
conventional commits on `main` publish `@kodycodes/cli` with npm provenance
(`id-token: write`). Version in `package.json` stays `0.0.0-semantically-released`.

Trusted publishing for `@kodycodes/cli` is attached to this GitHub repository.

## License

MIT © Kent C. Dodds
