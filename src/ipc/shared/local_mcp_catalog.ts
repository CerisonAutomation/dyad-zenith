import type { McpCatalogEntry } from "@/ipc/types/mcp_catalog";

/**
 * Curated MCP catalog for capabilities Dyad does not already provide natively.
 *
 * Keep this list intentionally small: the agent already has first-class file, git,
 * search, build, test, database, web, and reasoning capabilities. MCP is an
 * extension boundary, not a second agent/tool framework.
 */
export const LOCAL_MCP_CATALOG: McpCatalogEntry[] = [
  {
    slug: "fetch",
    name: "Fetch",
    description:
      "Fetch a URL and convert it to readable content. Useful when the native web tools are unavailable or an MCP client explicitly needs HTTP retrieval.",
    category: "Web",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-fetch"],
  },
  {
    slug: "memory",
    name: "Knowledge Graph Memory",
    description:
      "Optional persistent knowledge-graph memory across sessions. No API key required.",
    category: "Memory",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-memory"],
  },
  {
    slug: "playwright",
    name: "Playwright Browser",
    description:
      "Browser automation for navigation, interaction, accessibility snapshots, screenshots, and end-to-end verification.",
    category: "Browser",
    featured: true,
    transport: "stdio",
    command: "npx",
    args: ["-y", "@playwright/mcp"],
  },
  {
    slug: "github",
    name: "GitHub",
    description:
      "Optional GitHub API access for issues, pull requests, repositories, and search.",
    category: "Developer Tools",
    inputs: [
      {
        kind: "env",
        name: "GITHUB_PERSONAL_ACCESS_TOKEN",
        label: "GitHub Personal Access Token",
      },
    ],
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
  },
  {
    slug: "context7",
    name: "Context7",
    description:
      "Current library documentation through a remote MCP endpoint. Works without embedding credentials in source; configure authentication separately if required.",
    category: "Docs",
    featured: true,
    transport: "http",
    url: "https://mcp.context7.com/mcp",
  },
];
