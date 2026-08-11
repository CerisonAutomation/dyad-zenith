import { z } from "zod";
import log from "electron-log";
import {
  ToolDefinition,
  AgentContext,
  escapeXmlAttr,
  escapeXmlContent,
} from "./types";
import { generateText } from "ai";
import { resolveAgentModelRuntime } from "../agent_model_runtime";
import { execGitCommand } from "../utils";
import { resolveTargetAppPath } from "./resolve_app_context";
import { join } from "path";
import { safeJoin } from "@/ipc/utils/path_utils";

const logger = log.scope("code_reviewer");

// ============================================================================
// Schema
// ============================================================================

const codeReviewerSchema = z.object({
  mode: z
    .enum(["diff", "files", "recent", "typescript_strictness", "build_check"])
    .optional()
    .describe(
      "Review mode: diff (uncommitted changes), files (specific files), recent (last N commits), typescript_strictness (scan for any/as any/@ts-ignore/@ts-nocheck/empty catch), build_check (run tsc --noEmit + lint). Default: diff.",
    ),
  files: z
    .array(z.string())
    .optional()
    .describe("Specific file paths to review. Required when mode is 'files'."),
  commits: z
    .number()
    .min(1)
    .max(20)
    .optional()
    .describe(
      "Number of recent commits to review. Used with mode='recent'. Default: 5.",
    ),
  focus: z
    .enum(["security", "performance", "quality", "typescript", "all"])
    .optional()
    .describe(
      "Review focus: security (vulnerabilities), performance (bottlenecks), quality (maintainability), typescript (type safety), all (everything). Default: all.",
    ),
  severity_threshold: z
    .enum(["critical", "major", "minor", "all"])
    .optional()
    .describe("Only report issues at this severity or higher. Default: all."),
  app_name: z
    .string()
    .optional()
    .describe(
      "If reviewing a referenced app, specify its name. Omit for the current app.",
    ),
});

// ============================================================================
// Helpers
// ============================================================================

async function getDiffReview(
  targetAppPath: string,
  ctx: AgentContext,
): Promise<string> {
  ctx.abortSignal?.throwIfAborted();

  let diff = "";
  try {
    diff = await execGitCommand(targetAppPath, ["diff"]);
  } catch {
    // Try staged diff
    try {
      diff = await execGitCommand(targetAppPath, ["diff", "--cached"]);
    } catch {
      throw new Error("No uncommitted changes found (working tree is clean).");
    }
  }

  if (!diff.trim()) {
    throw new Error("No uncommitted changes found (working tree is clean).");
  }

  return diff;
}

async function getFilesReview(
  files: string[],
  targetAppPath: string,
): Promise<string> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");

  const parts: string[] = [];
  for (const file of files) {
    try {
      const fullPath = safeJoin(targetAppPath, file);
      const content = await fs.readFile(fullPath, "utf-8");
      parts.push(`=== FILE: ${file} ===\n${content}`);
    } catch {
      parts.push(`=== FILE: ${file} === [ERROR: Could not read file]`);
    }
  }
  return parts.join("\n\n");
}

async function getRecentReview(
  commits: number,
  targetAppPath: string,
  ctx: AgentContext,
): Promise<string> {
  ctx.abortSignal?.throwIfAborted();

  const logOutput = await execGitCommand(targetAppPath, [
    "log",
    `-${commits}`,
    "--oneline",
  ]);

  const hashes = logOutput
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => l.split(" ")[0]);

  const diffs: string[] = [];
  for (const hash of hashes) {
    try {
      const diff = await execGitCommand(targetAppPath, [
        "diff",
        `${hash}~1`,
        hash,
      ]);
      if (diff.trim()) {
        diffs.push(`=== COMMIT: ${hash} ===\n${diff}`);
      }
    } catch {
      // Skip commits where diff fails (e.g., first commit)
    }
  }

  return diffs.join("\n\n");
}

// ============================================================================
// TypeScript Strictness Scanner
// ============================================================================

interface TSStrictnessIssue {
  file: string;
  line: number;
  severity: "critical" | "major" | "minor";
  code: string;
  description: string;
  fix: string;
}

