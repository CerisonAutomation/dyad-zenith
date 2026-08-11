import { spawn } from "node:child_process";
import { z } from "zod";
import { ToolDefinition, AgentContext, escapeXmlContent } from "./types";
import { getFrameworkBuildCommand } from "@/lib/framework_constants";
import { detectFrameworkType } from "@/ipc/utils/framework_utils";
import {
  getPackageManagerSignal,
  signalPrefersPnpm,
} from "@/ipc/utils/package_manager_selection";

const buildAppSchema = z.object({}).strict();

const BUILD_TIMEOUT_MS = 10 * 60 * 1_000;

function runBuildCommand(
  appPath: string,
  command: string,
  signal: AbortSignal | undefined,
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd: appPath,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      signal,
      env: {
        ...process.env,
        CI: process.env.CI ?? "1",
      },
    });
    let output = "";
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      // Bound retained output; builds can be very chatty.
      if (output.length > 60_000) {
        output = output.slice(output.length - 60_000);
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve({
        code: null,
        output: `${output}\n[build timed out after ${BUILD_TIMEOUT_MS / 1000}s]`,
      });
    }, BUILD_TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, output: `${output}\n[spawn error: ${String(error)}]` });
    });
  });
}

export const buildAppTool: ToolDefinition<z.infer<typeof buildAppSchema>> = {
  name: "build_app",
  description:
    "Run the production build for the current app using Dyad's detected framework command. Custom shell commands are intentionally not accepted here; use the terminal tool so normal execution consent applies.",
  inputSchema: buildAppSchema,
  defaultConsent: "ask",
  modifiesState: true,

  getConsentPreview: () => "Run the detected production build",

  execute: async (_args, ctx: AgentContext) => {
    const appPath = ctx.appPath;
    const frameworkType = detectFrameworkType(appPath);
    let command = getFrameworkBuildCommand(frameworkType);
    if (!command) {
      return "This app is a static site (no build step) — the preview serves files directly. Nothing to build.";
    }

    // Prefer the project's own package manager for the build.
    const signal = getPackageManagerSignal(appPath);
    if (command.startsWith("npm ") && signalPrefersPnpm(signal)) {
      command = command.replace(/^npm /, "pnpm ");
    }

    ctx.onXmlStream(
      `<dyad-build framework="${escapeXmlContent(frameworkType ?? "unknown")}">building</dyad-build>`,
    );

    const { code, output } = await runBuildCommand(
      appPath,
      command,
      ctx.abortSignal,
    );
    const tail = output.slice(-8_000);
    if (code === 0) {
      ctx.onXmlComplete(
        `<dyad-build framework="${escapeXmlContent(frameworkType ?? "unknown")}" status="ok">build succeeded</dyad-build>`,
      );
      return `Production build succeeded (${command}).\n\n<build-output>\n${escapeXmlContent(tail)}\n</build-output>`;
    }
    ctx.onXmlComplete(
      `<dyad-build framework="${escapeXmlContent(frameworkType ?? "unknown")}" status="failed">build failed</dyad-build>`,
    );
    return `Production build failed (${command}) with exit code ${code ?? "timeout"}.\n\n<build-output>\n${escapeXmlContent(tail)}\n</build-output>\n\nFix the reported errors and run build_app again.`;
  },
};

/** Shared helper so specs can assert the resolved command cheaply. */
export function resolveBuildCommandForApp(appPath: string): string | null {
  const frameworkType = detectFrameworkType(appPath);
  const detected = getFrameworkBuildCommand(frameworkType);
  if (!detected) return null;
  const signal = getPackageManagerSignal(appPath);
  if (detected.startsWith("npm ") && signalPrefersPnpm(signal)) {
    return detected.replace(/^npm /, "pnpm ");
  }
  return detected;
}
