/**
 * ui_ux_reviewer.ts — Reviews UI/UX patterns against design heuristics,
 * checks accessibility, consistency, responsive design, mobile UX,
 * color systems, typography, and design system adherence.
 * Based on [$ui-ux-pro-max], [$mobile-app-ui-design], [$mobile-responsiveness],
 * [$web-design-guidelines], [$ai-model-web].
 */
import { z } from "zod";
import { readFile, readdir, stat } from "fs/promises";
import { join, extname } from "path";
import { generateText } from "ai";
import { resolveAgentModelRuntime } from "../agent_model_runtime";
import { escapeXmlAttr, type ToolDefinition, type ToolResult } from "./types";
import { resolveReadPathWithinApp } from "@/ipc/utils/path_utils";

const INPUT_SCHEMA = z.object({
  target: z
    .enum(["file", "directory", "auto"])
    .default("auto")
    .describe("Review scope: a specific file, a directory, or auto-detect"),
  path: z.string().optional().describe("Path to review (file or directory)"),
  focus: z
    .enum([
      "all",
      "accessibility",
      "responsive",
      "visual_hierarchy",
      "interaction",
      "consistency",
      "mobile_design",
      "color_system",
      "typography",
    ])
    .default("all")
    .describe("What aspect to focus the review on"),
  mobile_audit: z
    .boolean()
    .default(false)
    .describe(
      "Run mobile-specific audits (viewport meta, safe area, touch targets, thumb-zone CTA placement)",
    ),
});

const UI_UX_HEURISTICS = {
  accessibility: [
    "All interactive elements have visible focus indicators",
    "Color is not the sole means of conveying information",
    "Touch targets are at least 44×44px on mobile",
    "Images have meaningful alt text",
    "Form fields have associated labels",
    "ARIA attributes used correctly (no orphaned aria-labels)",
    "Heading hierarchy is logical (h1→h2→h3, no skips)",
    "Links have descriptive text (no 'click here' or 'read more')",
  ],
  responsive: [
    "Layout adapts gracefully between 320px and 1920px",
    "No horizontal scroll at any breakpoint",
    "Text remains readable at all zoom levels (16px+ base)",
    "Navigation transforms appropriately on mobile",
    "Images/media are responsive (max-width: 100%)",
    "No fixed-width containers that overflow on mobile",
  ],
  visual_hierarchy: [
    "Primary action is visually dominant in each section",
    "Content uses consistent spacing rhythm (4px grid)",
    "Typography scale creates clear hierarchy (≤3 font sizes per component)",
    "White space is used intentionally, not accidentally",
    "Visual weight guides eye flow through the page",
    "No competing focal points in the same viewport",
  ],
  interaction: [
    "Hover/active/focus states exist for all interactive elements",
    "Loading states are shown during async operations",
    "Error states are clear and actionable",
    "Empty states guide the user forward",
    "Micro-interactions enhance but don't distract",
    "Form validation is inline, not just on submit",
  ],
  consistency: [
    "Component variants follow a consistent API",
    "Spacing and sizing are systematic (not arbitrary)",
    "Color usage follows the design system tokens",
    "Border radius, shadows, and borders are consistent",
    "Text styles match across similar contexts",
    "Icon style and sizing is uniform",
  ],
  mobile_design: [
    "Viewport meta tag includes width=device-width, initial-scale=1",
    "Safe area insets handled for notched devices (env(safe-area-inset-*))",
    "Touch targets ≥44×44px (WCAG 2.5.8 AAA) or ≥48×48dp (Material)",
    "Primary CTAs placed in thumb-zone (bottom 40% of viewport on mobile)",
    "No pinch-to-zoom blocking (user-scalable=no or maximum-scale=1)",
    "Bottom sheet / drawer patterns for mobile-specific actions",
    "Status bar color matches app chrome (theme-color meta)",
    "No horizontal scroll on mobile viewports",
  ],
  color_system: [
    "60/30/10 color distribution rule followed (dominant/secondary/accent)",
    "All colors map to design tokens (no raw hex/rgb in components)",
    "Sufficient contrast ratios (4.5:1 text, 3:1 large text, 3:1 UI)",
    "Dark mode palette defined with proper semantic mappings",
    "Color is not the sole means of conveying information",
    "Accent color used sparingly for CTAs and highlights",
    "Background/surface hierarchy uses tone variation, not shadows alone",
  ],
  typography: [
    "Fluid typography with clamp() or responsive type scale",
    "Line height appropriate: 1.5 body, 1.2–1.3 headings",
    "Maximum line length 45–75 characters for body text",
    "Font loading uses font-display: swap or optional",
    "No layout shift from web font loading (size-adjust or fallback)",
    "Type scale follows a consistent ratio (1.25 modular or 1.333 major-third)",
    "Paragraphs use appropriate spacing (1em+ margin-bottom)",
  ],
} as const;