const TS_VIOLATIONS = [
  {
    pattern: /\bany\b(?!\s*;|\s*\))/g,
    id: "TS-any",
    severity: "major" as const,
    desc: "Explicit 'any' type — weakens type safety",
    fix: "Replace with specific type, unknown, or generics",
  },
  {
    pattern: /\bas\s+any\b/g,
    id: "TS-as-any",
    severity: "critical" as const,
    desc: "Type assertion to 'any' — bypasses all type checking",
    fix: "Use proper type narrowing, type guards, or correct the type",
  },
  {
    pattern: /@ts-ignore/g,
    id: "TS-ignore",
    severity: "critical" as const,
    desc: "@ts-ignore suppresses TypeScript errors",
    fix: "Fix the underlying type error; use @ts-expect-error if intentional",
  },
  {
    pattern: /@ts-nocheck/g,
    id: "TS-nocheck",
    severity: "critical" as const,
    desc: "@ts-nocheck disables ALL type checking in file",
    fix: "Remove and fix type errors; split file if needed",
  },
  {
    pattern: /catch\s*\(\s*\w*\s*\)\s*\{\s*\}/g,
    id: "TS-empty-catch",
    severity: "major" as const,
    desc: "Empty catch block — silently swallows errors",
    fix: "Log the error, rethrow, or handle explicitly",
  },
  {
    pattern: /!\s*$/gm,
    id: "TS-non-null",
    severity: "minor" as const,
    desc: "Non-null assertion (!) — can cause runtime crashes",
    fix: "Use optional chaining (?.) or proper null checks",
  },
];

async function scanTypeScriptStrictness(
  targetAppPath: string,
  ctx: AgentContext,
): Promise<TSStrictnessIssue[]> {
  ctx.abortSignal?.throwIfAborted();
  const issues: TSStrictnessIssue[] = [];
  const { readdir, readFile, stat } = await import("node:fs/promises");
  const { join } = await import("node:path");

  async function walk(dir: string, depth = 0): Promise<void> {
    if (depth > 5) return;
    try {
      const entries = await readdir(dir);
      for (const entry of entries) {
        if (["node_modules", ".git", "dist", "build", ".next"].includes(entry))
          continue;
        const fullPath = join(dir, entry);
        const s = await stat(fullPath);
        if (s.isDirectory()) {
          await walk(fullPath, depth + 1);
        } else if (
          /\.(ts|tsx)$/.test(entry) &&
          !/\.(test|spec)\./.test(entry)
        ) {
          const content = await readFile(fullPath, "utf-8");
          const lines = content.split("\n");
          const relPath = fullPath.replace(targetAppPath + "/", "");

          for (const violation of TS_VIOLATIONS) {
            violation.pattern.lastIndex = 0;
            for (let i = 0; i < lines.length; i++) {
              violation.pattern.lastIndex = 0;
              if (violation.pattern.test(lines[i])) {
                issues.push({
                  file: relPath,
                  line: i + 1,
                  severity: violation.severity,
                  code: violation.id,
                  description: violation.desc,
                  fix: violation.fix,
                });
                break; // One per pattern per file
              }
            }
          }
        }
      }
    } catch {
      // Permission error
    }
  }

  await walk(targetAppPath);
  return issues;
}

async function runBuildCheck(
  targetAppPath: string,
  ctx: AgentContext,
): Promise<string> {
  ctx.abortSignal?.throwIfAborted();
  const { spawnSync } = await import("node:child_process");
  const output: string[] = [];
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";

  const run = (args: string[], timeout: number) =>
    spawnSync(npx, args, {
      cwd: targetAppPath,
      timeout,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      maxBuffer: 4 * 1024 * 1024,
    });

  // TypeScript check: argument-vector execution avoids shell interpolation.
  const typecheck = run(["tsc", "--noEmit"], 120_000);
  if (typecheck.status === 0) {
    output.push("✅ TypeScript: no errors");
  } else {
    const details = `${typecheck.stdout || ""}\n${typecheck.stderr || ""}`;
    const errorCount = (details.match(/error TS\d+/g) || []).length;
    output.push(`❌ TypeScript: ${errorCount || "unknown number of"} error(s)`);
    output.push(details.slice(0, 3000));
  }

  ctx.abortSignal?.throwIfAborted();

  // Prefer a framework lint command, then fall back to ESLint. Run each command
  // independently instead of a shell `||` chain so arguments cannot become code.
  let lint = run(["next", "lint"], 60_000);
  if (lint.status !== 0) {
    lint = run(["eslint", ".", "--max-warnings=0"], 60_000);
  }
  const lintText = `${lint.stdout || ""}\n${lint.stderr || ""}`.trim();
  if (lint.status === 0) {
    output.push(lintText ? `✅ Lint: clean\n${lintText.slice(0, 1200)}` : "✅ Lint: clean");
  } else if ((lint.error as any)?.code === "ENOENT") {
    output.push("ℹ️ Lint: runner unavailable");
  } else {
    output.push(`⚠️ Lint check did not pass:\n${lintText.slice(0, 2000)}`);
  }

  return output.join("\n");
}

// ============================================================================
// Tool Definition
// ============================================================================

export const codeReviewerTool: ToolDefinition<
  z.infer<typeof codeReviewerSchema>
