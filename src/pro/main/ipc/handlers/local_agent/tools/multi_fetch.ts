/**
 * multi_fetch.ts — Unified batch execution tool.
 *
 * Executes multiple fetch/file/read operations in a SINGLE tool call.
 * Eliminates the common pattern of 5+ sequential fetch calls.
 *
 * Operations:
 *   web_fetch     — HTTP GET with HTML-to-text extraction
 *   read_file     — Read local files with line range  
 *   code_search   — Search project for symbols/patterns
 *   file_tree     — List directory structure
 *   code_graph    — Build dependency graph for a file/dir
 */

import { z } from "zod";
import log from "electron-log";
import { ToolDefinition, AgentContext, escapeXmlAttr } from "./types";
import type { AgentToolConsent } from "@/lib/schemas";
import { readSettings } from "@/main/settings";
import { safeJoin } from "@/ipc/utils/path_utils";
import fs from "node:fs/promises";
import path from "node:path";

const logger = log.scope("multi_fetch");

// ─── Schema ───────────────────────────────────────────────────────

const webFetchOp = z.object({
  type: z.literal("web_fetch"),
  url: z.string().url(),
  extract: z.enum(["text", "html", "title", "links"]).default("text"),
});

const readFileOp = z.object({
  type: z.literal("read_file"),
  path: z.string(),
  start_line: z.number().int().min(1).optional(),
  end_line: z.number().int().min(1).optional(),
});

const codeSearchOp = z.object({
  type: z.literal("code_search"),
  query: z.string().min(1),
  max_results: z.number().int().min(1).max(20).default(5),
});

const fileTreeOp = z.object({
  type: z.literal("file_tree"),
  dir: z.string().default("."),
  max_depth: z.number().int().min(1).max(5).default(3),
});

const codeGraphOp = z.object({
  type: z.literal("code_graph"),
  file: z.string().optional(),
  max_depth: z.number().int().min(1).max(10).default(3),
});

const multiFetchSchema = z.object({
  operations: z.array(
    z.discriminatedUnion("type", [
      webFetchOp, readFileOp, codeSearchOp, fileTreeOp, codeGraphOp,
    ])
  ).min(1).max(10).describe("Operations to execute in parallel"),
  max_concurrent: z.number().int().min(1).max(10).default(5),
});

// ─── Tool Definition ──────────────────────────────────────────────

export const multiFetchTool: ToolDefinition = {
  name: "multi_fetch",
  description:
    "Execute multiple fetch/file/read/search operations in a single parallel call. " +
    "Saves 5+ round-trips when you need to read several files, search the codebase, " +
    "or fetch multiple URLs. Supports: web_fetch, read_file, code_search, file_tree, code_graph.",
  inputSchema: multiFetchSchema,
  defaultConsent: "auto-approve" as AgentToolConsent,

  async execute(args: any, ctx: AgentContext) {
    const ops = args.operations;
    const concurrency = args.max_concurrent || 5;
    const appPath = ctx.appPath;

    const results: Array<{ op: number; type: string; ok: boolean; data?: unknown; error?: string; ms: number }> = [];

    // Execute in batches of max_concurrent
    for (let i = 0; i < ops.length; i += concurrency) {
      const batch = ops.slice(i, i + concurrency);
      const batchResults = await Promise.all(
        batch.map(async (op: any, batchIdx: number) => {
          const globalIdx = i + batchIdx;
          const start = Date.now();
          try {
            const data = await executeOp(op, appPath);
            return { op: globalIdx, type: op.type, ok: true, data, ms: Date.now() - start };
          } catch (err: any) {
            return { op: globalIdx, type: op.type, ok: false, error: err.message, ms: Date.now() - start };
          }
        })
      );
      results.push(...batchResults);
    }

    const ok = results.filter(r => r.ok).length;
    const failed = results.filter(r => !r.ok).length;
    const totalMs = results.reduce((sum, r) => sum + r.ms, 0);

    return `<multi_fetch ok="${ok}" failed="${failed}" total_ms="${totalMs}" concurrent="${concurrency}">
${results.map(r => formatResult(r)).join("\n")}
</multi_fetch>`;
  },
};

// ─── Operation Executors ──────────────────────────────────────────

async function executeOp(op: any, appPath: string): Promise<unknown> {
  switch (op.type) {
    case "web_fetch": return webFetch(op.url, op.extract);
    case "read_file": return readFile(op.path, appPath, op.start_line, op.end_line);
    case "code_search": return codeSearch(op.query, appPath, op.max_results);
    case "file_tree": return fileTree(op.dir, appPath, op.max_depth);
    case "code_graph": return codeGraph(op.file, appPath, op.max_depth);
    default: throw new Error(`Unknown operation: ${op.type}`);
  }
}

// ─── Web Fetch ────────────────────────────────────────────────────

