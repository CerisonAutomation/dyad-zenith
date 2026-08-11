/**
 * llm_analysis_factory.ts — Factory for creating LLM-backed analysis tools.
 *
 * Eliminates ~4,000 lines of duplicated boilerplate across 15+ tools that all
 * follow the same pattern: resolve runtime → build prompt → generateText →
 * parse JSON → format markdown → onXmlComplete.
 *
 * Usage:
 *   export const myTool = createLlmAnalysisTool({
 *     name: "my_tool",
 *     description: "...",
 *     inputSchema: mySchema,
 *     buildPrompt: (args, ctx) => "...",
 *     formatResult: (args, llmOutput) => "...",
 *   });
 */

import { z } from "zod";
import log from "electron-log";
import { generateText } from "ai";
import { resolveAgentModelRuntime } from "../agent_model_runtime";
import {
  type ToolDefinition,
  type AgentContext,
  type ToolResult,
  escapeXmlAttr,
  escapeXmlContent,
} from "./types";

// ============================================================================
// Types
// ============================================================================

export interface LlmAnalysisConfig<T extends Record<string, unknown>> {
  /** Tool name (snake_case). */
  name: string;
  /** Tool description (shown to the model). */
  description: string;
  /** Zod schema for input validation. */
  inputSchema: z.ZodType<T>;
  /** Default consent level. */
  defaultConsent?: "always" | "ask";
  /**
   * Build the LLM prompt from parsed args and context.
   * This is where the tool-specific logic lives.
   */
  buildPrompt: (args: T, ctx: AgentContext) => Promise<string> | string;
  /**
   * Format the LLM output into the final tool result.
   * If not provided, the raw LLM text is returned.
   */
  formatResult?: (args: T, llmOutput: string) => string;
  /**
   * Parse structured data from the LLM output.
   * If provided, formatResult receives both raw text and parsed data.
   * Returns null if parsing fails (triggers fallback to raw text).
   */
  parseStructured?: (llmOutput: string) => unknown | null;
  /**
   * Format parsed structured data into markdown.
   * Only called when parseStructured succeeds.
   */
  formatStructured?: (args: T, data: unknown) => string;
  /** Thinking budget for model runtime (default: "high"). */
  thinkingBudget?: "low" | "medium" | "high";
  /** Maximum output tokens (default: 4096). */
  maxTokens?: number;
  /** XML tag name for streaming (default: tool name with hyphens). */
  xmlTag?: string;
  /**
   * Custom consent preview. If not provided, uses a generic preview.
   */
  consentPreview?: (args: T) => string;
  /**
   * Custom XML builder for streaming preview during arg accumulation.
   * If not provided, a generic one is used.
   */
  buildXml?: (args: Partial<T>, isComplete: boolean) => string | undefined;
  /**
   * Pre-execution hook. Called before the LLM call.
   * Use for file collection, diff gathering, etc.
   * Returns context to be passed to buildPrompt.
   */
  preExecute?: (
    args: T,
    ctx: AgentContext,
  ) => Promise<{ preamble?: string; files?: string } | undefined>;
  /**
   * Short-circuit check. Called after preExecute, before the LLM call.
   * Return a non-null string to skip the LLM entirely and return that string
   * as the tool result. Useful for early-exit cases like "no changes found".
   */
  shortCircuit?: (
    args: T,
    ctx: AgentContext,
    preResult?: { preamble?: string; files?: string },
  ) => Promise<string | null> | string | null;
  /**
   * Post-execution hook. Called after a successful LLM call and formatting.
   * Use for side effects like writing files or updating memory.
   */
  postExecute?: (
    args: T,
    ctx: AgentContext,
    llmOutput: string,
  ) => Promise<void> | void;
  /**
   * Error fallback. If the LLM call or formatting throws, this function is
   * called to produce a degraded result instead of propagating the error.
   * If not provided, errors propagate normally.
   */
  errorFallback?: (
    args: T,
    ctx: AgentContext,
    error: unknown,
  ) => Promise<string> | string;
}

