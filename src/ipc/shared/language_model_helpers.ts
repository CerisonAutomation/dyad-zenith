import { db } from "@/db";
import {
  language_model_providers as languageModelProvidersSchema,
  language_models as languageModelsSchema,
} from "@/db/schema";
import type { LanguageModelProvider, LanguageModel } from "@/ipc/types";
import { eq } from "drizzle-orm";
import log from "electron-log";
import {
  CLOUD_PROVIDERS,
  LOCAL_PROVIDERS,
  MODEL_OPTIONS,
  PROVIDER_TO_ENV_VAR,
} from "./language_model_constants";
import { getBuiltinLanguageModelCatalog } from "./remote_language_model_catalog";
import { getEnvVar } from "../utils/read_env";
import { readSettings } from "@/main/settings";
import { KILOCODE_MODELS_URL } from "./kilocode_gateway";

const logger = log.scope("language_model_helpers");

// Provider-specific API endpoints for model discovery
const PROVIDER_MODEL_ENDPOINTS: Record<
  string,
  { url: string; headerKey?: string }
> = {
  openai: {
    url: "https://api.openai.com/v1/models",
    headerKey: "OPENAI_API_KEY",
  },
  anthropic: {
    url: "https://api.anthropic.com/v1/models",
    headerKey: "ANTHROPIC_API_KEY",
  },
  google: {
    url: "https://generativelanguage.googleapis.com/v1beta/models",
    headerKey: "GEMINI_API_KEY",
  },
  openrouter: {
    url: "https://openrouter.ai/api/v1/models",
    headerKey: "OPENROUTER_API_KEY",
  },
  opencode: {
    url: "https://opencode.ai/zen/go/v1/models",
    headerKey: "OPENCODE_API_KEY",
  },
  kilocode: {
    url: KILOCODE_MODELS_URL,
    headerKey: "KILOCODE_API_KEY",
  },
  xai: {
    url: "https://api.x.ai/v1/models",
    headerKey: "XAI_API_KEY",
  },
};

/** Timeout for provider API model-discovery requests (ms). */
const MODEL_DISCOVERY_TIMEOUT_MS = 10_000;
/**
 * Fetches language model providers from both the database (custom) and hardcoded constants (cloud),
 * merging them with custom providers taking precedence.
 * @returns A promise that resolves to an array of LanguageModelProvider objects.
 */
export async function getLanguageModelProviders(): Promise<
  LanguageModelProvider[]
> {
  // Fetch custom providers from the database
  const customProvidersDb = await db
    .select()
    .from(languageModelProvidersSchema);

  const customProvidersMap = new Map<string, LanguageModelProvider>();
  for (const cp of customProvidersDb) {
    customProvidersMap.set(cp.id, {
      id: cp.id,
      name: cp.name,
      apiBaseUrl: cp.api_base_url,
      envVarName: cp.env_var_name ?? undefined,
      type: "custom",
      // hasFreeTier, websiteUrl, gatewayPrefix are not in the custom DB schema
      // They will be undefined unless overridden by hardcoded values if IDs match
    });
  }

  const builtinCatalog = await getBuiltinLanguageModelCatalog();
  logger.debug("Loaded builtin catalog for provider list", {
    source: builtinCatalog.source,
    version: builtinCatalog.version,
    providerCount: builtinCatalog.providers.length,
  });

  const hardcodedProviders: LanguageModelProvider[] = [
    ...builtinCatalog.providers,
  ];

  // Merge in any CLOUD_PROVIDERS not present in the remote catalog
  // (e.g. auto, azure, bedrock which are not in the remote API).
  for (const [providerId, providerDetails] of Object.entries(CLOUD_PROVIDERS)) {
    if (!hardcodedProviders.some((p) => p.id === providerId)) {
      hardcodedProviders.push({
        id: providerId,
        name: providerDetails.displayName,
        hasFreeTier: providerDetails.hasFreeTier,
        websiteUrl: providerDetails.websiteUrl,
        gatewayPrefix: providerDetails.gatewayPrefix,
        secondary: providerDetails.secondary,
        envVarName:
          PROVIDER_TO_ENV_VAR[providerId as keyof typeof PROVIDER_TO_ENV_VAR] ??
          undefined,
        type: "cloud",
      });
    }
  }

  for (const providerKey in LOCAL_PROVIDERS) {
    if (Object.prototype.hasOwnProperty.call(LOCAL_PROVIDERS, providerKey)) {
      const key = providerKey as keyof typeof LOCAL_PROVIDERS;
      const providerDetails = LOCAL_PROVIDERS[key];
      hardcodedProviders.push({
        id: key,
        name: providerDetails.displayName,
        hasFreeTier: providerDetails.hasFreeTier,
        type: "local",
      });
    }
  }

  return [...hardcodedProviders, ...customProvidersMap.values()];
}

