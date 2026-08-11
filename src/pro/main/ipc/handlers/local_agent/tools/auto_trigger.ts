/**
 * auto_trigger.ts — Auto-execution triggers for proactive analysis.
 *
 * Provides lightweight hooks that fire after specific tool invocations
 * to automatically run complementary checks. These are suggestions that
 * the local agent handler can use to enhance the agent loop.
 *
 * Design principles:
 * - Only trigger lightweight checks (no LLM calls in auto-trigger)
 * - Respect abort signals
 * - Never block the main tool execution
 * - Fire-and-forget: log results, don't fail the parent tool
 */

import log from "electron-log";
import type { AgentContext } from "./types";
import { parseCompilationError } from "@/ipc/utils/dev_server_error_parser";
import { getLogs } from "@/lib/log_store";

const logger = log.scope("auto_trigger");

// ============================================================================
// Types
// ============================================================================

export interface AutoTriggerResult {
  /** Whether a trigger fired. */
  triggered: boolean;
  /** Human-readable summary of what was checked. */
  summary?: string;
  /** Issues found that should be surfaced to the user. */
  warnings?: string[];
}

export interface FileWriteEvent {
  filePath: string;
  content: string;
  toolName: "write_file" | "search_replace";
}

// ============================================================================
// File Write Triggers
// ============================================================================

/**
 * Analyze a file write event and return auto-trigger recommendations.
 * This does NOT execute the checks — it returns what SHOULD be triggered
 * so the handler can decide whether to run them.
 */
