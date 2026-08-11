/**
 * Dev Server Compilation Error Parser
 *
 * Pure-function module that recognizes compilation error patterns from
 * framework-specific dev server output (Next.js, Vite, Webpack, TypeScript).
 * No LLM calls, no side effects — fast regex matching only.
 */

// ============================================================================
// Types
// ============================================================================

export interface CompilationError {
  /** Human-readable error summary (first meaningful line). */
  summary: string;
  /** Full error output (bounded to MAX_RAW_OUTPUT chars). */
  rawOutput: string;
  /** Detected framework that produced the error. */
  framework: "nextjs" | "vite" | "webpack" | "typescript" | "generic";
  /** Whether this error is likely fixable by the agent. */
  fixable: boolean;
}

// ============================================================================
// Constants
// ============================================================================

const MAX_RAW_OUTPUT = 8000;
const MAX_BUFFER = 16000;

// ============================================================================
// Framework-specific error patterns
// ============================================================================

interface ErrorPattern {
  regex: RegExp;
  framework: CompilationError["framework"];
  /** Higher weight = more confidence this is a real compilation error. */
  weight: number;
  /** Whether the error message itself contains enough info to fix. */
  fixable: boolean;
}

const ERROR_PATTERNS: ErrorPattern[] = [
  // ── Next.js ──────────────────────────────────────────────────────────
  {
    regex: /Module not found:.*Can't resolve\s+['"]([^'"]+)['"]/i,
    framework: "nextjs",
    weight: 10,
    fixable: true,
  },
  {
    regex: /Failed to compile/i,
    framework: "nextjs",
    weight: 8,
    fixable: true,
  },
  {
    regex: /Type error:\s*.+/i,
    framework: "nextjs",
    weight: 9,
    fixable: true,
  },
  {
    regex: /Error occurred prerendering page/i,
    framework: "nextjs",
    weight: 7,
    fixable: true,
  },
  {
    regex: /Build optimization failed/i,
    framework: "nextjs",
    weight: 8,
    fixable: true,
  },
  {
    regex: /Unhandled Runtime Error/i,
    framework: "nextjs",
    weight: 6,
    fixable: true,
  },

  // ── Vite / esbuild ───────────────────────────────────────────────────
  {
    regex: /Pre-transform error/i,
    framework: "vite",
    weight: 9,
    fixable: true,
  },
  {
    regex: /Internal server error/i,
    framework: "vite",
    weight: 5,
    fixable: false,
  },
  {
    regex: /error\s+[\w/.]+\.tsx?\(\d+:\d+\)/i,
    framework: "vite",
    weight: 8,
    fixable: true,
  },
  {
    regex: /SyntaxError:\s*.+\n.*at\s+.+\.ts/i,
    framework: "vite",
    weight: 7,
    fixable: true,
  },

  // ── TypeScript ───────────────────────────────────────────────────────
  {
    regex: /error TS\d{4}:\s*.+/,
    framework: "typescript",
    weight: 9,
    fixable: true,
  },
  {
    regex: /TS\d{4}:\s*.+/,
    framework: "typescript",
    weight: 8,
    fixable: true,
  },

  // ── Webpack ──────────────────────────────────────────────────────────
  {
    regex: /Module build failed/i,
    framework: "webpack",
    weight: 8,
    fixable: true,
  },
  {
    regex: /You may need an appropriate loader/i,
    framework: "webpack",
    weight: 7,
    fixable: true,
  },

  // ── Generic Node.js / Runtime ────────────────────────────────────────
  {
    regex: /Cannot find module\s+['"]([^'"]+)['"]/i,
    framework: "generic",
    weight: 9,
    fixable: true,
  },
  {
    regex: /SyntaxError:\s*(.+?)(?:\n|$)/i,
    framework: "generic",
    weight: 7,
    fixable: true,
  },
  {
    regex: /ENOENT:\s*no such file or directory,\s*(?:open|read)\s+'([^']+)'/i,
    framework: "generic",
    weight: 8,
    fixable: true,
  },
];

// Anti-patterns: lines that contain "error" but are NOT compilation errors
const ANTI_PATTERNS: RegExp[] = [
  /deprecated/i,
  /DeprecationWarning/i,
  /ESLint/i,
  /warning/i,
  /ERR_PNPM_IGNORED_BUILDS/i,
  /error handling middleware/i,
  /error.*handler/i,
  /no error/i,
  /error.*recovery/i,
];

// ============================================================================
// Core parser
// ============================================================================

/**
 * Check if a single line matches any compilation error pattern.
 * Used for real-time streaming detection.
 */
export function isCompilationErrorLine(line: string): boolean {
  // Skip anti-patterns
  if (ANTI_PATTERNS.some((p) => p.test(line))) return false;
  return ERROR_PATTERNS.some((p) => p.regex.test(line));
}

/**
 * Extract a human-readable summary from a matched error line.
 */
function extractSummary(line: string): string {
  // Take the first non-empty, non-whitespace-only segment
  const trimmed = line.trim();
  // Truncate at 200 chars for readability
  return trimmed.length > 200 ? trimmed.slice(0, 200) + "…" : trimmed;
}

/**
 * Analyze accumulated stdout/stderr output and detect compilation errors.
 * Returns null if no compilation error is found.
 *
 * The function scans the LAST portion of the buffer (up to MAX_BUFFER chars)
 * to catch errors that appear near the end of dev server output.
 */
export function parseCompilationError(
  stdout: string,
  stderr: string,
): CompilationError | null {
  const combined = [stdout, stderr].filter(Boolean).join("\n");
  if (!combined.trim()) return null;

  // Take the last MAX_BUFFER chars to focus on recent output
  const buffer =
    combined.length > MAX_BUFFER
      ? combined.slice(combined.length - MAX_BUFFER)
      : combined;

  const lines = buffer.split("\n");

  let bestMatch: { pattern: ErrorPattern; line: string; weight: number } | null =
    null;

  for (const line of lines) {
    if (!line.trim()) continue;

    // Skip anti-patterns
    if (ANTI_PATTERNS.some((p) => p.test(line))) continue;

    for (const pattern of ERROR_PATTERNS) {
      if (pattern.regex.test(line)) {
        if (!bestMatch || pattern.weight > bestMatch.weight) {
          bestMatch = { pattern, line, weight: pattern.weight };
        }
      }
    }
  }

  if (!bestMatch) return null;

  // Extract context: the matched line plus up to 20 lines before and after
  const matchedIdx = lines.findIndex((l) => l === bestMatch!.line);
  const contextStart = Math.max(0, matchedIdx - 10);
  const contextEnd = Math.min(lines.length, matchedIdx + 11);
  const context = lines.slice(contextStart, contextEnd).join("\n");

  return {
    summary: extractSummary(bestMatch.line),
    rawOutput:
      context.length > MAX_RAW_OUTPUT
        ? context.slice(0, MAX_RAW_OUTPUT) + "\n… (truncated)"
        : context,
    framework: bestMatch.pattern.framework,
    fixable: bestMatch.pattern.fixable,
  };
}
