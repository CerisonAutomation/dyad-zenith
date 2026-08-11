/**
 * error_analyzer.ts — AI-powered error analysis tool.
 *
 * Takes a stack trace, error message, or console error and uses AI to:
 * 1. Identify the root cause (not just the symptom)
 * 2. Trace the error through the codebase
 * 3. Suggest a concrete fix with code context
 * 4. Identify related errors or patterns
 */

import { z } from "zod";
import { createLlmAnalysisTool } from "./llm_analysis_factory";

const errorAnalyzerSchema = z.object({
  error: z
    .string()
    .describe(
      "The error message, stack trace, or console error output to analyze.",
    ),
  context: z
    .string()
    .optional()
    .describe(
      "Additional context: what the user was doing when the error occurred, recent code changes, or related logs.",
    ),
  analysis_depth: z
    .enum(["quick", "standard", "deep"])
    .optional()
    .describe(
      "How deep to analyze: quick (root cause + fix), standard (+ related patterns), deep (+ architecture impact). Default: standard.",
    ),
});

export const errorAnalyzerTool = createLlmAnalysisTool({
  name: "error_analyzer",
  description:
    "Analyze an error, stack trace, or crash report with AI. Identifies root cause (not just the symptom), traces through the codebase, suggests concrete fixes, and finds related patterns. Use when you encounter an error you don't understand, or when logs show repeated failures.",
  inputSchema: errorAnalyzerSchema,
  defaultConsent: "always",

  consentPreview: (args) => {
    const preview = args.error.slice(0, 120);
    return `🔍 Error Analysis: ${preview}${args.error.length > 120 ? "..." : ""}`;
  },

  buildXml: (args, isComplete) => {
    if (!args.error) return undefined;
    if (!isComplete) {
      return `<dyad-error-analyzer status="analyzing" depth="${args.analysis_depth || "standard"}">
${args.error.slice(0, 200)}${args.error.length > 200 ? "..." : ""}
</dyad-error-analyzer>`;
    }
    return undefined;
  },

  buildPrompt: async (args, ctx) => {
    const depth = args.analysis_depth || "standard";
    const contextSection = args.context
      ? `\n\nADDITIONAL CONTEXT:\n${args.context}`
      : "";

    let depthInstructions = "";
    if (depth === "quick") {
      depthInstructions = `
Provide a QUICK analysis:
1. **Root Cause** (1-2 sentences): What actually caused this error
2. **Fix** (concrete code change): The exact fix needed
3. **Prevention** (1 sentence): How to prevent this class of error`;
    } else if (depth === "deep") {
      depthInstructions = `
Provide a DEEP analysis:
1. **Root Cause** (detailed): What actually caused this error, tracing through the call stack
2. **Code Flow**: The execution path that led to the error (reference specific files and line numbers)
3. **Fix** (concrete code change): The exact fix needed with before/after code
4. **Related Patterns**: Similar errors or code patterns in the codebase that might have the same issue
5. **Architecture Impact**: Does this error indicate a systemic issue? What design change would prevent this class of error?
6. **Testing**: What test would catch this error in the future?
7. **Prevention**: How to prevent this class of error going forward`;
    } else {
      depthInstructions = `
Provide a STANDARD analysis:
1. **Root Cause** (2-3 sentences): What actually caused this error, not just where it threw
2. **Code Path**: The execution flow that led here (reference files)
3. **Fix** (concrete code change): The exact fix needed with code snippet
4. **Related Patterns**: Check if similar code patterns exist that could have the same issue
5. **Prevention**: How to prevent this class of error`;
    }

    return `You are an expert debugger analyzing an error in a TypeScript/Electron application.

ERROR TO ANALYZE:
${args.error}
${contextSection}

${depthInstructions}

Important rules:
- Focus on the ROOT CAUSE, not just the symptom at the throw site
- Reference specific file paths and line numbers when possible
- Provide concrete, copy-paste-ready fixes
- If the error is a type error, show the exact type mismatch and how to resolve it
- If the error involves async operations, check for race conditions or missing awaits
- If the error is in a React component, check hooks rules, state updates, and effect cleanup`;
  },

  thinkingBudget: "high",
  maxTokens: 4096,
});