export function analyzeFileWrite(event: FileWriteEvent): AutoTriggerResult {
  const { filePath, content, toolName } = event;
  const warnings: string[] = [];

  // TypeScript/React file writes → suggest type check
  if (/\.(ts|tsx)$/.test(filePath) && !/\.(test|spec)\./.test(filePath)) {
    // Check for obvious type issues in the written content
    if (/\bany\b/.test(content) && !/eslint-disable/.test(content)) {
      warnings.push(`${filePath}: Contains 'any' type — consider type check`);
    }
    if (/@ts-ignore|@ts-nocheck/.test(content)) {
      warnings.push(`${filePath}: Contains @ts-ignore/@tsnocheck — type safety weakened`);
    }
    if (/catch\s*\(\s*\w*\s*\)\s*\{\s*\}/.test(content)) {
      warnings.push(`${filePath}: Empty catch block — error silently swallowed`);
    }
  }

  // Security-sensitive patterns
  if (/eval\s*\(/.test(content)) {
    warnings.push(`${filePath}: eval() usage — security risk`);
  }
  if (/innerHTML\s*=/.test(content) && !/sanitiz/.test(content)) {
    warnings.push(`${filePath}: innerHTML without sanitization — XSS risk`);
  }

  // Import/export patterns that suggest needed checks
  if (/import.*from\s+["']react["']/.test(content)) {
    warnings.push(`${filePath}: React component — verify render behavior`);
  }

  return {
    triggered: warnings.length > 0,
    summary: warnings.length > 0
      ? `${warnings.length} warning(s) from ${toolName} on ${filePath}`
      : undefined,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

/**
 * Determine if a batch of file writes warrants a type check.
 * Returns true if 3+ TypeScript files were written in a single turn.
 */
export function shouldAutoTypeCheck(fileEdits: Map<string, { write_file: number; search_replace: number }>): boolean {
  let tsFileCount = 0;
  for (const [filePath, counts] of fileEdits) {
    if (/\.(ts|tsx)$/.test(filePath) && !/\.(test|spec)\./.test(filePath)) {
      tsFileCount += counts.write_file + counts.search_replace;
    }
  }
  return tsFileCount >= 3;
}

/**
 * Determine if a batch of file writes warrants a vibe audit quick scan.
 * Returns true if 5+ files were written in a single turn.
 */
export function shouldAutoVibeScan(fileEdits: Map<string, { write_file: number; search_replace: number }>): boolean {
  let totalWrites = 0;
  for (const [, counts] of fileEdits) {
    totalWrites += counts.write_file + counts.search_replace;
  }
  return totalWrites >= 5;
}

/**
 * Build a proactive message to append after a tool execution.
 * This is a lightweight, non-LLM analysis that can fire immediately.
 */
export function buildProactiveMessage(
  event: FileWriteEvent,
  ctx: AgentContext,
): string | null {
  const result = analyzeFileWrite(event);
  if (!result.triggered || !result.warnings?.length) return null;

  // Only surface the first 3 warnings to avoid noise
  const topWarnings = result.warnings.slice(0, 3);
  return [
    `⚡ Auto-detected potential issues after ${event.toolName}:`,
    ...topWarnings.map((w) => `  • ${w}`),
    topWarnings.length < (result.warnings?.length ?? 0)
      ? `  • ...and ${(result.warnings?.length ?? 0) - topWarnings.length} more`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

// ============================================================================
// Batch Analysis Triggers
// ============================================================================

/**
 * Collect all file edit events for a turn and return batch analysis recommendations.
 */
export function collectTurnTriggers(
  fileEditTracker: Map<string, { write_file: number; search_replace: number }>,
): {
  typeCheck: boolean;
  vibeScan: boolean;
  summary: string[];
} {
  const typeCheck = shouldAutoTypeCheck(fileEditTracker);
  const vibeScan = shouldAutoVibeScan(fileEditTracker);
  const summary: string[] = [];

  let totalWrites = 0;
  let tsWrites = 0;
  for (const [filePath, counts] of fileEditTracker) {
    const total = counts.write_file + counts.search_replace;
    totalWrites += total;
    if (/\.(ts|tsx)$/.test(filePath)) tsWrites += total;
  }

  if (typeCheck) {
    summary.push(`${tsWrites} TypeScript files modified — type check recommended`);
  }
  if (vibeScan) {
    summary.push(`${totalWrites} files modified — quick scan recommended`);
  }

  return { typeCheck, vibeScan, summary };
}

/**
 * Log auto-trigger decisions for debugging.
 */
export function logAutoTrigger(
  toolName: string,
  triggers: ReturnType<typeof collectTurnTriggers>,
): void {
  if (triggers.summary.length > 0) {
    logger.info(`Auto-triggers after ${toolName}:`, triggers.summary);
  }
}

// ============================================================================
// Preview Compilation Error Detection
// ============================================================================

/**
 * Check if the agent should be informed about preview compilation errors.
 * Scans recent error-level logs for compilation error patterns.
 * Returns the compilation error summary if one was detected, null otherwise.
 */
export function detectPreviewCompilationError(
  appId: number,
): { summary: string; rawOutput: string; framework: string; fixable: boolean } | null {
  try {
    // Static import is deliberate: log_store is dependency-light and has no
    // dependency on the local-agent tool layer. Keeping this statically
    // resolvable lets Vite prove the packaged dependency graph instead of
    // leaving an alias-based CommonJS require for runtime resolution.
    const logs = getLogs(appId);
    const cutoff = Date.now() - 2 * 60 * 1000; // last 2 minutes

    const recentErrors = logs
      .filter(
        (l: { level: string; timestamp: number; message: string }) =>
          l.level === "error" && l.timestamp >= cutoff,
      )
      .map((l: { message: string }) => l.message)
      .join("\n");

    if (!recentErrors) return null;

    const parsed = parseCompilationError(recentErrors, "");
    return parsed;
  } catch (error) {
    logger.warn("Failed to detect preview compilation error:", error);
    return null;
  }
}

/**
 * Build a proactive message when a preview compilation error is detected.
 * This is called at the end of a turn to inform the agent.
 */
export function buildPreviewErrorMessage(
  error: { summary: string; framework: string; fixable: boolean },
): string {
  return [
    `🔍 Preview compilation error detected (${error.framework}):`,
    `  ${error.summary}`,
    error.fixable
      ? `  Use the preview_error_fixer tool to diagnose and fix this automatically.`
      : `  This error may require manual investigation.`,
  ].join("\n");
}