/**
 * Fetches language models for a specific provider.
 * @param obj An object containing the providerId.
 * @returns A promise that resolves to an array of LanguageModel objects.
 */
export async function getLanguageModels({
  providerId,
}: {
  providerId: string;
}): Promise<LanguageModel[]> {
  const allProviders = await getLanguageModelProviders();
  const provider = allProviders.find((p) => p.id === providerId);

  if (!provider) {
    logger.warn(`Provider with ID "${providerId}" not found.`);
    return [];
  }

  // Get custom models from DB for all provider types
  let customModels: LanguageModel[] = [];

  try {
    const customModelsDb = await db
      .select({
        id: languageModelsSchema.id,
        displayName: languageModelsSchema.displayName,
        apiName: languageModelsSchema.apiName,
        description: languageModelsSchema.description,
        maxOutputTokens: languageModelsSchema.max_output_tokens,
        contextWindow: languageModelsSchema.context_window,
      })
      .from(languageModelsSchema)
      .where(
        isCustomProvider({ providerId })
          ? eq(languageModelsSchema.customProviderId, providerId)
          : eq(languageModelsSchema.builtinProviderId, providerId),
      );

    customModels = customModelsDb.map((model) => ({
      ...model,
      description: model.description ?? "",
      tag: undefined,
      maxOutputTokens: model.maxOutputTokens ?? undefined,
      contextWindow: model.contextWindow ?? undefined,
      type: "custom",
    }));
  } catch (error) {
    logger.error(
      `Error fetching custom models for provider "${providerId}" from DB:`,
      error,
    );
    // Continue with empty custom models array
  }

  // If it's a cloud provider, also get the hardcoded models
  let hardcodedModels: LanguageModel[] = [];
  if (provider.type === "cloud") {
    const builtinCatalog = await getBuiltinLanguageModelCatalog();
    logger.debug("Loading cloud models from builtin catalog", {
      providerId,
      source: builtinCatalog.source,
      version: builtinCatalog.version,
      hasProviderModels: providerId in builtinCatalog.modelsByProvider,
    });
    const catalogModels = builtinCatalog.modelsByProvider[providerId] || [];
    hardcodedModels = [...catalogModels];

    // Always merge MODEL_OPTIONS as fallback — the remote catalog may list a
    // provider with an empty model array, which would leave the user seeing
    // "no models found" even though we have local definitions.
    if (providerId in MODEL_OPTIONS) {
      const catalogApiNames = new Set(catalogModels.map((m) => m.apiName));
      for (const model of MODEL_OPTIONS[providerId]) {
        if (!catalogApiNames.has(model.name)) {
          hardcodedModels.push({
            apiName: model.name,
            displayName: model.displayName,
            description: model.description,
            tag: model.tag,
            tagColor: model.tagColor,
            maxOutputTokens: model.maxOutputTokens,
            contextWindow: model.contextWindow,
            temperature: model.temperature,
            dollarSigns: model.dollarSigns,
            type: "cloud" as const,
          });
        }
      }
    }
  }

  return [...hardcodedModels, ...customModels];
}

/**
 * Fetches all language models grouped by their provider IDs.
 * @returns A promise that resolves to a Record mapping provider IDs to arrays of LanguageModel objects.
 */
export async function getLanguageModelsByProviders(): Promise<
  Record<string, LanguageModel[]>
> {
  const providers = await getLanguageModelProviders();

  // Fetch all models concurrently
  const modelPromises = providers
    .filter((p) => p.type !== "local")
    .map(async (provider) => {
      const models = await getLanguageModels({ providerId: provider.id });
      return { providerId: provider.id, models };
    });

  // Wait for all requests to complete
  const results = await Promise.all(modelPromises);

  // Convert the array of results to a record
  const record: Record<string, LanguageModel[]> = {};
  for (const result of results) {
    record[result.providerId] = result.models;
  }

  return record;
}

