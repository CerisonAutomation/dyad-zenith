import fetch from "node-fetch";
import { z } from "zod";
import log from "electron-log";
import { createTypedHandler } from "./base";
import { freeModelQuotaContracts } from "../types/free_model_quota";
import { readSettings } from "@/main/settings";
import { DyadError, DyadErrorKind } from "@/errors/dyad_error";
// Engine removed — quota handled locally.
const NO_ENGINE_URL = "http://localhost:0/engine-removed";

const logger = log.scope("free_model_quota_handlers");

const EngineFreeQuotaResponseSchema = z.object({
  used: z.number(),
  limit: z.number(),
  remaining: z.number(),
  resetAt: z.string(),
});

export function registerFreeModelQuotaHandlers() {
  createTypedHandler(
    freeModelQuotaContracts.getFreeModelQuotaStatus,
    async () => getFreeModelQuotaStatus(),
  );
}

export async function getFreeModelQuotaStatus() {
  // ADR-001: custom build — free quota is unlimited (models run through the
  // user's configured providers / local endpoints, not the Dyad Free tier).
  // Returning an unlimited quota keeps agent-mode UI gating healthy without
  // any engine dependency.
  return {
    messagesUsed: 0,
    messagesLimit: 1_000_000,
    messagesRemaining: 1_000_000,
    isQuotaExceeded: false,
    resetTime: null,
  };

  const settings = readSettings();
  // Engine only accepts Dyad-issued keys (auto provider); provider keys 401.
  const apiKey = settings.providerSettings?.auto?.apiKey?.value;

  if (!apiKey) {
    throw new DyadError(
      "At least one provider API key must be configured in Settings.",
      DyadErrorKind.Auth,
    );
  }

  const baseURL = NO_ENGINE_URL;
  let response: Awaited<ReturnType<typeof fetch>>;
  try {
    response = await fetch(`${baseURL}/free/quota`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });
  } catch (error) {
    logger.warn("Failed to fetch free model quota.", error);
    throw new DyadError(
      "Unable to fetch Dyad Free quota.",
      DyadErrorKind.External,
    );
  }

  if (!response.ok) {
    const errorBody = await response.text();
    // Collapse whitespace and truncate so an HTML error page doesn't flood the log.
    const errorSummary = errorBody.replace(/\s+/g, " ").slice(0, 200);
    logger.warn(
      `Failed to fetch free model quota. Status: ${response.status}. Body: ${errorSummary}`,
    );
    throw new DyadError(
      "Unable to fetch Dyad Free quota.",
      response.status === 401 || response.status === 403
        ? DyadErrorKind.Auth
        : DyadErrorKind.External,
    );
  }

  const data = EngineFreeQuotaResponseSchema.parse(await response.json());
  const resetTime = new Date(data.resetAt).getTime();

  return {
    messagesUsed: data.used,
    messagesLimit: data.limit,
    messagesRemaining: data.remaining,
    isQuotaExceeded: data.remaining <= 0,
    resetTime: Number.isNaN(resetTime) ? null : resetTime,
  };
}
