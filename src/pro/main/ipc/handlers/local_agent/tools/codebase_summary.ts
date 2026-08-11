import { z } from "zod";
import log from "electron-log";
import {
  ToolDefinition,
  AgentContext,
  escapeXmlAttr,
  escapeXmlContent,
} from "./types";
import {
  resolveTargetAppPath,
  filterDyadInternalFiles,
} from "./resolve_app_context";
import { extractCodebase } from "@/utils/codebase";

const logger = log.scope("codebase_summary");

const codebaseSummarySchema = z.object({
  app_name: z
    .string()
    .optional()
    .describe(
      "Optional. Name of a referenced app (from @app:Name mentions) to summarize instead of the current app.",
    ),
  focus: z
    .string()
    .optional()
    .describe(
      "Optional. Focus area for the summary (e.g. 'authentication', 'API routes', 'data flow'). If omitted, provides a general overview.",
    ),
  depth: z
    .enum(["shallow", "normal", "deep"])
    .optional()
    .describe(
      "Summary depth: 'shallow' (file tree + key files), 'normal' (structure + patterns), 'deep' (structure + patterns + dependencies + architecture). Default: normal.",
    ),
});

const DESCRIPTION = `
Generate a comprehensive summary of the codebase structure, patterns, and architecture. Like gitingest — it reads the project and produces a structured overview.

## When to Use
- Onboarding to an unfamiliar project
- Understanding the architecture before making changes
- Finding the right files for a task
- Documenting the project structure
- Before large refactors to understand impact

## When NOT to Use
- You already know the codebase well
- You need specific file content → use read_file
- You need to find specific code → use grep or code_search

## Depth Levels
- **shallow**: File tree, package.json, main entry points
- **normal**: Structure, key patterns, component organization, tech stack
- **deep**: All of above + dependency graph, data flow, API surface, testing patterns
`;

interface FileSummary {
  path: string;
  size: number;
  lines: number;
  imports: string[];
  exports: string[];
}

function analyzeFile(content: string, path: string): FileSummary {
  const lines = content.split("\n");
  const imports: string[] = [];
  const exports: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (
      trimmed.startsWith("import ") ||
      trimmed.startsWith("import{") ||
      trimmed.startsWith("from ")
    ) {
      const importMatch = trimmed.match(/from\s+["']([^"']+)["']/);
      if (importMatch) {
        imports.push(importMatch[1]);
      }
    }
    if (
      trimmed.startsWith("export ") ||
      trimmed.startsWith("export{") ||
      trimmed.startsWith("export default")
    ) {
      exports.push(trimmed.slice(0, 100));
    }
  }

  return {
    path,
    size: content.length,
    lines: lines.length,
    imports: [...new Set(imports)].slice(0, 20),
    exports: exports.slice(0, 10),
  };
}

function buildFileTree(
  files: Array<{ path: string; content: string }>,
  maxDepth: number,
): string {
  const tree: Record<string, any> = {};

  for (const file of files) {
    const parts = file.path.split("/");
    let current = tree;
    for (let i = 0; i < Math.min(parts.length, maxDepth); i++) {
      const part = parts[i];
      if (i === parts.length - 1) {
        current[part] = null; // file
      } else {
        if (!current[part]) current[part] = {};
        current = current[part];
      }
    }
  }

  function renderTree(
    node: Record<string, any>,
    prefix: string,
    _isLast: boolean,
  ): string {
    const lines: string[] = [];
    const entries = Object.entries(node).sort(([a], [b]) => {
      // Directories first, then files
      const aIsDir = node[a] !== null;
      const bIsDir = node[b] !== null;
      if (aIsDir && !bIsDir) return -1;
      if (!aIsDir && bIsDir) return 1;
      return a.localeCompare(b);
    });

    for (let i = 0; i < entries.length; i++) {
      const [name, value] = entries[i];
      const last = i === entries.length - 1;
      const connector = last ? "└── " : "├── ";
      const childPrefix = last ? "    " : "│   ";

      if (value !== null) {
        lines.push(`${prefix}${connector}📁 ${name}/`);
        lines.push(renderTree(value, prefix + childPrefix, last));
      } else {
        lines.push(`${prefix}${connector}${name}`);
      }
    }

    return lines.join("\n");
  }

  return renderTree(tree, "", true);
}

