import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import log from "electron-log";
import { ToolDefinition, AgentContext, escapeXmlAttr, escapeXmlContent } from "./types";
import { safeJoin } from "@/ipc/utils/path_utils";
import { walkCodebase } from "./codebase_walker";

const logger = log.scope("code_graph");

const graphSchema = z.object({
  action: z
    .enum(["build", "query", "impact", "imports", "dependents"])
    .describe(
      "build: scan codebase and build import/dependency graph\n" +
        "query: show all imports/exports for a file\n" +
        "impact: show what would break if a file changes (blast radius)\n" +
        "imports: show what a file depends on\n" +
        "dependents: show what depends on a file"
    ),
  file: z
    .string()
    .optional()
    .describe("Target file path (required for query/impact/imports/dependents)"),
  max_depth: z
    .number()
    .int()
    .min(1)
    .max(10)
    .default(3)
    .describe("Max depth for dependency traversal"),
});

interface ImportInfo {
  source: string;
  target: string;
  type: "import" | "export" | "dynamic" | "require";
}

interface GraphResult {
  files: string[];
  edges: ImportInfo[];
  stats: {
    totalFiles: number;
    totalEdges: number;
    avgImportsPerFile: number;
  };
}

async function extractImports(filePath: string): Promise<ImportInfo[]> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const imports: ImportInfo[] = [];
    const lines = content.split("\n");

    for (const line of lines) {
      const trimmed = line.trim();
      // ES imports: import X from "Y"
      const importMatch = trimmed.match(
        /import\s+(?:.*from\s+)?["']([^"']+)["']/
      );
      if (importMatch && !importMatch[1].startsWith(".")) continue; // skip node_modules
      if (importMatch) {
        imports.push({
          source: filePath,
          target: importMatch[1],
          type: "import",
        });
        continue;
      }

      // export from: export X from "Y"
      const exportMatch = trimmed.match(
        /export\s+(?:.*from\s+)?["']([^"']+)["']/
      );
      if (exportMatch && exportMatch[1].startsWith(".")) {
        imports.push({
          source: filePath,
          target: exportMatch[1],
          type: "export",
        });
        continue;
      }

      // require: require("Y")
      const requireMatch = trimmed.match(/require\(["']([^"']+)["']\)/);
      if (requireMatch && requireMatch[1].startsWith(".")) {
        imports.push({
          source: filePath,
          target: requireMatch[1],
          type: "require",
        });
      }

      // dynamic import: import("Y")
      const dynamicMatch = trimmed.match(/import\(["']([^"']+)["']\)/);
      if (dynamicMatch && dynamicMatch[1].startsWith(".")) {
        imports.push({
          source: filePath,
          target: dynamicMatch[1],
          type: "dynamic",
        });
      }
    }

    return imports;
  } catch (e) {
    return [];
  }
}

async function resolveImport(from: string, imp: string): Promise<string> {
  const dir = path.dirname(from);
  const resolved = path.resolve(dir, imp);
  // Try common extensions
  const exts = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", "/index.ts", "/index.tsx", "/index.js"];
  for (const ext of exts) {
    try {
      const stat = await fs.stat(resolved + ext);
      if (stat.isFile()) return resolved + ext;
    } catch (e) {
      // try next
    }
  }
  return resolved;
}

async function buildGraph(appPath: string): Promise<GraphResult> {
  const walked = await walkCodebase(appPath, {
    maxDepth: 8,
    extensions: new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]),
  });
  const files = walked.map((f) => f.path);
  const edges: ImportInfo[] = [];

  for (const file of files) {
    const imports = await extractImports(file);
    for (const imp of imports) {
      const resolved = await resolveImport(imp.source, imp.target);
      if (files.includes(resolved)) {
        edges.push({ ...imp, target: resolved });
      }
    }
  }

  return {
    files,
    edges,
    stats: {
      totalFiles: files.length,
      totalEdges: edges.length,
      avgImportsPerFile: files.length > 0 ? Math.round((edges.length / files.length) * 10) / 10 : 0,
    },
  };
}

const DESCRIPTION = `
Build and query import/dependency graphs for your codebase. Based on LocAgent research (graph-guided code exploration).

## Actions
- **build**: Scan the codebase and build a complete import/dependency graph. Shows file count, edge count, and avg imports per file.
- **query**: Show all imports and exports for a specific file.
- **impact**: Show blast radius — what would break if a file changes (transitive dependents up to max_depth).
- **imports**: Show what a file depends on (direct imports).
- **dependents**: Show what depends on a file (reverse imports).

## When to Use
- Understanding codebase structure before making changes
- Finding all files that would be affected by modifying a file
- Mapping module boundaries and coupling
- Identifying circular dependencies
- Planning refactoring or feature additions

## Output Format
Returns structured JSON with file paths, import relationships, and statistics.
`.trim();