export function isCustomProvider({ providerId }: { providerId: string }) {
  return providerId.startsWith(CUSTOM_PROVIDER_PREFIX);
}

export const CUSTOM_PROVIDER_PREFIX = "custom::";

/**
 * Fetches models directly from a provider's API endpoint.
 * Returns discovered models that aren't already in the hardcoded catalog.
 */
export async function fetchModelsFromProviderAPI({
  providerId,
  provider,
}: {
  providerId: string;
  provider: LanguageModelProvider;
}): Promise<LanguageModel[]> {
  const endpointConfig = PROVIDER_MODEL_ENDPOINTS[providerId];

  // For custom providers, try their configured API base URL with /models endpoint
  const baseUrl =
    provider.type === "custom" && provider.apiBaseUrl
      ? provider.apiBaseUrl
      : endpointConfig?.url;

  if (!baseUrl) {
    logger.debug(`No API endpoint configured for provider "${providerId}"`);
    return [];
  }

  // Get API key: settings-stored provider key first, then env var
  const envVarName =
    provider.envVarName ??
    endpointConfig?.headerKey ??
    PROVIDER_TO_ENV_VAR[providerId as keyof typeof PROVIDER_TO_ENV_VAR];

  let apiKey: string | undefined = undefined;
  try {
    const settings = readSettings();
    apiKey =
      settings.providerSettings?.[providerId]?.apiKey?.value?.trim() ||
      undefined;
  } catch (error) {
    logger.debug(`Could not read settings for provider "${providerId}":`, error);
  }

  if (!apiKey && envVarName) {
    apiKey = getEnvVar(envVarName);
  }

  const supportsAnonymousDiscovery = providerId === "kilocode";
  if (!apiKey && !supportsAnonymousDiscovery) {
    logger.debug(`No API key found for provider "${providerId}"`);
    return [];
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    MODEL_DISCOVERY_TIMEOUT_MS,
  );

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    let requestUrl = baseUrl;

    // Provider-specific auth headers
    if (providerId === "anthropic") {
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = "2023-06-01";
    } else if (providerId === "google") {
      // Google uses x-goog-api-key header (avoids leaking key in URL query string)
      headers["x-goog-api-key"] = apiKey;
    } else if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    const response = await fetch(requestUrl, {
      headers,
      signal: controller.signal,
    });

    if (!response.ok) {
      logger.warn(
        `Failed to fetch models from ${providerId}: HTTP ${response.status}`,
      );
      return [];
    }

    const data = await response.json();

    // Transform based on provider
    if (providerId === "google") {
      return transformGoogleModels(data);
    }
    return transformProviderModels(providerId, data);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      logger.warn(
        `Model discovery timed out for ${providerId} after ${MODEL_DISCOVERY_TIMEOUT_MS}ms`,
      );
    } else {
      logger.error(`Error fetching models from ${providerId}:`, error);
    }
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