async function webFetch(url: string, extract: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "Dyad/1.0 (multi_fetch)" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

    const html = await res.text();

    if (extract === "html") {
      return { url, size: html.length, content: html.slice(0, 50000) };
    }

    // Extract text from HTML (zero-dep: jsdom is not installed)
    if (extract === "title") {
      const title =
        /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1] ||
        /<h1[^>]*>([^<]*)<\/h1>/i.exec(html)?.[1] ||
        "";
      return { url, title: decodeEntities(title).trim() };
    }

    if (extract === "links") {
      const links: Array<{ text: string; href: string }> = [];
      const re = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
      let m: RegExpExecArray | null;
      while ((m = re.exec(html)) !== null && links.length < 50) {
        const href = m[1];
        const text = stripTags(m[2]).trim().slice(0, 100);
        if (href && !href.startsWith("#") && !href.startsWith("javascript:")) {
          links.push({ text, href });
        }
      }
      return { url, links, count: links.length };
    }

    // text mode: strip scripts/styles/tags and collapse whitespace
    const noTags = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
      .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
      .replace(/<header[\s\S]*?<\/header>/gi, " ");
    const text = decodeEntities(stripTags(noTags)).replace(/\s+/g, " ").trim().slice(0, 10000);
    return { url, text, length: text.length };
  } finally {
    clearTimeout(timeout);
  }
}

function stripTags(input: string): string {
  return input.replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " ");
}

function decodeEntities(input: string): string {
  return input
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, " ");
}

// ─── Read File ────────────────────────────────────────────────────

async function readFile(filePath: string, appPath: string, startLine?: number, endLine?: number) {
  const fullPath = safeJoin(appPath, filePath);
  const content = await fs.readFile(fullPath, "utf-8");
  const lines = content.split("\n");

  const start = Math.max(1, startLine || 1);
  const end = Math.min(lines.length, endLine || start + 200);

  const selected = lines.slice(start - 1, end);
  return {
    path: filePath,
    total_lines: lines.length,
    range: `${start}-${end}`,
    content: selected.join("\n"),
  };
}

// ─── Code Search ──────────────────────────────────────────────────

const SEARCHABLE_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts",
  ".vue", ".svelte", ".css", ".scss", ".html", ".md", ".json", ".sql",
  ".prisma", ".py", ".rb", ".go", ".rs", ".java", ".kt", ".swift",
]);

function tokenize(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^\p{L}\p{N}_./-]+/u)
    .map(t => t.trim())
    .filter(t => t.length > 1);
}

function countOccurrences(text: string, needle: string): number {
  if (!needle) return 0;
  let count = 0, idx = 0;
  while ((idx = text.indexOf(needle, idx)) !== -1 && count < 50) { count++; idx++; }
  return count;
}

async function codeSearch(query: string, appPath: string, maxResults: number) {
  const terms = [...new Set(tokenize(query))];
  const lowerQuery = query.toLowerCase();
  const candidates: Array<{ path: string; score: number; snippet: string }> = [];

  // Search only src/ to keep it fast
  const srcDir = path.join(appPath, "src");
  await scanDir(srcDir, appPath, terms, lowerQuery, candidates, 0, 4);

  candidates.sort((a, b) => b.score - a.score);
  const top = candidates.slice(0, maxResults);

  return { query, results: top, total: candidates.length };
}

async function scanDir(
  dir: string, appPath: string, terms: string[], lowerQuery: string,
  candidates: any[], depth: number, maxDepth: number
) {
  if (depth > maxDepth) return;
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await scanDir(full, appPath, terms, lowerQuery, candidates, depth + 1, maxDepth);
    } else if (SEARCHABLE_EXT.has(path.extname(entry.name))) {
      try {
        const content = await fs.readFile(full, "utf-8");
        const lower = content.toLowerCase();
        let score = countOccurrences(lower, lowerQuery) * 10;
        for (const term of terms) score += countOccurrences(lower, term);
        if (entry.name.toLowerCase().includes(lowerQuery)) score += 20;
        if (score > 0) {
          const idx = lower.indexOf(lowerQuery);
          const snippet = content.slice(Math.max(0, idx - 60), idx + lowerQuery.length + 60).replace(/\n/g, " ").trim();
          candidates.push({ path: path.relative(appPath, full), score, snippet });
        }
      } catch { /* skip */ }
    }
  }
}

// ─── File Tree ────────────────────────────────────────────────────

async function fileTree(dir: string, appPath: string, maxDepth: number) {
  const full = safeJoin(appPath, dir);
  const tree: any[] = [];

  async function walk(currentPath: string, depth: number) {
    if (depth > maxDepth) return;
    const entries = await fs.readdir(currentPath, { withFileTypes: true }).catch(() => []);
    const children: any[] = [];
    for (const entry of entries.slice(0, 100)) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      if (entry.isDirectory()) {
        const sub: any = { name: entry.name, type: "directory", children: [] };
        await walk(path.join(currentPath, entry.name), depth + 1).then(c => { sub.children = c; });
        if (sub.children.length > 0) children.push(sub);
      } else {
        children.push({ name: entry.name, type: "file", size: (await fs.stat(path.join(currentPath, entry.name))).size });
      }
    }
    return children;
  }

  const children = await walk(full, 0);
  return { dir, files: countTreeFiles(children), dirs: countTreeDirs(children), tree: children };
}

