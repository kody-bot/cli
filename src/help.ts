import { apiTokenEnvVar, defaultApiUrl, defaultMcpUrl, onboardingUrl } from './defaults.js'
import { hostIds } from './host-catalog.js'
import { readPackageVersion } from './package-info.js'

export const usage = `Kody CLI ${readPackageVersion()}

Install Kody as a remote MCP server in local agents, or use this CLI as a local client.

Usage:
  kody login [--mcp-url <url>] [--no-browser]
  kody logout [--mcp-url <url>]
  kody status [--mcp-url <url>]
  kody whoami [--mcp-url <url>] [--token <token>] [--api-url <url>] [--json]
  kody search [query] [--entity <ref>] [--domain <id>] [--limit <n>] [--token <token>] [--api-url <url>] [--json]
  kody execute [--invoke <ref> | --code <esm> | --file <path>] [--params <json>] [--conversation-id <id>] [--json]
               [--token <token>] [--api-url <url>] [--local]
  kody install [--mcp-url <url>] [--clients <ids>] [--yes] [--project] [--json]
  kody skill install [--project]

  kody install configures running local MCP clients (Cursor, Claude Desktop,
  VS Code, Goose, and others). For web-based clients (ChatGPT, Claude.ai, Grok),
  see ${onboardingUrl(defaultMcpUrl)}

  --clients  Comma-separated ids: ${hostIds.join(', ')}

  --token / ${apiTokenEnvVar}
             Scoped API token (preferred via env). With no \`kody login\`
             session, search / whoami / execute use the Open API and
             CapabilityProxy — including cloud execute without --local.
             Mint with the MCP \`api\` tool \`tokenCreate\` (include
             \`local-execute\` plus the capability scopes you need).
             --local still runs the module on this machine (workerd).

  --local    Run the execute module on this machine (workerd, Linux/macOS).
             Requires Node.js 22 or newer and a token with the local-execute
             scope. Static kody:@… imports are fetched via
             POST /v1/local-execute/package-graph and embedded in local
             workerd (CapabilityProxy only for per-call kody:runtime hops —
             never a whole-module cloud kody.execute defer). Fails clearly
             when that package-graph API is unavailable. Cloud token execute
             (no --local) uses CapabilityProxy → kody.execute for every module.

Environment:
  KODY_MCP_URL        Override the default MCP URL (${defaultMcpUrl})
  ${apiTokenEnvVar}      Scoped API token for token-auth search / whoami / execute
  KODY_API_URL        Override the Kody API URL (${defaultApiUrl})
  KODY_CACHE_DIR      Where execute --local caches workerd (default: user cache dir)
  KODY_WORKERD_PATH   Use this workerd binary instead of the pinned download
`
