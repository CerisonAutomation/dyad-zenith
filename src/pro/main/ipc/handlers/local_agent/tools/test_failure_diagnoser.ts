/**
 * test_failure_diagnoser.ts — AI-powered test failure analysis tool.
 *
 * Takes a test failure output and:
 * 1. Identifies the actual assertion that failed (not just the test name)
 * 2. Traces back to the code that produced the wrong result
 * 3. Distinguishes test bugs from application bugs
 * 4. Suggests concrete fixes for both
 */

import { z } from "zod";
import { createLlmAnalysisTool } from "./llm_analysis_factory";

const testFailureDiagnoserSchema = z.object({
  failure_output: z
    .string()
    .describe(
      "The test failure output: assertion errors, stack traces, expected vs actual values.",
    ),
  test_file: z
    .string()
    .optional()
    .describe(
      "Path to the test file that failed (helps locate the test code).",
    ),
  source_file: z
    .string()
    .optional()
    .describe(
      "Path to the source file being tested (helps trace the bug)."),
  recent_changes: z
    .string()
    .optional()
    .describe(
      "Recent code changes that might have caused the failure (git diff, file edits).",
    ),
});

export const testFailureDiagnoserTool = createLlmAnalysisTool({
  name: "test_failure_diagnoser",
  description:
    "Diagnose test failures with AI. Identifies the actual failed assertion, traces to the root cause, distinguishes test bugs from application bugs, and suggests concrete fixes. Use when a test fails and you need to understand why.",
  inputSchema: testFailureDiagnoserSchema,
  defaultConsent: "always",

  consentPreview: (args) => {
    const lines = args.failure_output.split("\n").length;
    return `🧪 Test Failure Diagnosis: ${lines} lines of output`;
  },

  buildXml: (args, isComplete) => {
    if (!args.failure_output) return undefined;
    if (!isComplete) {
      return `<dyad-test-failure-diagnoser status="diagnosing">
${args.failure_output.slice(0, 200)}${args.failure_output.length > 200 ? "..." : ""}
</dyad-test-failure-diagnoser>`;
    }
    return undefined;
  },

  preExecute: async (args, ctx) => {
    const parts: string[] = [
      `Diagnosing test failure`,
      args.test_file ? `Test file: ${args.test_file}` : "",
      args.source_file ? `Source file: ${args.source_file}` : "",
      args.recent_changes ? "Recent changes provided" : "",
    ].filter(Boolean);
    return { preamble: parts.join(" | ") };
  },

  buildPrompt: async (args, ctx) => {
    const testFileSection = args.test_file
      ? `\n\nTEST FILE: ${args.test_file}`
      : "";
    const sourceFileSection = args.source_file
      ? `\n\nSOURCE FILE: ${args.source_file}`
      : "";
    const changesSection = args.recent_changes
      ? `\n\nRECENT CHANGES:\n${args.recent_changes}`
      : "";

    return `You are an expert test failure debugger. Analyze this test failure and determine the root cause.

TEST FAILURE OUTPUT:
${args.failure_output}
${testFileSection}
${sourceFileSection}
${changesSection}

Provide a structured diagnosis:

## Failure Summary
One sentence: what failed and why (your best hypothesis).

## Failed Assertion
Identify the EXACT assertion that failed:
- What was expected vs what was actually received?
- Is the expected value correct? Or is the test wrong?

## Root Cause
Trace back from the failure to the actual cause:
- **Application Bug**: The code under test is wrong → fix the code
- **Test Bug**: The test's expectation is wrong → fix the test
- **Environment Issue**: Missing setup, wrong config, flaky test
- **Race Condition**: Timing-dependent failure

## Evidence
Point to specific evidence in the failure output:
- The exact assertion error message
- The expected vs actual values
- Any relevant stack trace frames
- Any setup/teardown issues

## Fix
Provide the concrete fix:
- If APPLICATION BUG: Show the code change needed in the source file
- If TEST BUG: Show the corrected test assertion
- If ENVIRONMENT: Show the config/setup change needed
- If RACE CONDITION: Show how to make the test deterministic

## Prevention
How to prevent this class of failure:
- Add/update tests
- Improve error messages
- Add type safety
- Fix underlying design issue

Rules:
- Look at the ACTUAL vs EXPECTED values carefully — often the fix is obvious from the diff
- If the test uses mocks, check if the mock behavior matches reality
- If the test is async, check for missing awaits or race conditions
- If the test passed before, look at recent changes as the likely cause
- Don't just explain what failed — explain WHY it failed at the code level`;
  },

  thinkingBudget: "high",
  maxTokens: 3000,
});