type ReviewIssue = {
  severity: "critical" | "major" | "minor" | "suggestion";
  category: string;
  description: string;
  suggestion: string;
  heuristic?: string;
};

function detectIssuesFromCode(code: string, filename: string): ReviewIssue[] {
  const issues: ReviewIssue[] = [];
  const lines = code.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // --- Consistency ---
    if (
      /className="[^"]*\btext-[a-z]+-[0-9]{2,3}\b/.test(line) &&
      !/className="[^"]*dark:/.test(line)
    ) {
      issues.push({
        severity: "minor",
        category: "consistency",
        description: `Line ${lineNum}: Hardcoded color class without dark mode variant`,
        suggestion: "Add dark: variant or use design token",
        heuristic: "Color usage follows the design system tokens",
      });
    }

    // --- Responsive ---
    if (
      /width:\s*\d{3,4}px/.test(line) &&
      !/max-width|min-width|media/.test(
        code.slice(Math.max(0, lineNum - 50), lineNum + 50),
      )
    ) {
      issues.push({
        severity: "minor",
        category: "responsive",
        description: `Line ${lineNum}: Fixed pixel width without responsive context`,
        suggestion:
          "Use responsive width (w-full, max-w-*, or container queries)",
        heuristic: "No fixed-width containers that overflow on mobile",
      });
    }

    // --- Accessibility ---
    if (
      /onClick|onPress/.test(line) &&
      !/aria-|role=/.test(line) &&
      !/button|a\b|<Link|IconButton/.test(line)
    ) {
      issues.push({
        severity: "major",
        category: "accessibility",
        description: `Line ${lineNum}: Click handler on non-interactive element without ARIA role`,
        suggestion:
          "Add role='button' and tabIndex={0}, or use a <button> element",
        heuristic: "All interactive elements have visible focus indicators",
      });
    }

    if (/(?:div|span)\s+onClick/.test(line)) {
      issues.push({
        severity: "major",
        category: "accessibility",
        description: `Line ${lineNum}: Click handler on non-semantic element`,
        suggestion: "Use <button> or <a> instead of <div onClick>",
        heuristic: "All interactive elements have visible focus indicators",
      });
    }

    // --- Interaction ---
    if (
      /import.*from\s+['"]react['"]/.test(line) &&
      /useLayoutEffect/.test(code)
    ) {
      issues.push({
        severity: "minor",
        category: "interaction",
        description: `Line ${lineNum}: useLayoutEffect detected — use useEffect instead unless DOM measurement is needed`,
        suggestion:
          "Replace with useEffect or document why layoutSync is required",
      });
    }

    // --- Consistency (className) ---
    if (/className/.test(line) && line.length > 200) {
      issues.push({
        severity: "suggestion",
        category: "consistency",
        description: `Line ${lineNum}: Very long className string (${line.length} chars)`,
        suggestion: "Consider extracting to a cn() call or Tailwind config",
        heuristic: "Component variants follow a consistent API",
      });
    }

    if (
      /console\.(log|debug|warn|error)/.test(line) &&
      !/test|spec|mock/i.test(filename)
    ) {
      issues.push({
        severity: "suggestion",
        category: "interaction",
        description: `Line ${lineNum}: Console statement in production code`,
        suggestion: "Remove or replace with logger",
      });
    }

    // === MOBILE DESIGN PATTERNS ===
    // Viewport blocking
    if (
      /user-scalable\s*=\s*["']?no/i.test(line) ||
      /maximum-scale\s*=\s*["']?1/i.test(line)
    ) {
      issues.push({
        severity: "critical",
        category: "mobile_design",
        description: `Line ${lineNum}: Pinch-to-zoom disabled — blocks accessibility zoom`,
        suggestion:
          "Remove user-scalable=no / maximum-scale=1; allow user zoom",
        heuristic: "No pinch-to-zoom blocking",
      });
    }

    // Missing viewport meta (detected at file level below)

    // Touch target too small
    if (
      /width:\s*(?:[12]\d|3[0-1])px/.test(line) &&
      /height:\s*(?:[12]\d|3[0-1])px/.test(line)
    ) {
      issues.push({
        severity: "major",
        category: "mobile_design",
        description: `Line ${lineNum}: Element sized under 44×44px — below minimum touch target`,
        suggestion:
          "Increase to at least 44×44px for touch accessibility (WCAG 2.5.8)",
        heuristic: "Touch targets ≥44×44px",
      });
    }

    // Safe area not used for fixed/sticky elements
    if (
      /(?:position:\s*(?:fixed|sticky)|fixed\s+bottom|sticky\s+top)/i.test(line)
    ) {
      const surrounding = lines.slice(Math.max(0, i - 3), i + 4).join(" ");
      if (
        !/safe-area-inset|env\(/.test(surrounding) &&
        !/pb-safe|pt-safe|pl-safe|pr-safe/.test(surrounding)
      ) {
        issues.push({
          severity: "major",
          category: "mobile_design",
          description: `Line ${lineNum}: Fixed/sticky element without safe-area-inset handling for notched devices`,
          suggestion:
            "Add padding with env(safe-area-inset-bottom) or use pb-safe Tailwind class",
          heuristic: "Safe area insets handled for notched devices",
        });
      }
    }

    // CTA placement — button at top of a tall container (not thumb-zone)
    if (/<button|<Button/.test(line)) {
      const surroundingLines = lines
        .slice(Math.max(0, i - 10), i + 1)
        .join("\n");
      if (
        surroundingLines.length > 300 &&
        !/sticky|fixed|bottom/.test(surroundingLines)
      ) {
        // Button far from bottom = not in thumb zone
        const remainingLines = lines
          .slice(i, Math.min(lines.length, i + 20))
          .join("\n");
        if (remainingLines.length > 200) {
          issues.push({
            severity: "minor",
            category: "mobile_design",
            description: `Line ${lineNum}: Primary button may not be in thumb-zone (bottom 40% of viewport)`,
            suggestion:
              "Move primary CTA to bottom of mobile viewport for one-hand reachability",
            heuristic: "Primary CTAs placed in thumb-zone",
          });
        }
      }
    }

    // === COLOR SYSTEM PATTERNS ===
    // Raw hex in component code (not in config/theme files)
    if (
      /(?:style|className)[^}]*#[0-9a-fA-F]{3,8}/.test(line) &&
      !/theme|config|tokens|tailwind/.test(filename)
    ) {
      issues.push({
        severity: "major",
        category: "color_system",
        description: `Line ${lineNum}: Raw hex color in component code — should use design token`,
        suggestion: "Replace with theme token, CSS variable, or Tailwind class",
        heuristic: "All colors map to design tokens",
      });
    }

    // Low contrast pattern — light text on light bg (heuristic)
    if (
      /text-(?:gray|slate|zinc)-(?:300|400|500)/.test(line) &&
      /bg-(?:white|gray|slate|zinc)-(?:50|100)/.test(line)
    ) {
      issues.push({
        severity: "minor",
        category: "color_system",
        description: `Line ${lineNum}: Potentially low contrast — light text on light background`,
        suggestion:
          "Verify contrast ratio ≥4.5:1 using browser devtools or axe",
        heuristic: "Sufficient contrast ratios",
      });
    }

    // === TYPOGRAPHY PATTERNS ===
    // Hardcoded font-size in px (not responsive)
    if (
      /font-size:\s*\d{2,3}px/.test(line) &&
      !/clamp|min|max|media|@supports/.test(
        code.slice(Math.max(0, lineNum - 100), lineNum + 100),
      )
    ) {
      issues.push({
        severity: "minor",
        category: "typography",
        description: `Line ${lineNum}: Hardcoded px font-size without fluid/responsive treatment`,
        suggestion: "Use clamp() for fluid typography or responsive type scale",
        heuristic: "Fluid typography with clamp() or responsive type scale",
      });
    }

    // font-display missing
    if (/@font-face/.test(line)) {
      const block = lines.slice(i, Math.min(lines.length, i + 10)).join("\n");
      if (!/font-display/.test(block)) {
        issues.push({
          severity: "major",
          category: "typography",
          description: `Line ${lineNum}: @font-face without font-display — causes FOIT (flash of invisible text)`,
          suggestion:
            "Add font-display: swap (or optional) to @font-face declaration",
          heuristic: "Font loading uses font-display: swap or optional",
        });
      }
    }
  }

  // File-level checks
  const fullCode = code;
  if (
    filename.endsWith(".html") ||
    filename.endsWith(".tsx") ||
    filename.endsWith(".jsx")
  ) {
    if (/<html/i.test(fullCode) && !/viewport/.test(fullCode)) {
      issues.push({
        severity: "critical",
        category: "mobile_design",
        description:
          "HTML file missing viewport meta tag — mobile layout will break",
        suggestion:
          "Add <meta name='viewport' content='width=device-width, initial-scale=1'>",
        heuristic:
          "Viewport meta tag includes width=device-width, initial-scale=1",
      });
    }
  }

  return issues;
}

async function getFilesToReview(
  appPath: string,
  target: string,
  path?: string,
): Promise<string[]> {
  const codeExtensions = new Set([
    ".tsx",
    ".jsx",
    ".vue",
    ".svelte",
    ".html",
    ".css",
    ".scss",
  ]);

  if (target === "file" && path) {
    const fullPath = await resolveReadPathWithinApp({
      appPath,
      relativePath: path,
    });
    await stat(fullPath);
    return [fullPath];
  }

  if (target === "directory" && path) {
    const dirPath = await resolveReadPathWithinApp({
      appPath,
      relativePath: path,
    });
    return collectFiles(dirPath, codeExtensions, 3);
  }

  // Auto-detect: scan src/ for component files
  try {
    const srcDir = await resolveReadPathWithinApp({
      appPath,
      relativePath: "src",
    });
    await stat(srcDir);
    return collectFiles(srcDir, codeExtensions, 2);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const rootDir = await resolveReadPathWithinApp({
      appPath,
      relativePath: ".",
    });
    return collectFiles(rootDir, codeExtensions, 1);
  }
}

async function collectFiles(
  dir: string,
  extensions: Set<string>,
  maxDepth: number,
  currentDepth = 0,
): Promise<string[]> {
  if (currentDepth > maxDepth) return [];
  const results: string[] = [];
  try {
    const entries = await readdir(dir);
    for (const entry of entries) {
      if (entry === "node_modules" || entry === ".git" || entry === "dist")
        continue;
      const fullPath = join(dir, entry);
      const s = await stat(fullPath);
      if (s.isDirectory()) {
        results.push(
          ...(await collectFiles(
            fullPath,
            extensions,
            maxDepth,
            currentDepth + 1,
          )),
        );
      } else if (extensions.has(extname(entry).toLowerCase())) {
        results.push(fullPath);
      }
    }
  } catch {
    // Permission error or similar
  }
  return results;
}

function scoreHeuristics(
  issues: ReviewIssue[],
): Record<string, { pass: number; fail: number; total: number }> {
  const scores: Record<string, { pass: number; fail: number; total: number }> =
    {};
  for (const [category, checks] of Object.entries(UI_UX_HEURISTICS)) {
    scores[category] = { pass: checks.length, fail: 0, total: checks.length };
  }
  for (const issue of issues) {
    if (scores[issue.category]) {
      scores[issue.category].fail += 1;
      scores[issue.category].pass = Math.max(
        0,
        scores[issue.category].pass - 1,
      );
    }
  }
  return scores;
}

/** Filter issues by the selected focus area. "all" returns everything. */
function filterByFocus(issues: ReviewIssue[], focus: string): ReviewIssue[] {
  if (focus === "all") return issues;
  // Map focus modes to the categories they cover
  const focusMap: Record<string, string[]> = {
    accessibility: ["accessibility"],
    responsive: ["responsive", "mobile_design"],
    visual_hierarchy: ["visual_hierarchy"],
    interaction: ["interaction"],
    consistency: ["consistency"],
    mobile_design: ["mobile_design"],
    color_system: ["color_system"],
    typography: ["typography"],
  };
  const categories = focusMap[focus] ?? [focus];
  return issues.filter((i) => categories.includes(i.category));
}

export const uiUxReviewerTool: ToolDefinition<z.infer<typeof INPUT_SCHEMA>> = {
  name: "ui_ux_reviewer",
  description:
    "Review UI/UX patterns against design heuristics: accessibility, responsive, visual hierarchy, interaction, consistency, mobile_design (viewport, safe-area, touch targets, thumb-zone CTAs), color_system (60/30/10, tokens, contrast), and typography (fluid type, font-display, line-height). Supports mobile_audit flag for mobile-specific checks.",
  inputSchema: INPUT_SCHEMA,
  defaultConsent: "always",

  isEnabled: () => true,

  getConsentPreview(input) {
    const mobileTag = input.mobile_audit ? " + mobile_audit" : "";
    return `🎨 UI/UX Review — ${input.focus}${mobileTag} on ${input.target}: ${input.path || "auto-detect"}`;
  },

  buildXml(input, _isComplete) {
    return `<ui_ux_reviewer target="${escapeXmlAttr(input.target)}" focus="${escapeXmlAttr(input.focus)}" path="${escapeXmlAttr(input.path || "auto")}" mobile_audit="${input.mobile_audit}" />`;
  },

  async execute(input, ctx): Promise<ToolResult> {
    ctx.abortSignal?.throwIfAborted();
    const files = await getFilesToReview(ctx.appPath, input.target, input.path);
    if (files.length === 0) {
      return "No matching files found to review. Specify a file or directory path.";
    }

    ctx.onXmlStream?.(
      `🎨 Reviewing ${files.length} file(s) for UI/UX issues...\n`,
    );

    let allIssues: ReviewIssue[] = [];
    const fileResults: { file: string; issues: ReviewIssue[] }[] = [];

    for (const filePath of files) {
      try {
        const code = await readFile(filePath, "utf-8");
        const issues = detectIssuesFromCode(code, filePath);
        if (issues.length > 0) {
          allIssues.push(...issues);
          fileResults.push({
            file: filePath.replace(ctx.appPath + "/", ""),
            issues,
          });
        }
      } catch {
        // Skip unreadable files
      }
    }

    // Optionally use LLM for deeper analysis
    if (allIssues.length > 0) {
      try {
        const runtime = await resolveAgentModelRuntime(ctx);
        const sample = fileResults.slice(0, 3);
        const analysisPrompt =
          `Review these UI/UX code snippets for design issues:\n\n` +
          sample
            .map(
              (r) =>
                `--- ${r.file} ---\n${r.issues.map((i) => i.description).join("\n")}`,
            )
            .join("\n\n") +
          `\n\nCategorize as: critical, major, minor, or suggestion. Return JSON array.`;

        const result = await generateText({
          model: runtime.model,
        headers: runtime.headers,
        providerOptions: runtime.providerOptions,
        temperature: runtime.temperature,
          prompt: analysisPrompt,
          maxOutputTokens: 1024,
        });

        try {
          const llmIssues = JSON.parse(result.text) as ReviewIssue[];
          if (Array.isArray(llmIssues)) {
            allIssues = [...allIssues, ...llmIssues];
          }
        } catch {
          // LLM output not valid JSON, keep heuristic-only results
        }
      } catch {
        // LLM unavailable, use heuristic-only
      }
    }

    // Filter by focus and optionally by mobile_audit
    let displayIssues = filterByFocus(allIssues, input.focus);
    if (!input.mobile_audit) {
      displayIssues = displayIssues.filter(
        (i) => i.category !== "mobile_design",
      );
    }

    const scores = scoreHeuristics(allIssues);
    const critical = displayIssues.filter((i) => i.severity === "critical");
    const major = displayIssues.filter((i) => i.severity === "major");
    const minor = displayIssues.filter((i) => i.severity === "minor");
    const suggestions = displayIssues.filter(
      (i) => i.severity === "suggestion",
    );

    const heuristicsReport = Object.entries(scores)
      .map(([cat, s]) => `${cat}: ${s.pass}/${s.total} passed`)
      .join(", ");

    ctx.onXmlComplete?.(
      `🎨 UI/UX Review Complete\n\n` +
        `📊 Heuristics: ${heuristicsReport}\n\n` +
        `🔴 Critical: ${critical.length} | 🟡 Major: ${major.length} | 🔵 Minor: ${minor.length} | ⚪ Suggestions: ${suggestions.length}\n\n` +
        displayIssues
          .slice(0, 25)
          .map(
            (i) =>
              `[${i.severity.toUpperCase()}] ${i.category}: ${i.description}\n  → ${i.suggestion}`,
          )
          .join("\n\n"),
    );

    return `UI/UX review complete: ${displayIssues.length} issues found across ${files.length} files (focus: ${input.focus}${input.mobile_audit ? " + mobile_audit" : ""}). Critical: ${critical.length}, Major: ${major.length}, Minor: ${minor.length}, Suggestions: ${suggestions.length}. Heuristics: ${heuristicsReport}.`;
  },
};
