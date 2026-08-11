import type { LanguageModel } from "ai";

import { DyadError, DyadErrorKind } from "@/errors/dyad_error";
import { getModelClient } from "@/ipc/utils/get_model_client";
import { getAiHeaders, getProviderOptions } from "@/ipc/utils/provider_options";
import { getMaxTokens, getTemperature } from "@/ipc/utils/token_utils";
import type { LargeLanguageModel, UserSettings } from "@/lib/schemas";
import { readSettings } from "@/main/settings";

import type { AgentContext } from "./tools/types";

export interface AgentModelRuntime {
  settings: UserSettings;
  selectedModel: LargeLanguageModel;
  model: LanguageModel;
  builtinProviderId?: string;
  headers?: Record<string, string>;
  providerOptions: Record<string, any>;
  maxOutputTokens?: number;
  temperature?: number;
}

/**
 * Canonical model resolver for every LLM-backed local-agent tool.
 *
 * This delegates provider construction, Auto/free-first routing, API-key handling,
 * custom-provider behavior, OpenAI Responses handling, Ollama/LM Studio, and
 * provider-specific options to Dyad's single canonical model stack.
 */
export async function resolveAgentModelRuntime(
  ctx: Pick<AgentContext, "appId" | "dyadRequestId">,
  options: {
    maxOutputTokens?: number;
    /** Force a minimum thinking budget for reasoning-intensive tools. */
    minThinkingBudget?: "low" | "medium" | "high";
  } = {},
): Promise<AgentModelRuntime> {
  const settings = readSettings();
  const selectedModel = settings.selectedModel;

  if (!selectedModel?.provider || !selectedModel?.name) {
    throw new DyadError(
      "No model is configured. Select a provider and model in Settings → Providers.",
      DyadErrorKind.Precondition,
    );
  }


  const { modelClient } = await getModelClient(selectedModel, settings);
  const configuredMaxTokens = await getMaxTokens(selectedModel);
  const maxOutputTokens = options.maxOutputTokens
    ? Math.min(configuredMaxTokens ?? options.maxOutputTokens, options.maxOutputTokens)
    : configuredMaxTokens;
  const temperature = await getTemperature(selectedModel);

  // Honour the tool's minimum thinking budget — upgrade if user's global setting is lower.
  const BUDGET_RANK: Record<string, number> = { low: 0, medium: 1, high: 2 };
  const userBudget = settings.thinkingBudget ?? "medium";
  const effectiveBudget =
    options.minThinkingBudget &&
    (BUDGET_RANK[options.minThinkingBudget] ?? 0) > (BUDGET_RANK[userBudget] ?? 0)
      ? options.minThinkingBudget
      : userBudget;

  const effectiveSettings =
    effectiveBudget !== userBudget
      ? { ...settings, thinkingBudget: effectiveBudget as "low" | "medium" | "high" }
      : settings;

  return {
    settings: effectiveSettings,
    selectedModel,
    model: modelClient.model,
    builtinProviderId: modelClient.builtinProviderId,
    headers: getAiHeaders({
      builtinProviderId: modelClient.builtinProviderId,
    }),
    providerOptions: getProviderOptions({
      dyadAppId: ctx.appId,
      dyadRequestId: ctx.dyadRequestId,
      dyadDisableFiles: true,
      files: [],
      mentionedAppsCodebases: [],
      builtinProviderId: modelClient.builtinProviderId,
      settings: effectiveSettings,
    }),
    maxOutputTokens,
    temperature,
  };
}
