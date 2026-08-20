# @kodycodes/cli

Turn one-off agent work into something you can rerun: a local MCP client for
[Kody](https://kody.codes) with login, OS keychain token storage, `search`, and
`execute`.

```bash
npx @kodycodes/cli login
npx @kodycodes/cli search "what can you do"
npx @kodycodes/cli skill install
```

Copyright © 2026 [Kent C. Dodds](https://kentcdodds.com). MIT licensed.

## Install

```bash
npm install -g @kodycodes/cli
kody login
```

Or run via `npx @kodycodes/cli` without a global install.

## Commands

| Command | Purpose |
| --- | --- |
| `kody login` | Browser OAuth (DCR + PKCE). Stores access and refresh tokens. |
| `kody logout` | Deletes stored credentials. |
| `kody status` | Shows login state without printing secrets. |
| `kody whoami` | Confirms the MCP connection and lists tools. |
| `kody search [query]` | Calls Kody `search`. |
| `kody execute` | Calls Kody `execute` (`--code`, `--file`, or stdin via `--file -`). |
| `kody skill install` | Copies the getting-started skill into Claude Code / Cursor / Agents. |

`--mcp-url` or `KODY_MCP_URL` overrides the default `https://kody.codes/mcp`.
`--json` prints structured MCP results.

## Token storage

Credentials are stored in the OS secret store:

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
Until that is connected, the release job may fail at npm publish — the workflow
is still the source of truth.

## License

MIT © Kent C. Dodds
