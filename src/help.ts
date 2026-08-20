import { defaultMcpUrl } from './defaults.js'
import { readPackageVersion } from './package-info.js'

export const usage = `Kody CLI ${readPackageVersion()}

A local MCP client for https://kody.codes — login once, then search and execute.

Usage:
  kody login [--mcp-url <url>] [--no-browser]
  kody logout [--mcp-url <url>]
  kody status [--mcp-url <url>]
  kody whoami [--mcp-url <url>] [--json]
  kody search [query] [--entity <ref>] [--domain <id>] [--limit <n>] [--json]
  kody execute [--code <esm>] [--file <path>] [--params <json>] [--conversation-id <id>] [--json]
  kody skill install [--project]

Environment:
  KODY_MCP_URL   Override the default MCP URL (${defaultMcpUrl})
`