function summarizeTechStack(
  files: Array<{ path: string; content: string }>,
): Record<string, string[]> {
  const stack: Record<string, string[]> = {
    frameworks: [],
    languages: [],
    libraries: [],
    tools: [],
  };

  // Check for common config files
  const configFiles = files.filter(
    (f) =>
      f.path.endsWith("package.json") ||
      f.path.endsWith("tsconfig.json") ||
      f.path.endsWith("next.config.js") ||
      f.path.endsWith("vite.config.ts") ||
      f.path.endsWith("tailwind.config.js") ||
      f.path.endsWith(".eslintrc.js"),
  );

  for (const file of configFiles) {
    if (file.path.endsWith("package.json")) {
      try {
        const pkg = JSON.parse(file.content);
        const allDeps = {
          ...pkg.dependencies,
          ...pkg.devDependencies,
        };
        const depNames = Object.keys(allDeps);

        // Frameworks
        if (depNames.some((d) => d.includes("next")))
          stack.frameworks.push("Next.js");
        if (depNames.some((d) => d.includes("react")))
          stack.frameworks.push("React");
        if (depNames.some((d) => d.includes("vue")))
          stack.frameworks.push("Vue");
        if (depNames.some((d) => d.includes("svelte")))
          stack.frameworks.push("Svelte");
        if (depNames.some((d) => d.includes("angular")))
          stack.frameworks.push("Angular");

        // Libraries
        if (depNames.some((d) => d.includes("tailwind")))
          stack.libraries.push("Tailwind CSS");
        if (depNames.some((d) => d.includes("prisma")))
          stack.libraries.push("Prisma");
        if (depNames.some((d) => d.includes("supabase")))
          stack.libraries.push("Supabase");
        if (depNames.some((d) => d.includes("zod")))
          stack.libraries.push("Zod");
        if (depNames.some((d) => d.includes("trpc")))
          stack.libraries.push("tRPC");
        if (depNames.some((d) => d.includes("drizzle")))
          stack.libraries.push("Drizzle");

        // Tools
        if (depNames.some((d) => d.includes("typescript")))
          stack.tools.push("TypeScript");
        if (depNames.some((d) => d.includes("eslint")))
          stack.tools.push("ESLint");
        if (depNames.some((d) => d.includes("prettier")))
          stack.tools.push("Prettier");
        if (depNames.some((d) => d.includes("vitest") || d.includes("jest")))
          stack.tools.push("Testing");
      } catch {
        // Skip malformed package.json
      }
    }

    if (file.path.endsWith("tsconfig.json")) {
      stack.languages.push("TypeScript");
    }
  }

  // Detect languages from file extensions
  const extCount: Record<string, number> = {};
  for (const file of files) {
    const ext = file.path.split(".").pop() || "";
    extCount[ext] = (extCount[ext] || 0) + 1;
  }

  const langMap: Record<string, string> = {
    ts: "TypeScript",
    tsx: "TypeScript (React)",
    js: "JavaScript",
    jsx: "JavaScript (React)",
    py: "Python",
    rb: "Ruby",
    go: "Go",
    rs: "Rust",
    java: "Java",
    swift: "Swift",
  };

  for (const [ext, count] of Object.entries(extCount)) {
    if (count > 5 && langMap[ext] && !stack.languages.includes(langMap[ext])) {
      stack.languages.push(langMap[ext]);
    }
  }

  // Deduplicate
  for (const key of Object.keys(stack)) {
    stack[key] = [...new Set(stack[key])];
  }

  return stack;
}