// ============================================================================
// Factory
// ============================================================================

export function createLlmAnalysisTool<T extends Record<string, unknown>>(
  config: LlmAnalysisConfig<T>,
): ToolDefinition<T> {
  const logger = log.scope(config.name);
  const xmlTag = config.xmlTag || config.name.replace(/_/g, "-");
  const defaultConsent = config.defaultConsent ?? "always";

  function buildDefaultXml(
    args: Partial<T>,
    isComplete: boolean,
  ): string | undefined {
    const attrs: string[] = [];
    for (const [key, value] of Object.entries(args)) {
      if (typeof value === "string" && value) {
        attrs.push(`${key}="${escapeXmlAttr(value)}"`);
      }
    }
    const attrStr = attrs.join(" ");
    if (!isComplete) {
      return `<dyad-${xmlTag} ${attrStr} status="analyzing" />`;
    }
    return `<dyad-${xmlTag} ${attrStr} status="complete" />`;
  }

  return {
    name: config.name,
    description: config.description,
    inputSchema: config.inputSchema,
    defaultConsent,

    getConsentPreview: config.consentPreview,
    buildXml: config.buildXml || buildDefaultXml,

    execute: async (args: T, ctx: AgentContext): Promise<ToolResult> => {
      logger.log(`Executing ${config.name}`);

      ctx.abortSignal?.throwIfAborted();

      // Initial stream
      const defaultPreview = config.consentPreview?.(args) || config.name;
      ctx.onXmlStream(
        `<dyad-${xmlTag} status="starting">${escapeXmlContent(defaultPreview)}`,
      );

      // Pre-execution hook (file collection, diff gathering, etc.)
      let preamble = "";
      let preResult: { preamble?: string; files?: string } | undefined =
        undefined;
      if (config.preExecute) {
        const raw = await config.preExecute(args, ctx);
        if (raw) {
          preResult = raw;
          if (raw.preamble) {
            preamble = raw.preamble;
          }
        }
      }

      ctx.abortSignal?.throwIfAborted();

      // Short-circuit check (e.g. "no changes found" before LLM call)
      if (config.shortCircuit) {
        const scResult = await config.shortCircuit(args, ctx, preResult);
        if (scResult !== null) {
          ctx.onXmlComplete(
            `<dyad-${xmlTag} status="complete" format="short-circuit" />`,
          );
          return scResult;
        }
      }

      ctx.abortSignal?.throwIfAborted();

      // Stream progress
      ctx.onXmlStream(
        `<dyad-${xmlTag} status="analyzing">Reasoning...`,
      );

      try {
        // Resolve model runtime
        const runtime = await resolveAgentModelRuntime(ctx, {
          minThinkingBudget: config.thinkingBudget ?? "high",
        });

        // Build prompt
        let prompt = await config.buildPrompt(args, ctx);
        if (preamble) {
          prompt = `${preamble}\n\n${prompt}`;
        }

        ctx.abortSignal?.throwIfAborted();

        // Call LLM
        const result = await generateText({
          model: runtime.model,
          headers: runtime.headers,
          providerOptions: runtime.providerOptions,
          temperature: runtime.temperature,
          prompt,
          maxOutputTokens: config.maxTokens ?? 4096,
        });

        ctx.abortSignal?.throwIfAborted();

        const llmOutput = result.text;
        if (!llmOutput) {
          throw new Error(`${config.name} returned empty analysis`);
        }

        // Try structured parsing first
        if (config.parseStructured && config.formatStructured) {
          const parsed = config.parseStructured(llmOutput);
          if (parsed) {
            const formatted = config.formatStructured(args, parsed);
            if (config.postExecute) {
              await config.postExecute(args, ctx, llmOutput);
            }
            ctx.onXmlComplete(
              `<dyad-${xmlTag} status="complete" format="structured" />`,
            );
            return formatted;
          }
          // Parse failed — fall through to raw text formatting
        }

        // Format result
        const output = config.formatResult
          ? config.formatResult(args, llmOutput)
          : llmOutput;

        if (config.postExecute) {
          await config.postExecute(args, ctx, llmOutput);
        }

        ctx.onXmlComplete(
          `<dyad-${xmlTag} status="complete" format="raw" />`,
        );

        logger.log(`${config.name} completed`);
        return output;
      } catch (error) {
        if (config.errorFallback) {
          const fallback = await config.errorFallback(args, ctx, error);
          ctx.onXmlComplete(
            `<dyad-${xmlTag} status="complete" format="fallback" />`,
          );
          return fallback;
        }
        throw error;
      }
    },
  };
}