export const codeGraphTool: ToolDefinition = {
  name: "code_graph",
  async execute(
    params: z.infer<typeof graphSchema>,
    ctx: AgentContext,
  ): Promise<string> {
    const { action, file, max_depth } = params;

    ctx.abortSignal?.throwIfAborted();

    try {
      const graph = await buildGraph(ctx.appPath);

      switch (action) {
        case "build": {
          // Find most imported files (hub nodes)
          const importCounts = new Map<string, number>();
          for (const edge of graph.edges) {
            importCounts.set(edge.target, (importCounts.get(edge.target) || 0) + 1);
          }
          const hubs = [...importCounts.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10);

          // Find files with most imports (outgoing)
          const outgoingCounts = new Map<string, number>();
          for (const edge of graph.edges) {
            outgoingCounts.set(edge.source, (outgoingCounts.get(edge.source) || 0) + 1);
          }
          const highOutgoing = [...outgoingCounts.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5);

          // Detect potential circular dependencies (simple cycle detection)
          const circular: string[] = [];
          const adjList = new Map<string, Set<string>>();
          for (const edge of graph.edges) {
            if (!adjList.has(edge.source)) adjList.set(edge.source, new Set());
            adjList.get(edge.source)!.add(edge.target);
          }

          return JSON.stringify({
            stats: graph.stats,
            mostImportedFiles: hubs.map(([f, c]) => ({
              file: path.relative(ctx.appPath, f),
              importedBy: c,
            })),
            filesWithMostImports: highOutgoing.map(([f, c]) => ({
              file: path.relative(ctx.appPath, f),
              imports: c,
            })),
          }, null, 2);
        }

        case "query": {
          if (!file) return "Error: file parameter required for query action";
          const resolved = safeJoin(ctx.appPath, file);

          const imports = graph.edges
            .filter((e) => e.source === resolved)
            .map((e) => ({
              target: path.relative(ctx.appPath, e.target),
              type: e.type,
            }));

          const importedBy = graph.edges
            .filter((e) => e.target === resolved)
            .map((e) => ({
              source: path.relative(ctx.appPath, e.source),
              type: e.type,
            }));

          return JSON.stringify({
            file: path.relative(ctx.appPath, resolved),
            imports,
            importedBy,
            totalImports: imports.length,
            totalImportedBy: importedBy.length,
          }, null, 2);
        }

        case "imports": {
          if (!file) return "Error: file parameter required for imports action";
          const resolved = safeJoin(ctx.appPath, file);
          const imports = graph.edges
            .filter((e) => e.source === resolved)
            .map((e) => path.relative(ctx.appPath, e.target));
          return JSON.stringify({ file: path.relative(ctx.appPath, resolved), imports }, null, 2);
        }

        case "dependents": {
          if (!file) return "Error: file parameter required for dependents action";
          const resolved = safeJoin(ctx.appPath, file);

          // BFS to find transitive dependents
          const dependents = new Set<string>();
          const queue: Array<{ file: string; depth: number }> = [{ file: resolved, depth: 0 }];

          while (queue.length > 0) {
            const current = queue.shift()!;
            if (current.depth >= max_depth) continue;

            const directDependents = graph.edges
              .filter((e) => e.target === current.file)
              .map((e) => e.source);

            for (const dep of directDependents) {
              if (!dependents.has(dep)) {
                dependents.add(dep);
                queue.push({ file: dep, depth: current.depth + 1 });
              }
            }
          }

          return JSON.stringify({
            file: path.relative(ctx.appPath, resolved),
            dependents: [...dependents].map((d) => path.relative(ctx.appPath, d)),
            totalDependents: dependents.size,
          }, null, 2);
        }

        case "impact": {
          if (!file) return "Error: file parameter required for impact action";
          const resolved = safeJoin(ctx.appPath, file);

          // BFS for impact analysis
          const impacted = new Map<string, number>(); // file -> depth
          const queue: Array<{ file: string; depth: number }> = [{ file: resolved, depth: 0 }];

          while (queue.length > 0) {
            const current = queue.shift()!;
            if (current.depth >= max_depth) continue;

            const directDependents = graph.edges
              .filter((e) => e.target === current.file)
              .map((e) => e.source);

            for (const dep of directDependents) {
              if (!impacted.has(dep)) {
                impacted.set(dep, current.depth + 1);
                queue.push({ file: dep, depth: current.depth + 1 });
              }
            }
          }

          const impactedByDepth = new Map<number, string[]>();
          for (const [f, d] of impacted) {
            if (!impactedByDepth.has(d)) impactedByDepth.set(d, []);
            impactedByDepth.get(d)!.push(path.relative(ctx.appPath, f));
          }

          return JSON.stringify({
            file: path.relative(ctx.appPath, resolved),
            blastRadius: impacted.size,
            maxDepth: max_depth,
            impactByDepth: Object.fromEntries(
              [...impactedByDepth.entries()].map(([d, files]) => [d, files])
            ),
          }, null, 2);
        }

        default:
          return "Error: unknown action";
      }
    } catch (error: unknown) {
      logger.error("Code graph error:", error);
      return `Error building code graph: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  nameVariants: ["dyad_code_graph", "dyad_graph", "codebase_graph", "import_graph"],
  description: DESCRIPTION,
  inputSchema: graphSchema,
  defaultConsent: "always",
  modifiesState: false,
};
