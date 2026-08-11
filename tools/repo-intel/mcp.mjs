import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { gitEvidence, importGraph, resolveRepo, scanRisks, searchRepo, sourceDigest, summarizeRepo, verifyRepo } from "./core.mjs";
const pathSchema = z.string().max(1000).default(".");
const text = (value) => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });
export async function createRepoIntelServer() {
    const server = new McpServer({ name: "dyad-repo-intel", version: "1.0.0" });
    server.tool("repo_summary", "Summarize repository structure, package scripts, revision and source digest.", { path: pathSchema }, async ({ path }) => text({ ...summarizeRepo(resolveRepo(path)), git: gitEvidence(resolveRepo(path)), sourceDigest: sourceDigest(resolveRepo(path)) }));
    server.tool("repo_search", "Regex search bounded repository text files.", { path: pathSchema, query: z.string().min(1).max(500), max: z.number().int().min(1).max(500).default(100) }, async ({ path, query, max }) => text(searchRepo(resolveRepo(path), query, max)));
    server.tool("repo_graph", "Summarize relative TypeScript/JavaScript import relationships.", { path: pathSchema }, async ({ path }) => text(importGraph(resolveRepo(path))));
    server.tool("repo_risk_scan", "Run deterministic credential/Electron/shell/eval risk checks. Test fixtures are excluded.", { path: pathSchema }, async ({ path }) => text(scanRisks(resolveRepo(path))));
    server.tool("repo_git", "Return current revision and dirty-file evidence.", { path: pathSchema }, async ({ path }) => text(gitEvidence(resolveRepo(path))));
    server.tool("repo_verify", "Inspect or execute mandatory release gates. Execution requires REPO_INTEL_ALLOW_EXEC=1.", { path: pathSchema }, async ({ path }) => text(verifyRepo(resolveRepo(path), /^(1|true|yes|on)$/i.test(process.env.REPO_INTEL_ALLOW_EXEC || ""))));
    const transport = new StdioServerTransport();
    await server.connect(transport);
}
