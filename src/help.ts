import { defaultMcpUrl, onboardingUrl } from './defaults.js'
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
  kody execute [--code <esm>] [--file <path>] [--params <json>] [--conversation-id <id>] [--json]
  kody install [--mcp-url <url>] [--clients <ids>] [--yes] [--project] [--json]
  kody skill install [--project]

  kody install configures running local MCP clients (Cursor, Claude Desktop,
  VS Code, Goose, and others). For web-based clients (ChatGPT, Claude.ai, Grok),
  see ${onboardingUrl(defaultMcpUrl)}

  --clients  Comma-separated ids: ${hostIds.join(', ')}

Environment:
  KODY_MCP_URL   Override the default MCP URL (${defaultMcpUrl})
`
