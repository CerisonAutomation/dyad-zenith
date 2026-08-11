import { z } from "zod";
import log from "electron-log";

import { isCodeExplorerReady } from "@/ipc/processors/code_explorer";
import { readSettings } from "@/main/settings";
import { extractCodebase } from "../../../../../../utils/codebase";

import {
  filterDyadInternalFiles,
  resolveTargetAppPath,
} from "./resolve_app_context";
import {
  AgentContext,
  escapeXmlAttr,
  escapeXmlContent,
  ToolDefinition,
} from "./types";

const logger = log.scope("code_search");
const MAX_RESULTS = 12;
const MAX_CONTENT_CHARS_PER_FILE = 60_000;

const codeSearchSchema = z.object({
  query: z.string().trim().min(1).describe("Search query to find relevant files"),
  app_name: z
    .string()
    .optional()
    .describe(
      "Optional referenced app name from an @app:Name mention. Omit for the current app.",
    ),
});

type CodeSearchArgs = z.infer<typeof codeSearchSchema>;

function tokenize(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^\p{L}\p{N}_./-]+/u)
    .map((term) => term.trim())
    .filter((term) => term.length > 1);
}

function countOccurrences(text: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = 0;
  while ((index = text.indexOf(needle, index)) !== -1) {
    count++;
    index += needle.length;
    if (count >= 50) break;
  }
  return count;
}

function rankFiles(
  query: string,
  files: Array<{ path: string; content: string }>,
): Array<{ path: string; score: number }> {
  const terms = [...new Set(tokenize(query))];
  const phrase = query.toLowerCase().trim();

  return files
    .map((file) => {
      const path = file.path.toLowerCase();
      const content = file.content
        .slice(0, MAX_CONTENT_CHARS_PER_FILE)
        .toLowerCase();
      let score = 0;

      if (phrase && path.includes(phrase)) score += 18;
      if (phrase.length >= 4 && content.includes(phrase)) score += 10;

      for (const term of terms) {
        if (path.includes(term)) score += 7;
        const hits = countOccurrences(content, term);
        if (hits > 0) score += 1 + Math.min(5, Math.log2(hits + 1));
      }

      // Prefer source/config files over generated metadata when relevance ties.
      if (/\.(tsx?|jsx?|vue|svelte|css|scss|json|ya?ml|md)$/i.test(file.path)) {
        score += 0.25;
      }
      return { path: file.path, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, MAX_RESULTS);
}

function buildCodeSearchAttributes(args: Partial<CodeSearchArgs>) {
  const queryAttr = args.query ? ` query="${escapeXmlAttr(args.query)}"` : "";
  const appNameAttr = args.app_name
    ? ` app_name="${escapeXmlAttr(args.app_name)}"`
    : "";
  return `${queryAttr}${appNameAttr}`;
}

const DESCRIPTION = `Search the codebase locally by relevance without sending source
code to a hosted search service. The ranker combines exact phrase, path, and
term-frequency signals and returns the strongest file candidates.

Prefer explore_code when the compiler-backed explorer is available and you need
symbol/flow understanding. Use grep for exact text and read_file for known files.`;

export const codeSearchTool: ToolDefinition<CodeSearchArgs> = {
  name: "code_search",
  description: DESCRIPTION,
  inputSchema: codeSearchSchema,
  defaultConsent: "always",

  // The compiler-backed explorer is richer. Keep code_search as a local
  // fallback when that subsystem is unavailable or disabled.
  isEnabled: (ctx) =>
    !(readSettings().enableCodeExplorer && isCodeExplorerReady(ctx.appPath)),

  getConsentPreview: (args) =>
    args.app_name
      ? `Search for "${args.query}" (app: ${args.app_name})`
      : `Search for "${args.query}"`,

  buildXml: (args, isComplete) => {
    if (!args.query) return undefined;
    if (isComplete) return undefined;
    return `<dyad-code-search${buildCodeSearchAttributes(args)}>Searching...`;
  },

  execute: async (args, ctx: AgentContext) => {
    logger.log(`Executing local code search: ${args.query}`);
    const targetAppPath = resolveTargetAppPath(ctx, args.app_name);
    ctx.onXmlStream(
      `<dyad-code-search${buildCodeSearchAttributes(args)}>Searching...`,
    );

    const { files } = await extractCodebase({
      appPath: targetAppPath,
      chatContext: {
        contextPaths: [],
        smartContextAutoIncludes: [],
        excludePaths: [],
      },
    });
    const filteredFiles = filterDyadInternalFiles(files, args.app_name);
    const ranked = rankFiles(args.query, filteredFiles);

    const resultText =
      ranked.length === 0
        ? "No relevant files found."
        : ranked
            .map(
              (entry, index) =>
                `${index + 1}. ${entry.path} (score ${entry.score.toFixed(2)})`,
            )
            .join("\n");

    ctx.onXmlComplete(
      `<dyad-code-search${buildCodeSearchAttributes(args)}>${escapeXmlContent(resultText)}</dyad-code-search>`,
    );

    return ranked.length === 0
      ? "No relevant files found for the given query."
      : `Found ${ranked.length} relevant file(s):\n${resultText}`;
  },
};