function summarizePatterns(
  files: Array<{ path: string; content: string }>,
): string[] {
  const patterns: string[] = [];

  // Check for common patterns
  const hasApiRoutes = files.some(
    (f) =>
      f.path.includes("/api/") ||
      f.path.includes("/routes/") ||
      f.path.includes("route.ts"),
  );
  if (hasApiRoutes) patterns.push("API routes/endpoints");

  const hasComponents = files.some(
    (f) => f.path.includes("/components/") || f.path.includes("/ui/"),
  );
  if (hasComponents) patterns.push("Component-based architecture");

  const hasHooks = files.some(
    (f) => f.path.includes("/hooks/") || f.path.startsWith("use"),
  );
  if (hasHooks) patterns.push("Custom hooks");

  const hasContext = files.some(
    (f) => f.path.includes("/context/") || f.path.includes("Provider"),
  );
  if (hasContext) patterns.push("Context/Provider pattern");

  const hasDb = files.some(
    (f) =>
      f.path.includes("/db/") ||
      f.path.includes("schema") ||
      f.path.includes("migration"),
  );
  if (hasDb) patterns.push("Database layer");

  const hasAuth = files.some(
    (f) =>
      f.path.includes("/auth/") ||
      f.path.includes("middleware") ||
      f.content.includes("session"),
  );
  if (hasAuth) patterns.push("Authentication");

  const hasState = files.some(
    (f) =>
      f.path.includes("/store/") ||
      f.path.includes("zustand") ||
      f.path.includes("recoil") ||
      f.content.includes("createStore"),
  );
  if (hasState) patterns.push("State management");

  return patterns;
}

function buildCodebaseSummary(
  files: Array<{ path: string; content: string }>,
  focus: string | undefined,
  depth: string,
  _appPath: string,
): string {
  const sections: string[] = [];

  sections.push("# Codebase Summary");
  sections.push("");

  // File tree
  sections.push("## Project Structure");
  sections.push("```");
  sections.push(buildFileTree(files, depth === "shallow" ? 3 : 5));
  sections.push("```");
  sections.push("");

  // File stats
  const totalLines = files.reduce(
    (sum, f) => sum + f.content.split("\n").length,
    0,
  );
  const totalSize = files.reduce((sum, f) => sum + f.content.length, 0);
  sections.push(
    `**Stats**: ${files.length} files, ${totalLines.toLocaleString()} lines, ${(totalSize / 1024).toFixed(1)} KB`,
  );
  sections.push("");

  if (depth === "shallow") {
    return sections.join("\n");
  }

  // Tech stack
  const stack = summarizeTechStack(files);
  sections.push("## Tech Stack");
  if (stack.frameworks.length)
    sections.push(`- **Frameworks**: ${stack.frameworks.join(", ")}`);
  if (stack.languages.length)
    sections.push(`- **Languages**: ${stack.languages.join(", ")}`);
  if (stack.libraries.length)
    sections.push(`- **Libraries**: ${stack.libraries.join(", ")}`);
  if (stack.tools.length)
    sections.push(`- **Tools**: ${stack.tools.join(", ")}`);
  sections.push("");

  // Patterns
  const patterns = summarizePatterns(files);
  if (patterns.length) {
    sections.push("## Architecture Patterns");
    for (const pattern of patterns) {
      sections.push(`- ${pattern}`);
    }
    sections.push("");
  }

  if (depth === "normal") {
    return sections.join("\n");
  }

  // Deep: Key files analysis
  if (focus) {
    sections.push(`## Focus Area: ${focus}`);
    const focusFiles = files.filter(
      (f) =>
        f.path.toLowerCase().includes(focus.toLowerCase()) ||
        f.content.toLowerCase().includes(focus.toLowerCase()),
    );

    if (focusFiles.length > 0) {
      sections.push(`Found ${focusFiles.length} files related to "${focus}":`);
      for (const file of focusFiles.slice(0, 20)) {
        const analysis = analyzeFile(file.content, file.path);
        sections.push(`\n### ${file.path}`);
        sections.push(`- ${analysis.lines} lines`);
        if (analysis.imports.length) {
          sections.push(
            `- Imports: ${analysis.imports.slice(0, 5).join(", ")}${analysis.imports.length > 5 ? ` (+${analysis.imports.length - 5} more)` : ""}`,
          );
        }
        if (analysis.exports.length) {
          sections.push(`- Exports: ${analysis.exports.length} items`);
        }
      }
    } else {
      sections.push(`No files found matching "${focus}"`);
    }
  }

  sections.push("");

  // Dependency graph (simplified)
  sections.push("## Key Dependencies (Import Graph)");
  const importCounts: Record<string, number> = {};
  for (const file of files) {
    const analysis = analyzeFile(file.content, file.path);
    for (const imp of analysis.imports) {
      if (imp.startsWith(".") || imp.startsWith("/")) {
        importCounts[imp] = (importCounts[imp] || 0) + 1;
      }
    }
  }

  const topImports = Object.entries(importCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 15);

  if (topImports.length) {
    for (const [path, count] of topImports) {
      sections.push(`- \`${path}\` (imported ${count}x)`);
    }
  }
  sections.push("");

  return sections.join("\n");
}

