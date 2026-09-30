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
| `kody execute` | Calls Kody `execute` from the CLI (`--invoke`, `--code`, `--file`, or stdin via `--file -`). Add `--local` to run the module on this machine. |

`--json` prints structured MCP results.

## Local execute

`kody execute --local` runs the same execute module (default export called
with `--params`) on this machine instead of in Kody's cloud sandbox. Local CPU
is free; every `kody:runtime` call (`kody.*`, `kody.mcp.*`, `workflows`,
`packages`) is proxied to Kody's CapabilityProxy and metered like a cloud hop.

```bash
export KODY_API_TOKEN=…   # scoped token minted through the Kody `api` tool
npx @kodycodes/cli execute --local --file ./task.js --params '{"to":"me@example.com"}'
```

- **Auth:** a scoped API token from `--token` or `KODY_API_TOKEN` (prefer the
  env var so the token stays out of shell history and `ps`). No `kody login`,
  and the CLI never reads MCP OAuth tokens from other hosts. The token stays in
  the CLI process; the sandbox only talks to a loopback bridge.
- **Runtime:** a pinned [workerd](https://github.com/cloudflare/workerd)
  release, downloaded once from GitHub, sha256-verified, and cached under
  `~/.cache/kody` (Linux, or `$XDG_CACHE_HOME/kody`) or
  `~/Library/Caches/kody` (macOS). Override with `KODY_CACHE_DIR`, or point
  `KODY_WORKERD_PATH` at your own binary. No Docker required. Linux and macOS
  (x64/arm64) only for now.
- **API:** `https://api.kody.codes` by default (`--api-url` or `KODY_API_URL`
  to override). The CLI calls `GET /v1/capability-proxy/session` before
  starting workerd and `POST /v1/capability-proxy/call` with
  `{ path, args, conversationId? }` for each runtime call.
- **Errors:** an expired/revoked token or an account without the
  `local-execute` flag fails fast with a clear message before any code runs.
  The token is only sent over https (plain http is allowed for localhost).
- **Lifetime:** no execution time limit locally; Ctrl-C (or SIGTERM) stops
  workerd and removes the temporary module.
- **Not yet:** static `kody:@scope/package/export` imports and `--invoke`
  (use cloud execute or `packages.invoke`). `packageStorage()`,
  `packageSecrets`, `email`, and `events` stay unbound like ad hoc cloud
  execute. Outbound `fetch` goes straight from this machine, including to
  local-network hosts.

## Token storage

CLI credentials are stored in the OS secret store:

- macOS: Keychain
- Windows: Credential Manager
- Linux: Secret Service / libsecret (not the in-memory kernel keyring)

If the keychain is unavailable (common on headless Linux), the CLI writes a
`0600` file under `$XDG_CONFIG_HOME/kody` (or `%APPDATA%\kody` on Windows,
`~/Library/Application Support/kody` on macOS). Tokens are never printed.

Access tokens refresh automatically on expiry or HTTP 401.

`execute --local` does not use stored CLI credentials; it only reads
`--token` / `KODY_API_TOKEN`.

## Releases

This repo uses [semantic-release](https://github.com/semantic-release/semantic-release)
the same way [match-sorter](https://github.com/kentcdodds/match-sorter) does:
conventional commits on `main` publish `@kodycodes/cli` with npm provenance
(`id-token: write`). Version in `package.json` stays `0.0.0-semantically-released`.

Trusted publishing for `@kodycodes/cli` is attached to this GitHub repository.

## License

MIT © Kent C. Dodds
