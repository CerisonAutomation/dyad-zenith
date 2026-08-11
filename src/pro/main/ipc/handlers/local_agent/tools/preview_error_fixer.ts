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
import { searchReplaceTool } from "./search_replace";
import { appLifecycleTool } from "./app_lifecycle";

const logger = log.scope("preview_error_fixer");

// ============================================================================
// Schema
// ============================================================================

const previewErrorFixerSchema = z.object({
  error_output: z
    .string()
    .describe(
      "The compilation error output from the dev server (from logs or the compilation-error event).",
    ),
  max_cycles: z
    .number()
    .min(1)
    .max(5)
    .optional()
    .describe("Maximum fix-verify cycles. Default: 3."),
});

// ============================================================================
// Tool Definition
// ============================================================================

export const previewErrorFixerTool: ToolDefinition<
  z.infer<typeof previewErrorFixerSchema>
> = {
  name: "preview_error_fixer",
  description:
    "Diagnose and fix a preview compilation error. Analyzes the dev server error output, generates fixes, applies them, restarts the preview, and verifies it works. Use when the preview shows a compilation error or the dev server failed to start due to a code error.",
  inputSchema: previewErrorFixerSchema,
  defaultConsent: "ask",
  modifiesState: true,

  getConsentPreview: (args) => {
    return [
      `<dyad-preview-fix-preview error_length="${args.error_output.length}" max_cycles="${args.max_cycles || 3}"/>`,
    ].join("\n");
  },

  buildXml: (args) => {
    return [
      `<dyad-preview-error-fixer max_cycles="${args.max_cycles || 3}">`,
      `<error_output>${escapeXmlContent((args.error_output ?? "").slice(0, 4000))}</error_output>`,
      `</dyad-preview-error-fixer>`,
    ].join("\n");
  },

  execute: async (args, ctx: AgentContext) => {
    ctx.abortSignal?.throwIfAborted();
    const maxCycles = args.max_cycles || 3;
    const targetAppPath = ctx.appPath || process.cwd();

    logger.log(
      `Executing preview_error_fixer: error_length=${args.error_output.length}, max_cycles=${maxCycles}`,
    );

    ctx.abortSignal?.throwIfAborted();

    const runtime = await resolveAgentModelRuntime(ctx);

    const cycleLog: Array<{
      cycle: number;
      status: "pass" | "fail" | "error";
      diagnosis: string;
      fix: string;
    }> = [];

    let consecutiveFailures = 0;
    let lastError = "";

    for (let cycle = 1; cycle <= maxCycles; cycle++) {
      ctx.abortSignal?.throwIfAborted();

      const errorOutput =
        cycle === 1
          ? args.error_output
          : cycleLog[cycleLog.length - 1]?.diagnosis || args.error_output;

      ctx.onXmlStream(
        `<dyad-preview-fix phase="diagnose" cycle="${cycle}" max="${maxCycles}"/>`,
      );

      // ── Step 1: Diagnose the error ──
      const diagnosePrompt = `You are a code diagnostician specializing in dev server compilation errors. Analyze this error and identify the root cause.

FRAMEWORK HINTS:
- "Module not found: Can't resolve '@/lib/personas'" → missing file, need to create it or fix the import
- "Type error:" → TypeScript type mismatch, need to fix the type
- "SyntaxError:" → invalid syntax, need to fix the code
- "Cannot find module" → missing dependency or file

ERROR OUTPUT:
${errorOutput.slice(0, 6000)}

Provide a JSON response:
{"root_cause": "what exactly is wrong", "affected_files": ["file1.ts", "file2.ts"], "error_type": "missing_module|type_error|syntax_error|build_error|other", "fix_strategy": "create_missing_file|fix_import|fix_type|fix_syntax|install_dependency", "confidence": "high|medium|low"}`;

      const diagResult = await generateText({
        model: runtime.model,
        headers: runtime.headers,
        providerOptions: runtime.providerOptions,
        temperature: runtime.temperature,
        prompt: diagnosePrompt,
        maxOutputTokens: 1024,
      });

      let diagnosis = diagResult.text;
      let rootCause = "";
      let affectedFiles: string[] = [];
      let fixStrategy = "";

      try {
        const jsonMatch = diagResult.text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const diagData = JSON.parse(jsonMatch[0]);
          rootCause = diagData.root_cause || "";
          affectedFiles = diagData.affected_files || [];
          fixStrategy = diagData.fix_strategy || "";
          diagnosis = `**Root cause:** ${rootCause}\n**Affected files:** ${affectedFiles.join(", ")}\n**Strategy:** ${fixStrategy}\n**Confidence:** ${diagData.confidence || "medium"}`;
        }
      } catch {
        // Use raw text
      }

      // ── Step 2: Check for repeated identical failures ──
      if (rootCause === lastError) {
        consecutiveFailures++;
        if (consecutiveFailures >= 3) {
          logger.error(
            `Preview fixer: 3 identical diagnoses in a row, stopping.`,
          );
          cycleLog.push({
            cycle,
            status: "error",
            diagnosis:
              "Repeated identical failure — environment issue or unfixable.",
            fix: "",
          });
          break;
        }
      } else {
        consecutiveFailures = 0;
      }
      lastError = rootCause;

      // ── Step 3: Generate and apply fixes ──
      ctx.onXmlStream(
        `<dyad-preview-fix phase="fix" cycle="${cycle}" files="${affectedFiles.length}" strategy="${escapeXmlAttr(fixStrategy)}"/>`,
      );

      const fixPrompt = `You are a code fixer. Generate the EXACT file edits needed to fix this compilation error.

ROOT CAUSE: ${rootCause}
STRATEGY: ${fixStrategy}
AFFECTED FILES: ${affectedFiles.join(", ")}
ERROR:
${errorOutput.slice(0, 4000)}

For each affected file, provide the exact edit:
{"file": "path/to/file.ts", "old_code": "exact current code", "new_code": "replacement code"}

If the fix is to CREATE a missing file, use:
{"file": "path/to/file.ts", "old_code": "", "new_code": "full file content"}

If the fix is to INSTALL a dependency, use:
{"file": "package.json", "old_code": "...current dependencies section...", "new_code": "...dependencies section with new dep..."}

Return a JSON array of edits:
[{"file": "...", "old_code": "...", "new_code": "..."}]

IMPORTANT: old_code must match the file EXACTLY (whitespace, indentation). Be precise.`;

      const fixResult = await generateText({
        model: runtime.model,
        headers: runtime.headers,
        providerOptions: runtime.providerOptions,
        temperature: runtime.temperature,
        prompt: fixPrompt,
        maxOutputTokens: 4096,
      });

      let fixDescription = fixResult.text;

      // Parse and apply edits
      try {
        const jsonMatch = fixResult.text.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          const edits = JSON.parse(jsonMatch[0]) as Array<{
            file?: string;
            old_code?: string;
            new_code?: string;
          }>;
          const applied: string[] = [];
          const rejected: string[] = [];

          for (const edit of edits.slice(0, 12)) {
            if (!edit.file || edit.new_code === undefined) {
              rejected.push(edit.file || "(unknown file)");
              continue;
            }
            try {
              // For new files (empty old_code), use write_file-like behavior
              if (edit.old_code === "") {
                // Write the new file via search_replace with empty old_string
                // This creates the file if it doesn't exist
                const fs = await import("node:fs/promises");
                const path = await import("node:path");
                const filePath = path.resolve(targetAppPath, edit.file);
                await fs.mkdir(path.dirname(filePath), { recursive: true });
                await fs.writeFile(filePath, edit.new_code!, "utf-8");
                applied.push(edit.file);
              } else {
                await searchReplaceTool.execute(
                  {
                    file_path: edit.file,
                    old_string: edit.old_code!,
                    new_string: edit.new_code!,
                  },
                  ctx,
                );
                applied.push(edit.file);
              }
            } catch (error) {
              logger.warn(
                `Preview fixer could not apply edit to ${edit.file}:`,
                error,
              );
              rejected.push(edit.file);
            }
          }

          if (applied.length > 0) {
            ctx.workspaceMutated = true;
            ctx.mutationCount = (ctx.mutationCount ?? 0) + applied.length;
          }

          fixDescription = [
            applied.length ? `Applied: ${applied.join(", ")}` : "No edits applied.",
            rejected.length ? `Rejected/unmatched: ${rejected.join(", ")}` : "",
          ]
            .filter(Boolean)
            .join("\n");
        }
      } catch (error) {
        logger.warn("Preview fixer returned non-parseable edits:", error);
      }

      cycleLog.push({
        cycle,
        status: "fail",
        diagnosis,
        fix: fixDescription,
      });

      // ── Step 4: Restart the preview ──
      ctx.onXmlStream(
        `<dyad-preview-fix phase="restart" cycle="${cycle}"/>`,
      );

      try {
        await appLifecycleTool.execute({ action: "restart" }, ctx);
        // Wait for the dev server to restart
        await new Promise((resolve) => setTimeout(resolve, 5000));
      } catch (error) {
        logger.warn(`Preview fixer: restart failed on cycle ${cycle}:`, error);
      }

      // ── Step 5: Check if the error persists ──
      ctx.onXmlStream(
        `<dyad-preview-fix phase="verify" cycle="${cycle}"/>`,
      );

      // Read recent logs to check if the error is gone
      try {
        const { getLogs } = await import(
          "@/lib/log_store"
        );
        const logs = getLogs(ctx.appId);
        const recentErrors = logs
          .filter(
            (l) =>
              l.level === "error" &&
              l.timestamp > Date.now() - 10_000 &&
              l.type === "server",
          )
          .map((l) => l.message)
          .join("\n");

        // Check if the same error pattern still exists
        const errorStillPresent =
          recentErrors &&
          rootCause &&
          recentErrors.toLowerCase().includes(rootCause.toLowerCase().slice(0, 50));

        if (!errorStillPresent && recentErrors === "") {
          // No recent errors — likely fixed!
          cycleLog[cycleLog.length - 1].status = "pass";

          ctx.onXmlStream(
            `<dyad-preview-fix phase="result" cycle="${cycle}" status="pass"/>`,
          );

          const output = [
            `# Preview Error Fix — PASSED ✅`,
            ``,
            `**Cycles:** ${cycle}`,
            `**Error:** ${args.error_output.slice(0, 200)}`,
            ``,
            `## Cycle Log`,
          ];

          for (const entry of cycleLog) {
            if (entry.status === "pass") {
              output.push(`- Cycle ${entry.cycle}: ✅ FIXED`);
            } else {
              output.push(`- Cycle ${entry.cycle}: 🔧 Applied fix`);
            }
          }

          output.push("");
          ctx.onXmlComplete(
            `<dyad-preview-fix status="complete" result="pass" cycles="${cycle}"/>`,
          );

          return output.join("\n");
        }
      } catch (error) {
        logger.warn(`Preview fixer: verification failed on cycle ${cycle}:`, error);
      }
    }

    // Build failure output
    const output = [
      `# Preview Error Fix — FAILED ❌`,
      ``,
      `**Cycles completed:** ${cycleLog.length}`,
      `**Status:** Error not resolved after ${maxCycles} cycles`,
      ``,
      `## Cycle Log`,
    ];

    for (const entry of cycleLog) {
      if (entry.status === "pass") {
        output.push(`- Cycle ${entry.cycle}: ✅ FIXED`);
      } else if (entry.status === "error") {
        output.push(`- Cycle ${entry.cycle}: ⚠️ STOPPED (${entry.diagnosis})`);
      } else {
        output.push(`- Cycle ${entry.cycle}: 🔧 Applied fix (error persists)`);
      }
    }

    output.push("");
    output.push(`## Last Diagnosis`);
    output.push(
      cycleLog[cycleLog.length - 1]?.diagnosis.slice(0, 2000) || "N/A",
    );

    output.push("");
    ctx.onXmlComplete(
      `<dyad-preview-fix status="complete" result="fail" cycles="${cycleLog.length}"/>`,
    );

    return output.join("\n");
  },
};