> = {
  name: "code_reviewer",
  description:
    "Review code for bugs, security, performance, quality, and TypeScript strictness. Modes: diff (uncommitted changes), files (specific files), recent (last N commits), typescript_strictness (scan for any/as any/@ts-ignore/empty catch), build_check (run tsc --noEmit + lint).",
  inputSchema: codeReviewerSchema,
  defaultConsent: "always",

  getConsentPreview: (args) => {
    return [
      `<dyad-reviewer-preview mode="${escapeXmlAttr(args.mode || "diff")}" focus="${escapeXmlAttr(args.focus || "all")}"/>`,
    ].join("\n");
  },

  buildXml: (args) => {
    return [
      `<dyad-code-reviewer mode="${escapeXmlAttr(args.mode || "diff")}" focus="${escapeXmlAttr(args.focus || "all")}">`,
      args.files
        ? `<files>${args.files.map((f) => `<file>${escapeXmlContent(f)}</file>`).join("")}</files>`
        : "",
      args.commits ? `<commits>${args.commits}</commits>` : "",
      `</dyad-code-reviewer>`,
    ].join("\n");
  },

  execute: async (args, ctx: AgentContext) => {
    ctx.abortSignal?.throwIfAborted();
    const mode = args.mode || "diff";
    const focus = args.focus || "all";
    const severityThreshold = args.severity_threshold || "all";

    logger.log(`Executing code_reviewer: mode=${mode}, focus=${focus}`);

    ctx.abortSignal?.throwIfAborted();

    ctx.onXmlStream(
      `<dyad-code-reviewer status="collecting" mode="${escapeXmlAttr(mode)}"/>`,
    );

    const targetAppPath = resolveTargetAppPath(ctx, args.app_name);

    // Collect the code to review
    let codeToReview: string;

    switch (mode) {
      case "diff":
        codeToReview = await getDiffReview(targetAppPath, ctx);
        break;

      case "files": {
        if (!args.files || args.files.length === 0) {
          throw new Error("files parameter is required when mode is 'files'.");
        }
        codeToReview = await getFilesReview(args.files, targetAppPath);
        break;
      }

      case "recent": {
        const commits = args.commits || 5;
        codeToReview = await getRecentReview(commits, targetAppPath, ctx);
        break;
      }

      case "typescript_strictness": {
        const tsIssues = await scanTypeScriptStrictness(targetAppPath, ctx);
        const critical = tsIssues.filter((i) => i.severity === "critical");
        const major = tsIssues.filter((i) => i.severity === "major");
        const minor = tsIssues.filter((i) => i.severity === "minor");

        const tsOutput = [
          `# TypeScript Strictness Report`,
          ``,
          `🔴 Critical: ${critical.length} | 🟡 Major: ${major.length} | 🔵 Minor: ${minor.length}`,
          `**Total violations:** ${tsIssues.length}`,
          ``,
        ];

        if (critical.length > 0) {
          tsOutput.push(`## 🔴 Critical Violations`);
          for (const issue of critical.slice(0, 20)) {
            tsOutput.push(
              `- **${issue.file}:${issue.line}** [${issue.code}]: ${issue.description}`,
            );
            tsOutput.push(`  → ${issue.fix}`);
          }
          tsOutput.push("");
        }

        if (major.length > 0) {
          tsOutput.push(`## 🟡 Major Violations`);
          for (const issue of major.slice(0, 20)) {
            tsOutput.push(
              `- **${issue.file}:${issue.line}** [${issue.code}]: ${issue.description}`,
            );
            tsOutput.push(`  → ${issue.fix}`);
          }
          tsOutput.push("");
        }

        if (minor.length > 0) {
          tsOutput.push(`## 🔵 Minor Violations`);
          for (const issue of minor.slice(0, 15)) {
            tsOutput.push(
              `- **${issue.file}:${issue.line}** [${issue.code}]: ${issue.description}`,
            );
          }
          tsOutput.push("");
        }

        if (tsIssues.length === 0) {
          tsOutput.push(`✅ No TypeScript strictness violations found.`);
        }

        const result = tsOutput.join("\n");
        ctx.onXmlComplete?.(result);
        return result;
      }

      case "build_check": {
        const buildResult = await runBuildCheck(targetAppPath, ctx);
        const result = `# Build Check\n\n${buildResult}`;
        ctx.onXmlComplete?.(result);
        return result;
      }

      default:
        throw new Error(`Unknown mode: ${mode}`);
    }

    ctx.abortSignal?.throwIfAborted();

    ctx.onXmlStream(
      `<dyad-code-reviewer status="reviewing" focus="${escapeXmlAttr(focus)}"/>`,
    );

    const runtime = await resolveAgentModelRuntime(ctx);

    const focusInstructions: Record<string, string> = {
      security:
        "Focus on security vulnerabilities: injection, auth bypass, data leaks, XSS, CSRF, insecure defaults.",
      performance:
        "Focus on performance: N+1 queries, blocking calls, memory leaks, unnecessary re-renders, O(n²) loops.",
      quality:
        "Focus on code quality: maintainability, readability, patterns, DRY violations, naming, documentation.",
      typescript:
        "Focus on TypeScript strictness: detect 'any' types, 'as any' casts, @ts-ignore/@ts-nocheck, empty catch blocks, non-null assertions. Recommend stricter types.",
      all: "Review for ALL issues: bugs, security, performance, quality, TypeScript strictness, and best practices.",
    };

    const reviewPrompt = `You are an expert code reviewer. Analyze the following code changes/code and provide a thorough review.

${focusInstructions[focus]}

${severityThreshold !== "all" ? `Only report issues with severity ${severityThreshold} or higher.\n` : ""}
Provide your review in this exact JSON format:
{
  "summary": "Brief overall assessment",
  "issues": [
    {
      "severity": "critical|major|minor",
      "category": "bug|security|performance|quality|pattern",
      "title": "Short issue title",
      "description": "Detailed description of the issue",
      "suggestion": "How to fix it",
      "line_hint": "Approximate location or 'N/A'"
    }
  ],
  "positives": ["What's done well"],
  "overall_rating": "1-10",
  "recommendation": "approve|request_changes|needs_discussion"
}

CODE TO REVIEW:
${codeToReview.slice(0, 16000)}`;

    const result = await generateText({
      model: runtime.model,
        headers: runtime.headers,
        providerOptions: runtime.providerOptions,
        temperature: runtime.temperature,
      prompt: reviewPrompt,
      maxOutputTokens: 4096,
    });

    ctx.abortSignal?.throwIfAborted();

    ctx.onXmlStream(`<dyad-code-reviewer status="complete"/>`);

    // Parse JSON response
    let reviewData: {
      summary: string;
      issues: Array<{
        severity: string;
        category: string;
        title: string;
        description: string;
        suggestion: string;
        line_hint?: string;
      }>;
      positives: string[];
      overall_rating: string;
      recommendation: string;
    };

    try {
      const jsonMatch = result.text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        reviewData = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error("No JSON found");
      }
    } catch {
      return [
        `# Code Review`,
        ``,
        result.text,
        ``,
        `<dyad-code-reviewer status="complete" format="raw"/>`,
      ].join("\n");
    }

    // Format output
    const output: string[] = [
      `# Code Review`,
      ``,
      `**Mode:** ${mode} | **Focus:** ${focus} | **Rating:** ${reviewData.overall_rating}/10`,
      `**Recommendation:** ${reviewData.recommendation}`,
      ``,
      `## Summary`,
      reviewData.summary,
      ``,
    ];

    // Issues
    const severityOrder = ["critical", "major", "minor"];
    const filteredIssues = reviewData.issues.filter((issue) => {
      if (severityThreshold === "all") return true;
      return (
        severityOrder.indexOf(issue.severity) <=
        severityOrder.indexOf(severityThreshold)
      );
    });

    const criticalIssues = filteredIssues.filter(
      (i) => i.severity === "critical",
    );
    const majorIssues = filteredIssues.filter((i) => i.severity === "major");
    const minorIssues = filteredIssues.filter((i) => i.severity === "minor");

    if (criticalIssues.length > 0) {
      output.push(`## 🔴 Critical Issues (${criticalIssues.length})`);
      for (const issue of criticalIssues) {
        output.push(`### ${issue.title}`);
        output.push(
          `**Category:** ${issue.category} | **Location:** ${issue.line_hint || "N/A"}`,
        );
        output.push(issue.description);
        output.push(`**Fix:** ${issue.suggestion}`);
        output.push("");
      }
    }

    if (majorIssues.length > 0) {
      output.push(`## 🟡 Major Issues (${majorIssues.length})`);
      for (const issue of majorIssues) {
        output.push(`### ${issue.title}`);
        output.push(
          `**Category:** ${issue.category} | **Location:** ${issue.line_hint || "N/A"}`,
        );
        output.push(issue.description);
        output.push(`**Fix:** ${issue.suggestion}`);
        output.push("");
      }
    }

    if (minorIssues.length > 0) {
      output.push(`## 🟢 Minor Issues (${minorIssues.length})`);
      for (const issue of minorIssues) {
        output.push(
          `- **${issue.title}** (${issue.category}): ${issue.suggestion}`,
        );
      }
      output.push("");
    }

    if (filteredIssues.length === 0) {
      output.push(`## ✅ No Issues Found`);
      output.push("");
    }

    if (reviewData.positives.length > 0) {
      output.push(`## What's Good`);
      for (const pos of reviewData.positives) {
        output.push(`- ${pos}`);
      }
      output.push("");
    }

    output.push(
      `<dyad-code-reviewer status="complete" issues="${filteredIssues.length}" critical="${criticalIssues.length}" major="${majorIssues.length}" minor="${minorIssues.length}"/>`,
    );

    return output.join("\n");
  },
};