function countTreeFiles(tree: any[] | undefined): number {
  if (!tree) return 0;
  return tree.reduce((n, item) => n + (item.type === "file" ? 1 : countTreeFiles(item.children)), 0);
}

function countTreeDirs(tree: any[] | undefined): number {
  if (!tree) return 0;
  return tree.reduce((n, item) => n + (item.type === "directory" ? 1 + countTreeDirs(item.children) : 0), 0);
}

// ─── Code Graph ───────────────────────────────────────────────────

async function codeGraph(filePath: string | undefined, appPath: string, maxDepth: number) {
  const target = filePath ? safeJoin(appPath, filePath) : path.join(appPath, "src");
  const edges: Array<{ source: string; target: string; type: string }> = [];
  
  async function walkDir(dir: string, depth: number) {
    if (depth > maxDepth) return;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walkDir(full, depth + 1);
      } else if (SEARCHABLE_EXT.has(path.extname(entry.name))) {
        try {
          const content = await fs.readFile(full, "utf-8");
          for (const line of content.split("\n")) {
            const t = line.trim();
            const imp = t.match(/import\s+(?:type\s+)?(?:.*from\s+)?["']([^"']+)["']/);
            if (imp) {
              edges.push({
                source: path.relative(appPath, full),
                target: imp[1],
                type: imp[1].startsWith(".") ? "local" : "package",
              });
            }
          }
        } catch { /* skip */ }
      }
    }
  }

  const stat = await fs.stat(target).catch(() => null);
  if (stat?.isFile()) {
    try {
      const content = await fs.readFile(target, "utf-8");
      for (const line of content.split("\n")) {
        const t = line.trim();
        const imp = t.match(/import\s+(?:type\s+)?(?:.*from\s+)?["']([^"']+)["']/);
        if (imp) {
          edges.push({
            source: path.relative(appPath, target),
            target: imp[1],
            type: imp[1].startsWith(".") ? "local" : "package",
          });
        }
      }
    } catch { /* skip */ }
  } else if (stat?.isDirectory()) {
    await walkDir(target, 0);
  }

  return { 
    target: path.relative(appPath, target),
    edges: edges.slice(0, 1000), 
    total: edges.length,
    truncated: edges.length > 1000,
  };
}

// ─── XML Output Formatter ─────────────────────────────────────────

function formatResult(r: { op: number; type: string; ok: boolean; data?: unknown; error?: string; ms: number }): string {
  if (!r.ok) {
    return `  <${r.type} op="${r.op}" ok="false" ms="${r.ms}" error="${escapeXmlAttr(r.error || "unknown")}" />`;
  }

  const data = r.data as Record<string, unknown>;
  switch (r.type) {
    case "web_fetch":
      if (data.text) {
        return `  <web_fetch op="${r.op}" ok="true" ms="${r.ms}" url="${escapeXmlAttr(String(data.url))}">\n${data.text}\n  </web_fetch>`;
      }
      if (data.title) {
        return `  <web_fetch op="${r.op}" ok="true" ms="${r.ms}" url="${escapeXmlAttr(String(data.url))}" title="${escapeXmlAttr(String(data.title))}" />`;
      }
      return `  <web_fetch op="${r.op}" ok="true" ms="${r.ms}" url="${escapeXmlAttr(String(data.url))}" size="${data.size || 0}" />`;
    case "read_file":
      return `  <read_file op="${r.op}" ok="true" ms="${r.ms}" path="${escapeXmlAttr(String(data.path))}" lines="${data.range}">\n${(data.content as string)?.slice(0, 20000)}\n  </read_file>`;
    case "code_search":
      return `  <code_search op="${r.op}" ok="true" ms="${r.ms}" query="${escapeXmlAttr(String(data.query))}">\n${(data.results as any[])?.map((r: any) => `    <result score="${r.score}" path="${escapeXmlAttr(r.path)}" snippet="${escapeXmlAttr(r.snippet?.slice(0, 200) || "")}" />`).join("\n")}\n  </code_search>`;
    case "file_tree":
      const files = (data as any).files || 0;
      const dirs = (data as any).dirs || 0;
      return `  <file_tree op="${r.op}" ok="true" ms="${r.ms}" dir="${escapeXmlAttr(String(data.dir))}" files="${files}" dirs="${dirs}" />`;
    case "code_graph":
      return `  <code_graph op="${r.op}" ok="true" ms="${r.ms}" total_edges="${data.total || 0}" target="${escapeXmlAttr(String(data.target || ""))}" truncated="${data.truncated ? "yes" : "no"}" />`;
    default:
      return `  <${r.type} op="${r.op}" ok="true" ms="${r.ms}" />`;
  }
}
