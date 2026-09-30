import { apiTokenEnvVar, defaultApiUrl, defaultMcpUrl, onboardingUrl } from './defaults.js'
import { hostIds } from './host-catalog.js'
import { readPackageVersion } from './package-info.js'

export const usage = `Kody CLI ${readPackageVersion()}

Install Kody as a remote MCP server in local agents, or use this CLI as a local client.

Usage:
  kody login [--mcp-url <url>] [--no-browser]
  kody logout [--mcp-url <url>]
  kody status [--mcp-url <url>]
  kody whoami [--mcp-url <url>] [--json]
  kody search [query] [--entity <ref>] [--domain <id>] [--limit <n>] [--json]
  kody execute [--invoke <ref> | --code <esm> | --file <path>] [--params <json>] [--conversation-id <id>] [--json]
               [--local [--token <token>] [--api-url <url>]]
  kody install [--mcp-url <url>] [--clients <ids>] [--yes] [--project] [--json]
  kody skill install [--project]

  kody install configures running local MCP clients (Cursor, Claude Desktop,
  VS Code, Goose, and others). For web-based clients (ChatGPT, Claude.ai, Grok),
  see ${onboardingUrl(defaultMcpUrl)}

  --clients  Comma-separated ids: ${hostIds.join(', ')}

  --local    Run the execute module on this machine (workerd, Linux/macOS).
             kody:runtime calls go to Kody with a scoped API token from
             --token or ${apiTokenEnvVar}; no kody login needed.

Environment:
  KODY_MCP_URL        Override the default MCP URL (${defaultMcpUrl})
  ${apiTokenEnvVar}      Scoped API token for execute --local
  KODY_API_URL        Override the Kody API URL for execute --local (${defaultApiUrl})
  KODY_CACHE_DIR      Where execute --local caches workerd (default: user cache dir)
  KODY_WORKERD_PATH   Use this workerd binary instead of the pinned download
`
