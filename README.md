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
| `kody logout` | Deletes stored CLI OAuth credentials and any stored bootstrap/API token. |
| `kody status` | Shows CLI login / stored API token state without printing secrets. |
| `kody auth bootstrap --code` | Redeems a one-shot `kody_bc_…` from MCP `cliCredentialBootstrap` and stores the resulting `kody_at_…` for `execute --local` (never prints the token). |
| `kody whoami` | Confirms the CLI MCP connection and lists tools. With a scoped API token (and no login), shows token identity via the Open API. |
| `kody search [query]` | Calls Kody `search` from the CLI (prefer the host MCP tool). Token-only auth uses Open API `GET /v1/search`. |
| `kody api <operationId>` | Thin Open API wrapper matching the MCP `api` tool: `operationId` + flat `--params` JSON. Auth: `--token` / `KODY_API_TOKEN` / stored `auth bootstrap` token. |
| `kody execute` | Calls Kody `execute` from the CLI (`--invoke`, `--code`, `--file`, or stdin via `--file -`). With a scoped API token and no login (or with `--token`), cloud execute goes through CapabilityProxy → `kody.execute` — no `kody login`. Add `--local` to run the module (and static `kody:@…` package modules) on this machine instead. |

`--json` prints structured MCP results.

## Token-authenticated execute (no `kody login`)

Agents already on Kody MCP should prefer `cliCredentialBootstrap` →
`kody auth bootstrap --code …` (ADR 0056) so a one-shot `kody_bc_…` seeds the
CLI store without pasting `kody_at_…` into chat. Interactive humans can use
`kody login`. Scoped API tokens (`kody_at_…`, from bootstrap redeem,
`tokenCreate`, or `POST /v1/tokens`) authenticate the Open API and
CapabilityProxy. They never replace MCP OAuth on `/mcp`. The CLI uses that
token path when you pass `--token` / `KODY_API_TOKEN` and are not logged in
(or when you pass `--token` explicitly):

```bash
# Preferred for agents on MCP (no tokenCreate, no second OAuth):
# 1. MCP api / kody.cliCredentialBootstrap → { bootstrap_code, cli_command }
npx @kodycodes/cli auth bootstrap --code 'kody_bc_…'
npx @kodycodes/cli execute --local --file ./task.js

export KODY_API_TOKEN=…   # scopes: local-execute (+ search:read for search)
# Cloud execute — module runs in Kody's sandbox via CapabilityProxy → kody.execute
npx @kodycodes/cli execute --code 'export default async () => ({ ok: true })'
# Same token, module runs on this machine
npx @kodycodes/cli execute --local --file ./task.js --params '{"to":"me@example.com"}'
npx @kodycodes/cli search "what can you do"
npx @kodycodes/cli whoami
npx @kodycodes/cli api usageGet --params '{}'
```

- Neither bootstrap store, `kody login`, nor a token → the error prefers
  `cliCredentialBootstrap` → `auth bootstrap`, then `kody login`, then
  `tokenCreate` for CI/headless (`--token` / `KODY_API_TOKEN`).