// ============================================================================
// Shared JSON Parsing Helpers
// ============================================================================

/**
 * Extract the first JSON object from LLM output text.
 * Returns null if no valid JSON is found.
 */
export function extractJson<T>(text: string): T | null {
  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      return JSON.parse(match[0]) as T;
    }
  } catch {
    // JSON parse failed
  }
  return null;
}

/**
 * Extract the first JSON array from LLM output text.
 * Returns null if no valid JSON array is found.
 */
export function extractJsonArray<T>(text: string): T[] | null {
  try {
    const match = text.match(/\[[\s\S]*\]/);
    if (match) {
      return JSON.parse(match[0]) as T[];
    }
  } catch {
    // JSON parse failed
  }
  return null;
}

/**
 * Build a severity-grouped markdown report from an array of issues.
 */
export function buildSeverityReport(
  issues: Array<{ severity: string; title: string; description?: string; location?: string; fix?: string }>,
  options: { title?: string; showFixes?: boolean } = {},
): string {
  const { title = "Issues", showFixes = true } = options;
  const lines: string[] = [];

  const critical = issues.filter((i) => i.severity === "critical");
  const high = issues.filter((i) => i.severity === "high" || i.severity === "major");
  const medium = issues.filter((i) => i.severity === "medium");
  const low = issues.filter((i) => i.severity === "low" || i.severity === "minor");

  lines.push(`# ${title}`);
  lines.push("");
  lines.push(
    `🔴 Critical: ${critical.length} | 🟠 High: ${high.length} | 🟡 Medium: ${medium.length} | 🔵 Low: ${low.length}`,
  );
  lines.push("");

  if (critical.length > 0) {
    lines.push(`## 🔴 Critical (${critical.length})`);
    for (const issue of critical) {
      lines.push(`- **${issue.title}**${issue.location ? ` at ${issue.location}` : ""}`);
      if (issue.description) lines.push(`  ${issue.description}`);
      if (showFixes && issue.fix) lines.push(`  → ${issue.fix}`);
    }
    lines.push("");
  }

  if (high.length > 0) {
    lines.push(`## 🟠 High (${high.length})`);
    for (const issue of high) {
      lines.push(`- **${issue.title}**${issue.location ? ` at ${issue.location}` : ""}`);
      if (issue.description) lines.push(`  ${issue.description}`);
      if (showFixes && issue.fix) lines.push(`  → ${issue.fix}`);
    }
    lines.push("");
  }

  if (medium.length > 0) {
    lines.push(`## 🟡 Medium (${medium.length})`);
    for (const issue of medium) {
      lines.push(`- **${issue.title}**${issue.location ? ` at ${issue.location}` : ""}`);
      if (issue.description) lines.push(`  ${issue.description}`);
    }
    lines.push("");
  }

  if (low.length > 0) {
    lines.push(`## 🔵 Low (${low.length})`);
    for (const issue of low) {
      lines.push(`- **${issue.title}**${issue.location ? ` at ${issue.location}` : ""}`);
    }
    lines.push("");
  }

  if (issues.length === 0) {
    lines.push("✅ No issues found.");
  }

  return lines.join("\n");
}
