import { BrowserWindow } from "electron";
import log from "electron-log";
import {
  DyadError,
  isDyadErrorKindFilteredFromTelemetry,
} from "@/errors/dyad_error";
import { isGenericFetchFailedError } from "@/lib/posthogTelemetry";
import { TelemetryEventPayload } from "@/ipc/types";

const logger = log.scope("telemetry");
const FILTERED_EXCEPTION_MESSAGES = new Set([
  "Supabase access token not found. Please authenticate first.",
]);

const TELEMETRY_SECRET_PATTERNS: RegExp[] = [
  /\b(?:gsk|ghp|github_pat|xox[baprs])_[A-Za-z0-9_-]{12,}\b/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bctx7sk-[A-Za-z0-9_-]{12,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+\/-]+=*\b/gi,
  /([?&](?:api[_-]?key|token|access_token|secret|password)=)[^&#\s]+/gi,
  /((?:api[_-]?key|token|access[_-]?token|secret|password)\s*[:=]\s*["']?)[^"'\s,}]{8,}/gi,
];

export function redactTelemetryText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  let redacted = value;
  for (const pattern of TELEMETRY_SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    redacted = redacted.replace(pattern, (match, prefix?: string) =>
      typeof prefix === "string" && prefix.length > 0
        ? `${prefix}[REDACTED]`
        : "[REDACTED]",
    );
  }
  return redacted;
}

/**
 * Sends a telemetry event from the main process to the renderer,
 * where PostHog can capture it.
 */
export function sendTelemetryEvent(
  eventName: string,
  properties?: Record<string, unknown>,
): void {
  try {
    const windows = BrowserWindow.getAllWindows();
    if (windows.length > 0) {
      sendTelemetryEventToWindow(windows[0], eventName, properties);
    }
  } catch (error) {
    logger.warn("Error sending telemetry event:", error);
  }
}

export function sendTelemetryEventToWindow(
  target: BrowserWindow,
  eventName: string,
  properties?: Record<string, unknown>,
): void {
  try {
    target.webContents.send("telemetry:event", {
      eventName,
      properties,
    } satisfies TelemetryEventPayload);
  } catch (error) {
    logger.warn("Error sending telemetry event:", error);
  }
}

/**
 * Sends an exception from the main process to the renderer as a PostHog $exception event.
 */
export function sendTelemetryException(
  error: unknown,
  context?: Record<string, unknown>,
): void {
  const err =
    error instanceof Error
      ? error
      : new Error(String(error ?? "Unknown error"));

  if (shouldFilterTelemetryException(err)) {
    return;
  }

  sendTelemetryEvent("$exception", {
    exception_name: err.name,
    exception_message: redactTelemetryText(err.message),
    exception_stack_trace: redactTelemetryText(err.stack),
    ...context,
  });
}

export function shouldFilterTelemetryException(error: unknown): boolean {
  if (error instanceof DyadError) {
    return isDyadErrorKindFilteredFromTelemetry(error.kind);
  }

  if (
    error instanceof Error &&
    error.name === "RateLimitError" &&
    error.message.includes("(429)")
  ) {
    return true;
  }

  if (
    error instanceof Error &&
    isGenericFetchFailedError(error.name, error.message)
  ) {
    return true;
  }

  const message =
    error instanceof Error ? error.message : String(error ?? "Unknown error");

  return FILTERED_EXCEPTION_MESSAGES.has(message);
}
