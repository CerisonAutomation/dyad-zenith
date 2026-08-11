import { beforeEach, describe, expect, it, vi } from "vitest";

import { appRunActorService } from "@/ipc/services/app_run_actor_service";
import { appLifecycleTool } from "./app_lifecycle";
import type { AgentContext } from "./types";

vi.mock("@/ipc/services/app_run_actor_service", () => ({
  appRunActorService: {
    executeExternalLifecycle: vi.fn(),
  },
}));

describe("app lifecycle tools", () => {
  const ctx = {
    appId: 42,
    event: { sender: undefined },
    onXmlStream: vi.fn(),
    onXmlComplete: vi.fn(),
  } as unknown as AgentContext;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(appRunActorService.executeExternalLifecycle).mockResolvedValue(
      undefined,
    );
  });

  it("declares restart as an auto-approved runtime mutation", () => {
    expect(appLifecycleTool.inputSchema.parse({})).toEqual({});
    expect(appLifecycleTool.inputSchema.parse({ action: "rebuild" })).toEqual({ action: "rebuild" });
    expect(appLifecycleTool.defaultConsent).toBe("ask");
    expect(appLifecycleTool.modifiesState).toBe(true);
    expect(appLifecycleTool.description).toContain(
      "restart after ordinary source edits is unnecessary",
    );
  });

  it("restarts the current app without removing dependencies", async () => {
    await expect(appLifecycleTool.execute({}, ctx)).resolves.toBe(
      "The app restarted successfully.",
    );

    expect(appRunActorService.executeExternalLifecycle).toHaveBeenCalledWith({
      appId: 42,
      operation: "restart",
      abortSignal: undefined,
      timeoutMs: undefined,
    });
    expect(ctx.onXmlStream).toHaveBeenCalledWith(
      '<dyad-status title="Restarting app"></dyad-status>',
    );
    expect(ctx.onXmlComplete).toHaveBeenCalledWith(
      '<dyad-status title="App restarted" state="finished"></dyad-status>',
    );
  });

  it("declares rebuild as an approval-required runtime mutation", () => {
    expect(appLifecycleTool.getConsentPreview?.({ action: "rebuild" })).toContain(
      "Delete node_modules",
    );
    expect(appLifecycleTool.getConsentPreview?.({})).toContain("Restart");
    expect(appLifecycleTool.description).toContain(
      "never call both for the same cause",
    );
  });

  it("rebuilds the current app after clearing stale logs", async () => {
    await expect(appLifecycleTool.execute({ action: "rebuild" }, ctx)).resolves.toBe(
      "The app rebuilt and restarted successfully.",
    );

    expect(appRunActorService.executeExternalLifecycle).toHaveBeenCalledWith({
      appId: 42,
      operation: "rebuild",
      abortSignal: undefined,
      timeoutMs: 15 * 60 * 1_000,
    });
    expect(ctx.onXmlStream).toHaveBeenCalledWith(
      '<dyad-status title="Rebuilding app"></dyad-status>',
    );
    expect(ctx.onXmlComplete).toHaveBeenCalledWith(
      '<dyad-status title="App rebuilt" state="finished"></dyad-status>',
    );
  });

  it("does not render a duplicate completed preview", () => {
    expect(appLifecycleTool.buildXml?.({}, false)).toContain("Restarting app");
    expect(appLifecycleTool.buildXml?.({}, true)).toBeUndefined();
    expect(appLifecycleTool.buildXml?.({ action: "rebuild" }, false)).toContain("Rebuilding app");
    expect(appLifecycleTool.buildXml?.({ action: "rebuild" }, true)).toBeUndefined();
  });

  it("does not start a lifecycle mutation after the turn is cancelled", async () => {
    const abortController = new AbortController();
    abortController.abort();
    const cancelledCtx = {
      ...ctx,
      abortSignal: abortController.signal,
    } as AgentContext;

    await expect(appLifecycleTool.execute({}, cancelledCtx)).rejects.toThrow(
      "cancelled before it started",
    );

    expect(appRunActorService.executeExternalLifecycle).not.toHaveBeenCalled();
    expect(ctx.onXmlStream).not.toHaveBeenCalled();
  });
});