function transformProviderModels(
  providerId: string,
  data: unknown,
): LanguageModel[] {
  if (!data || typeof data !== "object") return [];

  // OpenAI format: { data: [{ id, owned_by, ... }] }
  if (providerId === "openai" || providerId === "xai") {
    const models = (data as { data?: Array<{ id: string; owned_by?: string }> })
      .data;
    if (!Array.isArray(models)) return [];

    return models
      .filter(
        (m) =>
          m.id &&
          !m.id.includes("embed") &&
          !m.id.includes("tts") &&
          !m.id.includes("whisper") &&
          !m.id.includes("dall-e") &&
          !m.id.includes(" Moderation") &&
          !m.id.includes("rerank"),
      )
      .map((m) => ({
        apiName: m.id,
        displayName: formatModelName(m.id),
        description: `${m.id} from ${providerId}`,
        type: "cloud" as const,
      }));
  }

  // Anthropic format: { data: [{ id, type, ... }] }
  if (providerId === "anthropic") {
    const models = (data as { data?: Array<{ id: string }> }).data;
    if (!Array.isArray(models)) return [];

    return models
      .filter((m) => m.id && !m.id.includes("embed"))
      .map((m) => ({
        apiName: m.id,
        displayName: formatModelName(m.id),
        description: `${m.id} from Anthropic`,
        type: "cloud" as const,
      }));
  }

  // OpenRouter format: { data: [{ id, name, description, ... }] }
  if (providerId === "openrouter") {
    const models = (
      data as {
        data?: Array<{
          id: string;
          name?: string;
          description?: string;
          pricing?: { prompt?: string; completion?: string };
        }>;
      }
    ).data;
    if (!Array.isArray(models)) return [];

    return models
      .filter((m) => m.id && !m.id.includes("embed"))
      .map((m) => ({
        apiName: m.id,
        displayName: m.name || formatModelName(m.id),
        description: m.description || `${m.id} from OpenRouter`,
        type: "cloud" as const,
      }));
  }

  // Fallback: assume OpenAI-compatible format
  const models = (data as { data?: Array<{ id: string }> }).data;
  if (!Array.isArray(models)) return [];

  return models
    .filter((m) => m.id && !m.id.includes("embed"))
    .map((m) => ({
      apiName: m.id,
      displayName: formatModelName(m.id),
      description: `${m.id}`,
      type: "cloud" as const,
    }));
}

function transformGoogleModels(data: unknown): LanguageModel[] {
  if (!data || typeof data !== "object") return [];

  // Google format: { models: [{ name, displayName, ... }] }
  const models = (data as Record<string, unknown>).models;
  if (!Array.isArray(models)) return [];

  return models
    .filter(
      (m): m is { name: string; displayName?: string } =>
        m != null &&
        typeof m === "object" &&
        "name" in m &&
        typeof (m as { name: unknown }).name === "string" &&
        !(m as { name: string }).name.includes("embed"),
    )
    .map((m) => {
      const stripped = m.name.replace(/^models\//, "");
      return {
        apiName: stripped,
        displayName: m.displayName || formatModelName(stripped),
        description: `${m.displayName || stripped} (Google)`,
        type: "cloud" as const,
      };
    });
}

function formatModelName(id: string): string {
  return id
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\bApi\b/i, "API")
    .replace(/\bGpt\b/i, "GPT")
    .replace(/\bGpts\b/i, "GPTs")
    .replace(/\bMini\b/i, "Mini")
    .replace(/\bMax\b/i, "Max")
    .replace(/\bLlm\b/i, "LLM")
    .replace(/\bMl\b/i, "ML")
    .replace(/\bAi\b/i, "AI")
    .replace(/\bIo\b/i, "IO")
    .replace(/\bO\b(?=\s|$)/g, "o");
}

/**
 * Auto-discovers models from all configured providers by querying their APIs.
 * Merges discovered models with the existing catalog.
 * Returns a record of provider ID → combined model list.
 */
export async function autoDiscoverModels(): Promise<
  Record<string, LanguageModel[]>
> {
  const providers = await getLanguageModelProviders();
  const builtinCatalog = await getBuiltinLanguageModelCatalog();

  const cloudProviders = providers.filter(
    (p) => p.type === "cloud" && p.id !== "auto",
  );

  const entries = await Promise.all(
    cloudProviders.map(async (provider) => {
      try {
        const catalogModels =
          builtinCatalog.modelsByProvider[provider.id] || [];

        const apiModels = await fetchModelsFromProviderAPI({
          providerId: provider.id,
          provider,
        });

        // Deduplicate: catalog models take precedence over API-discovered
        const catalogApiNames = new Set(catalogModels.map((m) => m.apiName));
        const newModels = apiModels.filter(
          (m) => !catalogApiNames.has(m.apiName),
        );

        if (newModels.length > 0) {
          logger.info(
            `Discovered ${newModels.length} new model(s) from ${provider.id}`,
            { models: newModels.map((m) => m.apiName) },
          );
        }

        return {
          providerId: provider.id,
          models: [...catalogModels, ...newModels],
        };
      } catch (error) {
        logger.error(
          `Failed to auto-discover models for ${provider.id}:`,
          error,
        );
        return {
          providerId: provider.id,
          models: builtinCatalog.modelsByProvider[provider.id] || [],
        };
      }
    }),
  );

  return Object.fromEntries(entries.map((e) => [e.providerId, e.models]));
}
