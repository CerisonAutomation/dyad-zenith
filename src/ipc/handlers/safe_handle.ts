import type { IpcMainInvokeEvent } from "electron";
import log from "electron-log";
import { DyadError } from "@/errors/dyad_error";
import {
  createIpcErrorEnvelope,
  createIpcSuccessEnvelope,
} from "../contracts/core";
import { sendTelemetryException } from "../utils/telemetry";
import { IS_TEST_BUILD } from "../utils/test_utils";
import { registerTrustedIpcHandler } from "./trusted_handle";

/**
 * IPC may carry credentials, source code, prompts, OAuth material, and file
 * contents. Logs must therefore describe payload *shape*, never payload value.
 */
export function summarizeIpcValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return `[string length=${value.length}]`;
  if (typeof value === "number") return "[number]";
  if (typeof value === "boolean") return "[boolean]";
  if (typeof value === "bigint") return "[bigint]";
  if (typeof value === "function") return "[function]";
  if (typeof value === "symbol") return "[symbol]";
  if (Buffer.isBuffer(value)) return `[buffer bytes=${value.byteLength}]`;
  if (ArrayBuffer.isView(value)) return `[typed-array bytes=${value.byteLength}]`;
  if (value instanceof ArrayBuffer) return `[array-buffer bytes=${value.byteLength}]`;
  if (Array.isArray(value)) return `[array length=${value.length}]`;
  if (value instanceof Error) return `[error name=${value.name}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>);
    const visible = keys.slice(0, 12).join(",");
    return `[object keys=${visible}${keys.length > 12 ? ",…" : ""}]`;
  }
  return `[${typeof value}]`;
}

function summarizeIpcArgs(args: unknown[]): string {
  return args.map((value) => summarizeIpcValue(value)).join(", ");
}

export function createLoggedHandler(logger: log.LogFunctions) {
  return (
    channel: string,
    fn: (event: IpcMainInvokeEvent, ...args: any[]) => Promise<any>,
  ) => {
    const handleError = (error: unknown, args: any[]) => {
      logger.error(
        `Error in ${fn.name || channel}: args=[${summarizeIpcArgs(args)}]`,
        error instanceof Error ? `${error.name}: ${error.message}` : "[non-Error]",
      );
      sendTelemetryException(error, { ipc_channel: channel });
      // Preserve DyadError so telemetry classification stays consistent.
      if (error instanceof DyadError) {
        return createIpcErrorEnvelope(error);
      }
      return createIpcErrorEnvelope(new Error(`[${channel}] ${error}`));
    };

    registerTrustedIpcHandler(
      channel,
      async (event: IpcMainInvokeEvent, ...args: any[]) => {
        logger.debug(`IPC: ${channel} called with args=[${summarizeIpcArgs(args)}]`);
        try {
          const result = await fn(event, ...args);
          logger.debug(
            `IPC: ${channel} returned ${summarizeIpcValue(result)}`,
          );
          return createIpcSuccessEnvelope(result);
        } catch (error) {
          return handleError(error, args);
        }
      },
      {
        onTrustFailure: (error, _event, ...args) => handleError(error, args),
      },
    );
  };
}

export function createTestOnlyLoggedHandler(logger: log.LogFunctions) {
  if (!IS_TEST_BUILD) {
    // Returns a no-op function for non-e2e test builds.
    return () => {};
  }
  return createLoggedHandler(logger);
}
