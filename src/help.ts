import { apiTokenEnvVar, defaultApiUrl, defaultMcpUrl, onboardingUrl } from './defaults.js'
import { hostIds } from './host-catalog.js'
import { readPackageVersion } from './package-info.js'

export const usage = `Kody CLI ${readPackageVersion()}

Install Kody as a remote MCP server in local agents, or use this CLI as a local client.

Usage:
  kody login [--mcp-url <url>] [--org <slug>] [--no-browser]
  kody logout [--mcp-url <url>] [--api-url <url>]
  kody status [--mcp-url <url>] [--api-url <url>]
  kody auth bootstrap (--code <kody_bc_…> | --scopes <list>) (--lifetime short|long | --idle-ttl-seconds <n> --max-lifetime-seconds <n>)
                      [--token <token>] [--mcp-url <url>] [--api-url <url>]
  kody auth setup-git [--lifetime long|short] [--scopes <list>] [--token <token>] [--mcp-url <url>] [--api-url <url>]
  kody git-credential <get|store|erase>
  kody whoami [--mcp-url <url>] [--token <token>] [--api-url <url>] [--json]
  kody search [query] [--entity <ref>] [--domain <id>] [--limit <n>] [--token <token>] [--api-url <url>] [--json]
  kody api <operationId> [--params <json>] [--token <token>] [--api-url <url>] [--json]
  kody execute [--invoke <ref> | --code <esm> | --file <path>] [--params <json>] [--conversation-id <id>] [--json]
               [--credential <key=name>]… [--token <token>] [--api-url <url>] [--local] [--allow-private-network]
  kody install [--mcp-url <url>] [--clients <ids>] [--yes] [--project] [--json]
  kody skill install [--project]

  kody install configures running local MCP clients (Cursor, Claude Desktop,
  VS Code, Goose, and others). For web-based clients (ChatGPT, Claude.ai, Grok),
  see ${onboardingUrl(defaultMcpUrl)}

  --org <slug>
             Bind this login to an organization.
             Example: \`kody login --org acme\`
             Omit \`--org\` and the server binds your only organization.

  --clients  Comma-separated ids: ${hostIds.join(', ')}

  auth bootstrap
             Redeem a one-shot \`kody_bc_…\` from MCP \`cliCredentialBootstrap\`
             (POST /v1/tokens/bootstrap/redeem, no Authorization header).
             Lifetime is required: \`--lifetime short|long\` (\`short\` = 1h
             idle / 24h max; \`long\` = 14d idle / 3mo max), or both
             \`--idle-ttl-seconds\` and \`--max-lifetime-seconds\`.
             Single-task agents should use \`--lifetime short\`.
             Stores the resulting \`kody_at_…\` for \`execute --local\`,
             search, whoami, api, and token-auth cloud execute without
             printing the token. Prefer this over tokenCreate for agents
             already on MCP. Interactive humans can use \`kody login\`
             instead. Do not call \`kody api cliCredentialBootstrapRedeem\`
             — that would print the token.

  --scopes <list>
             Opt in to scopes beyond the cliCredentialBootstrap defaults
             (comma- or space-separated, e.g.
             \`--scopes org:execute,org:read,package:read,package:write\`).
             The list replaces the defaults, so include every scope you
             need. Instead of \`--code\`, the CLI mints the code itself by
             passing \`scopes\` to cliCredentialBootstrap, then redeems and
             stores it. It mints with \`--token\` if given, else the
             \`kody login\` session (any scope your org role grants), else
             ${apiTokenEnvVar} / a stored token (only scopes that token
             already holds). A bootstrap code's scopes are fixed when it is
             minted, so \`--code\` with \`--scopes\` is an error. Defaults
             stay least-privilege; \`insufficient_scope\` errors print the
             exact \`--scopes\` command to run.

  auth setup-git
             Install a Git credential helper for HTTPS clones/fetches/pushes
             at \`https://kody.codes/@owner/name.git\` (see guide:auth_setup_git).
             Uses a \`kody login\` session (or \`--token\` / ${apiTokenEnvVar} /
             stored bootstrap token) to mint a user-owned \`kody_at_…\` with
             at least \`package:read\` and \`package:write\` (default
             \`--lifetime long\`; reuses a suitable stored token). That token
             authorizes every repo you can access across all orgs — login
             \`--org\` only scopes the MCP mint session, not git. Requires a
             server that advertises \`org_binding\`. Configures
             \`credential.https://<host>.helper\` + \`useHttpPath\`. Does not
             change \`kody login\` / existing auth flows.

  git-credential
             Git credential helper invoked by git after \`auth setup-git\`
             (\`get\` returns username=x / password=kody_at_… for the Kody
             host; \`store\`/\`erase\` are no-ops). Not meant for interactive use.

  api        Call one Open API operation by operationId + flat --params
             JSON (same shape as the MCP \`api\` tool). Uses scoped API
             auth only (\`--token\` / ${apiTokenEnvVar} / stored bootstrap).
             Prints JSON. Example: \`kody api usageGet --params '{}'\`.
             Unknown operationIds error clearly; see
             ${defaultApiUrl}/openapi.json. tokenCreate / tokenRotate
             responses include a one-time token value — prefer env storage
             over pasting into chat.

  --token / ${apiTokenEnvVar}
             Scoped API token (preferred via env). With no \`kody login\`
             session, search / whoami / api / execute use the Open API and
             CapabilityProxy — including cloud execute without --local.
             Auth priority matches \`execute --local\`: \`--token\` /
             ${apiTokenEnvVar}; stored bootstrap/API token from
             \`auth bootstrap\`; then \`kody login\` where applicable.
             Prefer \`cliCredentialBootstrap\` then \`auth bootstrap\`
             (\`--lifetime short|long\`). CI/headless: \`tokenCreate\` with
             \`org:execute\` plus the capability scopes you need.
             For \`execute --local\`, a valid \`kody login\` session can also
             supply Bearer when no scoped token is available (no tokenCreate
             exchange).

  --local    Run the execute module on this machine (workerd, Linux/macOS).
             Requires Node.js 22 or newer. \`--file\` entries are bundled
             (relative imports and npm packages; \`kody:*\` stays external)
             before workerd loads them — same shape as hosted execute /
             publish. Unresolvable imports fail with a clear bundle error.
             Auth: \`--token\` /
             ${apiTokenEnvVar}, else stored \`auth bootstrap\` token, else
             paired \`kody login\` credentials. Static kody:@… imports are fetched via POST
             /v1/local-execute/package-graph and embedded in local workerd
             (CapabilityProxy only for per-call kody:runtime hops — never a
             whole-module cloud kody.execute defer). Fails clearly when that
             package-graph API is unavailable. Cloud token execute (no
             --local) uses CapabilityProxy → kody.execute for every module.

  --credential <key=name>
             ADR 0068 call map: pick which credential each \`credential(key)\`
             / \`credentials(key)\` call gets. Repeatable.
             \`--credential github=work\`, \`--credential x=org:work\`
             (or \`personal:name\`), \`--credential github=\` for none on
             purpose. With \`--local\`, sent as CapabilityProxy top-level
             \`credentials\` (code never sets the map) after a
             \`credentialClientCheck\` preflight. With a \`kody login\` MCP
             session (no token), passed as MCP execute \`credentials\`.
             Token-auth cloud execute (CapabilityProxy → kody.execute)
             rejects the flag — use \`--local\` or MCP.

  --allow-private-network
             Allow execute --local code to fetch private and local network
             addresses. Default is public-only; this flag requires --local.

Environment:
  KODY_MCP_URL        Override the default MCP URL (${defaultMcpUrl})
  ${apiTokenEnvVar}      Scoped API token for token-auth search / whoami / api / execute
  KODY_API_URL        Override the Kody API URL (${defaultApiUrl})
  KODY_CACHE_DIR      Where execute --local caches workerd (default: user cache dir)
  KODY_WORKERD_PATH   Use this workerd binary instead of the pinned download
`