- For `execute --local` specifically: `--token` / `KODY_API_TOKEN` wins when
  set; else a stored bootstrap/API token from `auth bootstrap`; else the
  stored `kody login` OAuth access token as Bearer (no under-the-hood
  `tokenCreate`). The Open API must accept that OAuth bearer on
  CapabilityProxy / package-graph
  ([kentcdodds/kody#2812](https://github.com/kentcdodds/kody/issues/2812));
  until then use bootstrap or a scoped `kody_at_…` token.
- Wrong/expired token → 401 with a mint-fresh-token message (or the OAuth
  platform-gap message when the bearer is login OAuth).
- Wrong scopes → the error includes `insufficient_scope` and the required
  scope when Kody sends one.
- Account flag off → the error includes `feature_disabled` and the
  `local-execute` feature flag. Another token does not bypass that flag.
- Prefer the env var so the token stays out of shell history and `ps`.
- Never scavenge host MCP OAuth tokens from disk (ADR 0053).

## Local execute

`kody execute --local` runs the same execute module (default export called
with `--params`) on this machine instead of in Kody's cloud sandbox. Local CPU
is free; every `kody:runtime` call (`kody.*`, `kody.mcp.*`, `workflows.create`)
is proxied to Kody's CapabilityProxy and metered like a cloud hop. Static
`kody:@scope/package/export` imports are **resolved into the local workerd
bundle** via `POST /v1/local-execute/package-graph` (same Bearer as
CapabilityProxy — never hosted MCP `execute`, and never a whole-module
CapabilityProxy → `kody.execute` defer). There is no author-facing
`packages.invoke`.

```bash
# Prefer login when already signed in (no temporary API token to paste):
npx @kodycodes/cli login
npx @kodycodes/cli execute --local --file ./task.js --params '{"to":"me@example.com"}'

# Agents on MCP: bootstrap code → store (no tokenCreate, no second OAuth):
npx @kodycodes/cli auth bootstrap --code 'kody_bc_…'
npx @kodycodes/cli execute --local --file ./task.js --params '{"to":"me@example.com"}'

# Or a scoped API token (still wins over login / bootstrap store when set):
export KODY_API_TOKEN=…   # minted through the Kody `api` tool
npx @kodycodes/cli execute --local --file ./task.js --params '{"to":"me@example.com"}'
```

- **Auth:** `--token` / `KODY_API_TOKEN` when set; else stored `auth bootstrap`
  API token; else a valid `kody login` session (OAuth access token as Bearer —
  never printed, never exchanged via `tokenCreate`). Prefer the env var for
  API tokens so they stay out of shell history and `ps`. The bearer stays in
  the CLI process; the sandbox only talks to a loopback bridge. Host MCP OAuth
  from other clients is never read. Until
  [kentcdodds/kody#2812](https://github.com/kentcdodds/kody/issues/2812)
  ships, login-only Bearer is rejected by the Open API — use bootstrap or a
  `kody_at_…` token in that case.
- **Node.js:** 22 or newer (`package.json` `engines` is `>=22`). Older Node
  fails immediately with that requirement, before workerd is downloaded or
  started.
- **Runtime:** a pinned [workerd](https://github.com/cloudflare/workerd)
  release, downloaded once from GitHub, sha256-verified, and cached under
  `~/.cache/kody` (Linux, or `$XDG_CACHE_HOME/kody`) or
  `~/Library/Caches/kody` (macOS). Override with `KODY_CACHE_DIR`, or point
  `KODY_WORKERD_PATH` at your own binary. No Docker required. Linux and macOS
  (x64/arm64) only for now.
- **API:** `https://api.kody.codes` by default (`--api-url` or `KODY_API_URL`
  to override). The CLI calls `GET /v1/capability-proxy/session` before
  starting workerd and `POST /v1/capability-proxy/call` with
  `{ path, args, conversationId? }` for each runtime call. When the module
  imports `kody:@…`, it also calls `POST /v1/local-execute/package-graph` to
  download stamped package modules for local embedding
  ([platform issue](https://github.com/kentcdodds/kody/issues/2808)).
- **Errors:** an expired/revoked token or an account without the
  `local-execute` flag fails fast with a clear message before any code runs.
  The token is only sent over https (plain http is allowed for localhost).
  Missing package-graph API, unresolved imports, or missing artifacts fail
  clearly — there is **no silent fallback** to cloud `kody.execute`.
- **Lifetime:** no execution time limit locally; Ctrl-C (or SIGTERM) stops
  workerd and removes the temporary module.
- **Saved packages:** `import { … } from 'kody:@owner/name/export'` under
  `--local` keeps the user module + package graph in local workerd. Local
  package CPU is not billed as a full cloud execute of the user module;
  per-call CapabilityProxy hops (and whatever the package-graph prep call
  meters once shipped) may still meter. Prefer keeping `--local` in agent
  workflows — do not switch to hosted MCP `execute`. `--invoke` without
  `--local` is the thin passthrough for a single export (still cloud).
  `packageStorage()`, `packageSecrets`, `email`, and `events` stay unbound on
  the ad hoc entry like cloud execute unless the downloaded package modules
  carry stamps. Outbound `fetch` goes straight from this machine, including
  to local-network hosts.

## Token storage

CLI credentials are stored in the OS secret store:

- macOS: Keychain
- Windows: Credential Manager
- Linux: Secret Service / libsecret (not the in-memory kernel keyring)

If the keychain is unavailable (common on headless Linux), the CLI writes a
`0600` file under `$XDG_CONFIG_HOME/kody` (or `%APPDATA%\kody` on Windows,
`~/Library/Application Support/kody` on macOS). Tokens are never printed.

Access tokens refresh automatically on expiry or HTTP 401.

`execute --local` prefers `--token` / `KODY_API_TOKEN` when set; otherwise it
uses stored CLI credentials from `kody login`. Token-only cloud execute still
only reads `--token` / `KODY_API_TOKEN`.

## Releases

This repo uses [semantic-release](https://github.com/semantic-release/semantic-release)
the same way [match-sorter](https://github.com/kentcdodds/match-sorter) does:
conventional commits on `main` publish `@kodycodes/cli` with npm provenance
(`id-token: write`). Version in `package.json` stays `0.0.0-semantically-released`.

Trusted publishing for `@kodycodes/cli` is attached to this GitHub repository.

## License

MIT © Kent C. Dodds
