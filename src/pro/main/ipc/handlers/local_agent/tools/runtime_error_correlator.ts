/**
 * runtime_error_correlator.ts — Correlates errors across client/server/network.
 *
 * Given multiple error sources (client logs, server logs, network requests),
 * this tool:
 * 1. Finds temporal correlations between errors
 * 2. Identifies error cascades (one error causing others)
 * 3. Distinguishes root cause from symptoms
 * 4. Maps the full error chain
 */

import { z } from "zod";
import { createLlmAnalysisTool } from "./llm_analysis_factory";

const runtimeErrorCorrelatorSchema = z.object({
  client_errors: z
    .string()
    .optional()
    .describe("Client-side errors or console logs."),
  server_errors: z
    .string()
    .optional()
    .describe("Server-side errors or logs."),
  network_requests: z
    .string()
    .optional()
    .describe("Network request/response logs or HAR data."),
  question: z
    .string()
    .optional()
    .describe(
      "What you're trying to understand (e.g., 'why does the user see a blank screen?', 'what's causing the 500 errors?').",
    ),
});

export const runtimeErrorCorrelatorTool = createLlmAnalysisTool({
  name: "runtime_error_correlator",
  description:
    "Correlate errors across client, server, and network layers to find the root cause. Distinguishes root cause from symptoms, maps error cascades, and identifies which error started the chain. Use when you have errors from multiple sources and need to understand the full picture.",
  inputSchema: runtimeErrorCorrelatorSchema,
  defaultConsent: "always",

  consentPreview: (args) => {
    const sources = [
      args.client_errors ? "client" : null,
      args.server_errors ? "server" : null,
      args.network_requests ? "network" : null,
    ]
      .filter(Boolean)
      .join(", ");
    return `🔗 Error Correlation: ${sources} sources${args.question ? ` — "${args.question.slice(0, 60)}"` : ""}`;
  },

  buildXml: (args, isComplete) => {
    const sources = [
      args.client_errors ? "client" : null,
      args.server_errors ? "server" : null,
      args.network_requests ? "network" : null,
    ]
      .filter(Boolean)
      .join("+");
    if (!isComplete) {
      return `<dyad-error-correlator sources="${sources}" status="correlating">
${args.question || "Correlating errors across layers..."}
</dyad-error-correlator>`;
    }
    return undefined;
  },

  buildPrompt: async (args, ctx) => {
    const sections: string[] = [];

    if (args.client_errors) {
      sections.push(`## CLIENT ERRORS:\n${args.client_errors}`);
    }
    if (args.server_errors) {
      sections.push(`## SERVER ERRORS:\n${args.server_errors}`);
    }
    if (args.network_requests) {
      sections.push(`## NETWORK REQUESTS:\n${args.network_requests}`);
    }

    const questionSection = args.question
      ? `\n\nQUESTION: ${args.question}`
      : "";

    return `You are an expert full-stack debugger correlating errors across multiple application layers.

${sections.join("\n\n")}
${questionSection}

Perform cross-layer error correlation:

## Error Timeline
Merge all errors from all sources into a single chronological timeline:
- Timestamp (if available)
- Source (client/server/network)
- Error message
- Severity

## Error Chains
Identify causal chains — which errors caused which:
- **Root Cause**: The FIRST error that started the chain
- **Cascade**: Errors that are symptoms of the root cause
- **Independent**: Errors unrelated to the main chain

## Cross-Layer Correlations
Find connections between layers:
- Client error X happened right after server error Y
- Network timeout Z caused client error X
- Server error Y was triggered by malformed request from client

## Root Cause Analysis
The root cause is the error that, if fixed, would prevent the most downstream symptoms:
- Which error is the actual root cause?
- Why did it happen?
- What would fix it?

## Fix Priority
Ordered by impact (fixing the root cause first eliminates the most symptoms):
1. Fix root cause → eliminates cascade
2. Fix secondary issues → prevents independent failures
3. Add defensive checks → prevents similar cascades in future

Rules:
- Don't just list errors — find the CONNECTIONS between them
- Temporal proximity is a strong signal but not proof of causation
- Network errors are often symptoms, not root causes
- Client errors are often the last symptom in a cascade
- If timestamps don't align, look for patterns instead of exact sequences`;
  },

  thinkingBudget: "high",
  maxTokens: 4096,
});
