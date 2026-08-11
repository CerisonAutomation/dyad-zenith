import { z } from "zod";

import { DyadError, DyadErrorKind } from "@/errors/dyad_error";
import { appRunActorService } from "@/ipc/services/app_run_actor_service";
import type { AgentContext, ToolDefinition } from "./types";

const appLifecycleSchema = z.object({
  action: z
    .enum(["restart", "rebuild"])
    .optional()
    .describe(
      "What to do: restart the dev server, or rebuild (delete node_modules, reinstall dependencies, restart). Defaults to restart.",
    ),
});
const REBUILD_READY_TIMEOUT_MS = 15 * 60 * 1_000;

type LifecycleAction = z.infer<typeof appLifecycleSchema>["action"];

function buildLifecycleXml(title: string, state?: "finished"): string {
  const stateAttr = state ? ` state="${state}"` : "";
  return `<dyad-status title="${title}"${stateAttr}></dyad-status>`;
}

function assertLifecycleCanStart(ctx: AgentContext): void {
  if (ctx.abortSignal?.aborted) {
    throw new DyadError(
      "The app lifecycle operation was cancelled before it started",
      DyadErrorKind.UserCancelled,
    );
  }
}

async function executeLifecycle({
  ctx,
  operation,
}: {
  ctx: AgentContext;
  operation: Exclude<LifecycleAction, undefined>;
}): Promise<void> {
  await appRunActorService.executeExternalLifecycle({
    appId: ctx.appId,
    operation,
    abortSignal: ctx.abortSignal,
    timeoutMs: operation === "rebuild" ? REBUILD_READY_TIMEOUT_MS : undefined,
  });
}

export const appLifecycleTool: ToolDefinition<
  z.infer<typeof appLifecycleSchema>
> = {
  name: "app_lifecycle",
  description:
    "Restart or rebuild the current app's development environment. Use restart when the dev server is stopped/unresponsive/stale or a process-boundary change requires it (dev-server config, startup scripts, environment variables, server initialization); restart after ordinary source edits is unnecessary. Use rebuild (action=\"rebuild\") only when the user explicitly asks or node_modules/dependencies are demonstrably broken — rebuild includes a restart, so never call both for the same cause and never repeat for the same unchanged cause.",
  inputSchema: appLifecycleSchema,
  defaultConsent: "ask",
  modifiesState: true,

  getConsentPreview: (args) => {
    const action: Exclude<LifecycleAction, undefined> =
      args?.action ?? "restart";
    return action === "rebuild"
      ? "Delete node_modules, reinstall dependencies, and restart the current app"
      : "Restart the current app";
  },

  buildXml: (args, isComplete) => {
    const action: Exclude<LifecycleAction, undefined> =
      args?.action ?? "restart";
    const title = action === "rebuild" ? "Rebuilding app" : "Restarting app";
    const doneTitle =
      action === "rebuild" ? "App rebuilt" : "App restarted";
    return isComplete ? undefined : buildLifecycleXml(title);
  },

  execute: async (args, ctx: AgentContext) => {
    const action: Exclude<LifecycleAction, undefined> =
      args?.action ?? "restart";
    assertLifecycleCanStart(ctx);
    const title = action === "rebuild" ? "Rebuilding app" : "Restarting app";
    const doneTitle = action === "rebuild" ? "App rebuilt" : "App restarted";
    const resultText =
      action === "rebuild"
        ? "The app rebuilt and restarted successfully."
        : "The app restarted successfully.";
    ctx.onXmlStream(buildLifecycleXml(title));
    await executeLifecycle({ ctx, operation: action });
    ctx.onXmlComplete(buildLifecycleXml(doneTitle, "finished"));
    return resultText;
  },
};
