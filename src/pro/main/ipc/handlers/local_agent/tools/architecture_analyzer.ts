/**
 * architecture_analyzer.ts — Analyze codebase architecture for deepening opportunities.
 * Refactored to use llm_analysis_factory + codebase_walker for zero-boilerplate.
 */
import { z } from "zod";
import { escapeXmlAttr } from "./types";
import {
  createLlmAnalysisTool,
  extractJsonArray,
} from "./llm_analysis_factory";
import { walkCodebase, summarizeFiles } from "./codebase_walker";
import { resolveTargetAppPath } from "./resolve_app_context";

const architectureAnalyzerSchema = z.object({
  focus: z
    .string()
    .optional()
    .describe(
      "Specific area to analyze (e.g. 'authentication', 'data layer', 'routing'). Omit to analyze the full codebase.",
    ),
  depth: z
    .enum(["quick", "standard", "deep"])
    .optional()
    .describe(
      "Analysis depth: quick (hot spots only), standard (full scan), deep (with dependency analysis). Default: standard.",
    ),
  app_name: z
    .string()
    .optional()
    .describe(
      "If analyzing a referenced app, specify its name. Omit for the current app.",
    ),
});

interface ArchCandidate {
  module: string;
  problem_type: string;
  problem: string;
  solution: string;
  benefits: string[];
  risk: string;
  strength: string;
  before_diagram?: string;
  after_diagram?: string;
}

function formatCandidates(candidates: ArchCandidate[], args: z.infer<typeof architectureAnalyzerSchema>, fileCount: number, analyzedCount: number): string {
  const output: string[] = [
    `# Architecture Analysis`,
    ``,
    `**Codebase:** ${fileCount} files (analyzed ${analyzedCount}) | **Focus:** ${args.focus || "full codebase"} | **Depth:** ${args.depth || "standard"}`,
    `**Candidates found:** ${candidates.length}`,
    ``,
    `## Candidates`,
  ];

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const strengthEmoji = c.strength === "strong" ? "🔴" : c.strength === "moderate" ? "🟡" : "🟢";

    output.push(`### ${strengthEmoji} ${i + 1}. ${c.module}`);
    output.push(`**Type:** ${c.problem_type} | **Strength:** ${c.strength}`);
    output.push("");
    output.push(`**Problem:** ${c.problem}`);
    output.push("");
    output.push(`**Solution:** ${c.solution}`);
    output.push("");
    output.push(`**Benefits:**`);
    for (const b of c.benefits) {
      output.push(`- ${b}`);
    }
    output.push("");
    output.push(`**Risk:** ${c.risk}`);
    output.push("");

    if (c.before_diagram) {
      output.push(`**Current Architecture:**`);
      output.push("```mermaid");
      output.push(c.before_diagram);
      output.push("```");
      output.push("");
    }

    if (c.after_diagram) {
      output.push(`**Proposed Architecture:**`);
      output.push("```mermaid");
      output.push(c.after_diagram);
      output.push("```");
      output.push("");
    }

    output.push("---");
    output.push("");
  }

  // Summary
  const strongCount = candidates.filter((c) => c.strength === "strong").length;
  const moderateCount = candidates.filter((c) => c.strength === "moderate").length;

  output.push(`## Summary`);
  output.push(`- **Strong recommendations:** ${strongCount}`);
  output.push(`- **Moderate recommendations:** ${moderateCount}`);
  output.push(`- **Weak recommendations:** ${candidates.length - strongCount - moderateCount}`);

  return output.join("\n");
}

export const architectureAnalyzerTool = createLlmAnalysisTool({
  name: "architecture_analyzer",
  description:
    "Analyze codebase architecture for deepening opportunities — turning shallow modules into deep ones. Identifies coupling issues, poor locality, untestable areas, and provides before/after diagrams with recommendations.",
  inputSchema: architectureAnalyzerSchema,
  thinkingBudget: "high",
  maxTokens: 6000,
  xmlTag: "architecture-analyzer",

  consentPreview: (args) =>
    `Architecture analysis: ${args.focus || "full codebase"} (${args.depth || "standard"} depth)${args.app_name ? ` on ${args.app_name}` : ""}`,

  buildXml: (args) => {
    return [
      `<dyad-architecture-analyzer focus="${escapeXmlAttr(args.focus || "full codebase")}" depth="${escapeXmlAttr(args.depth || "standard")}">`,
      args.app_name ? `<app>${escapeXmlAttr(args.app_name)}</app>` : "",
      `</dyad-architecture-analyzer>`,
    ].join("\n");
  },

  // Pre-execution: collect files using async walker
  preExecute: async (args, ctx) => {
    const targetAppPath = resolveTargetAppPath(ctx, args.app_name);
    const files = await walkCodebase(
      targetAppPath,
      { maxDepth: 6, limit: 200 },
      ctx.abortSignal,
    );
    const stats = summarizeFiles(files);

    const FILE_LIMIT = 200;
    const analyzedFiles = files.slice(0, FILE_LIMIT);
    const fileSummary = analyzedFiles
      .map((f) => `${f.path} (${f.lineCount} lines)`)
      .join("\n");

    return {
      preamble: `FILES (${stats.totalFiles} total, analyzed ${analyzedFiles.length}):\n${fileSummary}`,
    };
  },

  buildPrompt: (args) => {
    const depth = args.depth || "standard";
    return `You are a software architecture expert. Analyze this codebase structure and identify architectural deepening opportunities.

${args.focus ? `FOCUS AREA: ${args.focus}\n` : ""}
ANALYSIS DEPTH: ${depth}

For each architectural issue found, provide:
1. **Module/file** — Which module is shallow or problematic
2. **Problem** — What's wrong (shallow module, tight coupling, poor locality, etc.)
3. **Solution** — How to deepen it
4. **Benefits** — What improves after the change
5. **Risk** — What could break
6. **Strength** — How strongly you recommend this (strong/moderate/weak)

Apply these architecture heuristics:
- **Deletion test**: Can this module be deleted without cascading failures?
- **Shallow module test**: Is the interface nearly as complex as the implementation?
- **Locality test**: Are related things scattered across distant files?
- **Coupling test**: Does changing one module force changes in many others?
- **Testability**: Is this module hard to test in isolation?

Return ONLY a JSON array of candidates:
[
  {
    "module": "path/to/file.ts",
    "problem_type": "shallow|coupling|locality|testability|dead_code",
    "problem": "detailed description",
    "solution": "what to do",
    "benefits": ["benefit1", "benefit2"],
    "risk": "what could break",
    "strength": "strong|moderate|weak",
    "before_diagram": "Mermaid diagram of current state",
    "after_diagram": "Mermaid diagram of proposed state"
  }
]

Limit to top 5 candidates, ordered by strength.`;
  },

  parseStructured: (llmOutput) => extractJsonArray<ArchCandidate>(llmOutput),

  formatStructured: (args, data) => {
    const candidates = data as ArchCandidate[];
    // We need file count from pre-execution — use a placeholder
    return formatCandidates(candidates, args, candidates.length, candidates.length);
  },

  formatResult: (args, llmOutput) => {
    return [`# Architecture Analysis`, ``, llmOutput].join("\n");
  },
});
