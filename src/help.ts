import { apiTokenEnvVar, defaultApiUrl, defaultMcpUrl, onboardingUrl } from './defaults.js'
import { hostIds } from './host-catalog.js'
import { readPackageVersion } from './package-info.js'

export const usage = `Kody CLI ${readPackageVersion()}

Install Kody as a remote MCP server in local agents, or use this CLI as a local client.

Usage:
  kody login [--mcp-url <url>] [--no-browser]
  kody logout [--mcp-url <url>] [--api-url <url>]
  kody status [--mcp-url <url>] [--api-url <url>]
  kody auth bootstrap --code <kody_bc_…> [--api-url <url>]
  kody whoami [--mcp-url <url>] [--token <token>] [--api-url <url>] [--json]
  kody search [query] [--entity <ref>] [--domain <id>] [--limit <n>] [--token <token>] [--api-url <url>] [--json]
  kody api <operationId> [--params <json>] [--token <token>] [--api-url <url>] [--json]
  kody execute [--invoke <ref> | --code <esm> | --file <path>] [--params <json>] [--conversation-id <id>] [--json]
               [--token <token>] [--api-url <url>] [--local] [--allow-private-network]
  kody install [--mcp-url <url>] [--clients <ids>] [--yes] [--project] [--json]
  kody skill install [--project]

  kody install configures running local MCP clients (Cursor, Claude Desktop,
  VS Code, Goose, and others). For web-based clients (ChatGPT, Claude.ai, Grok),
  see ${onboardingUrl(defaultMcpUrl)}

  --clients  Comma-separated ids: ${hostIds.join(', ')}

  auth bootstrap
             Redeem a one-shot \`kody_bc_…\` from MCP \`cliCredentialBootstrap\`
             (POST /v1/tokens/bootstrap/redeem, no Authorization header).
             Stores the resulting \`kody_at_…\` for \`execute --local\`,
             search, whoami, api, and token-auth cloud execute without
             printing the token. Prefer this over tokenCreate for agents
             already on MCP. Interactive humans can use \`kody login\`
             instead. Do not call \`kody api cliCredentialBootstrapRedeem\`
             — that would print the token.

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
             Mint with the MCP \`api\` tool \`tokenCreate\` (include
             \`local-execute\` plus the capability scopes you need), or use
             \`auth bootstrap\` after \`cliCredentialBootstrap\`.
             For \`execute --local\`, a valid \`kody login\` session can also
             supply Bearer when no scoped token is available (no tokenCreate
             exchange).

  --local    Run the execute module on this machine (workerd, Linux/macOS).
             Requires Node.js 22 or newer. Auth: \`--token\` /
             ${apiTokenEnvVar}, else stored \`auth bootstrap\` token, else
             paired \`kody login\` credentials. Static kody:@… imports are fetched via POST
             /v1/local-execute/package-graph and embedded in local workerd
             (CapabilityProxy only for per-call kody:runtime hops — never a
             whole-module cloud kody.execute defer). Fails clearly when that
             package-graph API is unavailable. Cloud token execute (no
             --local) uses CapabilityProxy → kody.execute for every module.

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