function buildSummaryAttributes(
  args: Partial<z.infer<typeof codebaseSummarySchema>>,
): string {
  const attrs: string[] = [];
  if (args.app_name) attrs.push(`app_name="${escapeXmlAttr(args.app_name)}"`);
  if (args.focus) attrs.push(`focus="${escapeXmlAttr(args.focus)}"`);
  if (args.depth) attrs.push(`depth="${escapeXmlAttr(args.depth)}"`);
  return attrs.join(" ");
}

export const codebaseSummaryTool: ToolDefinition<
  z.infer<typeof codebaseSummarySchema>
> = {
  name: "codebase_summary",
  description: DESCRIPTION,
  inputSchema: codebaseSummarySchema,
  defaultConsent: "always",

  getConsentPreview: (args) => {
    let preview = "Summarize codebase";
    if (args.app_name) preview += ` (app: ${args.app_name})`;
    if (args.focus) preview += ` focusing on "${args.focus}"`;
    return preview;
  },

  buildXml: (args, isComplete) => {
    if (isComplete) return undefined;
    return `<dyad-codebase-summary ${buildSummaryAttributes(args)}>Analyzing codebase...`;
  },

  execute: async (args, ctx: AgentContext) => {
    const depth = args.depth || "normal";
    logger.log(
      `Executing codebase_summary (depth: ${depth}, focus: ${args.focus || "general"})`,
    );

    ctx.onXmlStream(
      `<dyad-codebase-summary ${buildSummaryAttributes(args)}>Reading codebase...`,
    );

    const targetAppPath = resolveTargetAppPath(ctx, args.app_name);

    ctx.abortSignal?.throwIfAborted();

    // Extract codebase
    const { files } = await extractCodebase({
      appPath: targetAppPath,
      chatContext: {
        contextPaths: [],
        smartContextAutoIncludes: [],
        excludePaths: [],
      },
    });

    const filteredFiles = filterDyadInternalFiles(files, args.app_name);

    ctx.onXmlStream(
      `<dyad-codebase-summary ${buildSummaryAttributes(args)}>Analyzing ${filteredFiles.length} files...`,
    );

    const summary = buildCodebaseSummary(
      filteredFiles.map((f) => ({ path: f.path, content: f.content })),
      args.focus,
      depth,
      targetAppPath,
    );

    ctx.onXmlComplete(
      `<dyad-codebase-summary ${buildSummaryAttributes(args)}>\n${escapeXmlContent(summary)}\n</dyad-codebase-summary>`,
    );

    logger.log(
      `Codebase summary completed: ${filteredFiles.length} files analyzed`,
    );

    return summary;
  },
};
