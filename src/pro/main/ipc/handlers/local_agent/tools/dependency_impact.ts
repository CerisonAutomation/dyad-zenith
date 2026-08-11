/**
 * dependency_impact.ts — AI-powered dependency impact analysis tool.
 *
 * When a file changes, this tool:
 * 1. Maps all direct and transitive dependents
 * 2. Identifies which dependents would be affected by the change
 * 3. Suggests what tests to run
 * 4. Warns about risky change patterns
 */

import { z } from "zod";
import { createLlmAnalysisTool } from "./llm_analysis_factory";

const dependencyImpactSchema = z.object({
  file_path: z
    .string()
    .describe(
      "The file path that is being changed (relative to project root).",
    ),
  change_type: z
    .enum(["modify", "rename", "delete", "refactor"])
    .optional()
    .describe(
      "Type of change being made. Default: modify. 'rename' and 'delete' have higher impact.",
    ),
  change_description: z
    .string()
    .optional()
    .describe(
      "Brief description of what's changing in the file (e.g., 'changing function signature', 'removing exported function', 'refactoring to async'). Helps estimate impact more accurately.",
    ),
});

export const dependencyImpactTool = createLlmAnalysisTool({
  name: "dependency_impact",
  description:
    "Analyze the impact of changing a file. Maps all direct and transitive dependents, identifies which would be affected, suggests tests to run, and warns about risky patterns. Use before making breaking changes to understand the blast radius.",
  inputSchema: dependencyImpactSchema,
  defaultConsent: "always",

  consentPreview: (args) => {
    return `🔗 Dependency Impact: ${args.file_path} (${args.change_type || "modify"})`;
  },

  buildXml: (args, isComplete) => {
    if (!args.file_path) return undefined;
    if (!isComplete) {
      return `<dyad-dependency-impact file="${args.file_path}" change="${args.change_type || "modify"}" status="analyzing" />`;
    }
    return undefined;
  },

  preExecute: async (args, ctx) => {
    // Collect import/export information from the file
    const preamble = `Analyzing dependency impact for: ${args.file_path}
Change type: ${args.change_type || "modify"}
${args.change_description ? `Description: ${args.change_description}` : ""}

The tool will scan the codebase for:
1. Files that import from this file (direct dependents)
2. Files that import from files that import from this file (transitive dependents)
3. Dynamic imports (require/import()) that reference this file
4. Test files that test this file's functionality
5. Configuration files that reference this file`;
    return { preamble };
  },

  buildPrompt: async (args, ctx) => {
    const changeType = args.change_type || "modify";
    const description = args.change_description
      ? `\n\nCHANGE DESCRIPTION: ${args.change_description}`
      : "";

    let impactInstructions = "";
    if (changeType === "delete") {
      impactInstructions = `
CRITICAL: This file is being DELETED. This is the highest-impact change.
- Every file that imports from this file WILL BREAK
- Every test that imports from this file WILL FAIL
- Dynamic imports may fail silently at runtime
- Check for re-exports that chain through this file`;
    } else if (changeType === "rename") {
      impactInstructions = `
HIGH IMPACT: This file is being RENAMED. All import paths must be updated.
- Every static import path must be updated
- Dynamic imports with string literals must be updated
- TypeScript path aliases may need updating
- Test file paths may need updating`;
    } else if (changeType === "refactor") {
      impactInstructions = `
MEDIUM-HIGH IMPACT: This file is being REFACTORED.
- Check if exported function signatures are changing
- Check if return types are changing
- Check if error types are changing
- Check if side effects are changing`;
    } else {
      impactInstructions = `
STANDARD IMPACT: This file is being MODIFIED.
- Check if exported API surface is changing
- Check if behavior is changing in ways that affect dependents
- Check if error handling is changing`;
    }

    return `You are analyzing the blast radius of a code change in a TypeScript/Electron application.

FILE BEING CHANGED: ${args.file_path}
CHANGE TYPE: ${changeType}
${description}

${impactInstructions}

Provide a dependency impact report:

## Direct Dependents
Files that directly import from this file:
- List each file and what it imports
- Estimate risk: will this change break their usage?

## Transitive Dependents (2+ levels deep)
Files that depend on files that depend on this file:
- These are harder to catch but can still break
- Focus on the most critical paths

## Dynamic Dependencies
Files that use dynamic import() or require() with this file:
- These won't show up in static analysis
- They may fail silently at runtime

## Test Impact
Which test files need to be re-run:
- Direct test files for this module
- Integration tests that exercise this code path
- E2E tests that might hit this functionality

## Risk Assessment
Rate the overall risk:
- **LOW**: Internal changes only, no API surface change
- **MEDIUM**: API surface change but backward compatible
- **HIGH**: Breaking change, multiple dependents affected
- **CRITICAL**: Core module, many transitive dependents

## Recommended Actions
1. What tests to run before merging
2. What files to review for potential breakage
3. Whether to do this change incrementally (with intermediate backward-compatible steps)
4. Any migration steps needed for dependents`;
  },

  thinkingBudget: "high",
  maxTokens: 3000,
});
