import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI as createGoogle } from "@ai-sdk/google";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createXai } from "@ai-sdk/xai";
import { createVertex as createGoogleVertex } from "@ai-sdk/google-vertex";
import { createAzure } from "@ai-sdk/azure";
import type { LanguageModel } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import type { FetchFunction } from "@ai-sdk/provider-utils";
import type {
  LargeLanguageModel,
  UserSettings,
  VertexProviderSetting,
  AzureProviderSetting,
} from "../../lib/schemas";
import { getEnvVar } from "./read_env";
import log from "electron-log";
import { getLanguageModelProviders } from "../shared/language_model_helpers";
import { resolveBuiltinModelAlias } from "../shared/remote_language_model_catalog";
import { LanguageModelProvider } from "@/ipc/types";

import { getLmStudioBaseUrl } from "./lm_studio_utils";
import { createOllamaProvider } from "./ollama_provider";
import { getOllamaApiUrl } from "../handlers/local_model_ollama_handler";
import { getTestFetchOption } from "./test_fetch_override";
import { createFallback } from "./fallback_ai_model";
import { DyadError, DyadErrorKind } from "@/errors/dyad_error";
import {
  findInvalidProviderApiKeyCharacter,
  formatInvalidProviderApiKeyMessage,
  normalizeProviderApiKeyInput,
} from "@/lib/providerApiKey";
import { getOpenRouterAppAttributionHeaders } from "./openrouter_attribution";
import {
  KILOCODE_GATEWAY_BASE_URL,
  canUseKilocodeAnonymously,
} from "../shared/kilocode_gateway";
import { FREE_PRO_MODEL_NAME, isFreeProModel } from "@/lib/freeProModel";
import { createDyadEngine } from "./llm_engine_provider";
let _createDyadEngine: typeof createDyadEngine | null = null;
// Engine removed — createDyadEngine is no longer called from auto routing.

// The test-only fetch seam lives in ./test_fetch_override (dependency-free,
// so secondary factories can use it without import cycles). Re-exported here
// for existing importers.
export { setModelClientFetchForTesting } from "./test_fetch_override";

function getModelClientFetchOption(): { fetch?: FetchFunction } {
  return getTestFetchOption();
}

export interface ModelClient {
  model: LanguageModel;
  builtinProviderId?: string;
}

const AUTO_DYAD_PRO_MODEL_ALIASES = [
  "dyad/auto/openai",
  "dyad/auto/anthropic",
  "dyad/auto/google",
] as const;

/**
 * Auto is intentionally free-first. Kilo and OpenRouter are attempted before
 * paid/provider-specific aliases. There is still only one user-facing Agent;
 * this is model routing, not a second agent layer.
 */
const AUTO_MODEL_ALIASES = [
  "dyad/auto/kilocode",
  "dyad/auto/openrouter",
  "dyad/auto/google",
  "dyad/auto/openai",
  "dyad/auto/anthropic",
] as const;

const FREE_ONLY_AUTO_ALIASES = [
  "dyad/auto/kilocode",
  "dyad/auto/openrouter",
] as const;
const OPENROUTER_FREE_MODEL_NAME = "openrouter/free";

const logger = log.scope("getModelClient");

function getConfiguredProviderKey(
  providerId: string,
  providerInfo: LanguageModelProvider | undefined,
  settings: UserSettings,
): string | undefined {
  return getProviderApiKeyForRequest(
    settings.providerSettings?.[providerId]?.apiKey?.value ||
      (providerInfo?.envVarName ? getEnvVar(providerInfo.envVarName) : undefined),
    providerInfo?.name ?? providerId,
  );
}

export async function getModelClient(
  model: LargeLanguageModel,
  settings: UserSettings,
): Promise<{
  modelClient: ModelClient;
  isEngineEnabled?: boolean;
  isSmartContextEnabled?: boolean;
}> {
  const allProviders = await getLanguageModelProviders();
  const providerConfig = allProviders.find((p) => p.id === model.provider);

  if (!providerConfig) {
    throw new DyadError(
      `Configuration not found for provider: ${model.provider}`,
      DyadErrorKind.NotFound,
    );
  }

  const dyadApiKey = settings.enableDyadPro
    ? getProviderApiKeyForRequest(
        settings.providerSettings?.auto?.apiKey?.value,
        "Dyad",
      )
    : undefined;
  const isDyadProEnabledForRequest = Boolean(
    dyadApiKey && settings.enableDyadPro,
  );

  if (isFreeProModel(model) && !isDyadProEnabledForRequest) {
    throw new DyadError(
      "Free Pro requires a credential. Use Zenith Auto (default) for BYOK/free-provider routing.",
      DyadErrorKind.Auth,
    );
  }

  // Engine calls removed — always route through local provider.
  if (model.provider === "auto") {
    const aliases =
      model.name === "free" ? FREE_ONLY_AUTO_ALIASES : AUTO_MODEL_ALIASES;
    const candidateModels: LanguageModel[] = [];
    let primaryProviderId: string | undefined;

    for (const aliasId of aliases) {
      const resolved = await resolveBuiltinModelAlias(aliasId);
      if (!resolved) continue;
      const providerInfo = allProviders.find((p) => p.id === resolved.providerId);
      if (!providerInfo) continue;
      const apiKey = getConfiguredProviderKey(
        resolved.providerId,
        providerInfo,
        settings,
      );
      const supportsAnonymousFree =
        resolved.providerId === "kilocode" &&
        canUseKilocodeAnonymously(resolved.apiName);
      if (!apiKey && !supportsAnonymousFree) continue;

      try {
        const direct = getRegularModelClient(
          { provider: resolved.providerId, name: resolved.apiName },
          settings,
          providerInfo,
        ).modelClient.model;
        candidateModels.push(direct);
        primaryProviderId ??= resolved.providerId;

        // OpenRouter's router is a useful second route behind its pinned free
        // model and costs no additional configuration.
        if (
          resolved.providerId === "openrouter" &&
          resolved.apiName !== OPENROUTER_FREE_MODEL_NAME
        ) {
          candidateModels.push(
            getRegularModelClient(
              { provider: "openrouter", name: OPENROUTER_FREE_MODEL_NAME },
              settings,
              providerInfo,
            ).modelClient.model,
          );
        }
      } catch (error) {
        logger.warn(`Skipping auto candidate ${aliasId}`, error);
      }
    }

    if (candidateModels.length === 0) {
      throw new DyadError(
        "Zenith Auto could not find an available model route. Kilo Auto Free normally works anonymously; you can also add a Kilo/OpenRouter/provider key or configure a local provider in Settings → Providers.",
        DyadErrorKind.Auth,
      );
    }

    return {
      modelClient: {
        model:
          candidateModels.length === 1
            ? candidateModels[0]
            : createFallback({ models: candidateModels }),
        builtinProviderId: primaryProviderId,
      },
      isEngineEnabled: false,
      isSmartContextEnabled: settings.enableProSmartFilesContextMode === true,
    };
  }

  const direct = getRegularModelClient(model, settings, providerConfig);
  return {
    modelClient: direct.modelClient,
    isEngineEnabled: false,
    isSmartContextEnabled: settings.enableProSmartFilesContextMode === true,
  };
}

async function getProModelClient({
  model,
  settings,
  provider,
  modelId,
}: {
  model: LargeLanguageModel;
  settings: UserSettings;
  provider: DyadEngineProvider;
  modelId: string;
}): Promise<ModelClient> {
  if (isFreeProModel(model)) {
    return {
      model: provider.freeChatModel(FREE_PRO_MODEL_NAME, {
        providerId: model.provider,
      }),
      builtinProviderId: model.provider,
    };
  }

  if (
    settings.selectedChatMode === "local-agent" &&
    model.provider === "auto" &&
    model.name === "auto"
  ) {
    const providers = await getLanguageModelProviders();
    const fallbackModels = await Promise.all(
      AUTO_DYAD_PRO_MODEL_ALIASES.map(async (aliasId) => {
        const resolved = await resolveBuiltinModelAlias(aliasId);
        if (!resolved || resolved.apiName.endsWith(":free")) return null;
        const resolvedProvider = providers.find((p) => p.id === resolved.providerId);
        const resolvedModelId = `${resolvedProvider?.gatewayPrefix || ""}${resolved.apiName}`;
        if (resolved.providerId === "openai") {
          return provider.responses(resolved.apiName, {
            providerId: resolved.providerId,
          });
        }
        if (resolved.providerId === "anthropic") {
          return provider.anthropic(resolvedModelId, {
            providerId: resolved.providerId,
          });
        }
        return provider(resolvedModelId, { providerId: resolved.providerId });
      }),
    );
    const validModels = fallbackModels.filter(
      (candidate): candidate is LanguageModel => candidate !== null,
    );
    if (validModels.length === 0) {
      throw new DyadError(
        "No hosted auto models could be resolved",
        DyadErrorKind.External,
      );
    }
    return {
      model: createFallback({ models: validModels }),
      builtinProviderId: "openai",
    };
  }

  if (settings.selectedChatMode === "local-agent" && model.provider === "openai") {
    return {
      model: provider.responses(modelId, { providerId: model.provider }),
      builtinProviderId: model.provider,
    };
  }
  if (model.provider === "anthropic") {
    return {
      model: provider.anthropic(modelId, { providerId: model.provider }),
      builtinProviderId: model.provider,
    };
  }
  return {
    model: provider(modelId, { providerId: model.provider }),
    builtinProviderId: model.provider,
  };
}

function getRegularModelClient(
  model: LargeLanguageModel,
  settings: UserSettings,
  providerConfig: LanguageModelProvider,
): {
  modelClient: ModelClient;
  backupModelClients: ModelClient[];
} {
  const providerId = providerConfig.id;
  // Get API key for the specific provider. Azure is handled in its own branch
  // because it has additional config and test-mode bypass behavior.
  const apiKey =
    providerId === "azure"
      ? undefined
      : getProviderApiKeyForRequest(
          settings.providerSettings?.[model.provider]?.apiKey?.value ||
            (providerConfig.envVarName
              ? getEnvVar(providerConfig.envVarName)
              : undefined),
          providerConfig.name ?? providerConfig.id,
        );
  // Create client based on provider ID or type
  switch (providerId) {
    case "openai": {
      const provider = createOpenAI({
        apiKey,
        ...getModelClientFetchOption(),
      });
      return {
        modelClient: {
          model: provider.responses(model.name),
          builtinProviderId: providerId,
        },
        backupModelClients: [],
      };
    }
    case "anthropic": {
      const provider = createAnthropic({
        apiKey,
        ...getModelClientFetchOption(),
      });
      return {
        modelClient: {
          model: provider(model.name),
          builtinProviderId: providerId,
        },
        backupModelClients: [],
      };
    }
    case "xai": {
      const provider = createXai({
        apiKey,
        ...getModelClientFetchOption(),
      });
      return {
        modelClient: {
          model: provider(model.name),
          builtinProviderId: providerId,
        },
        backupModelClients: [],
      };
    }
    case "google": {
      const provider = createGoogle({
        apiKey,
        ...getModelClientFetchOption(),
      });
      return {
        modelClient: {
          model: provider(model.name),
          builtinProviderId: providerId,
        },
        backupModelClients: [],
      };
    }
    case "vertex": {
      // Vertex uses Google service account credentials with project/location
      const vertexSettings = settings.providerSettings?.[
        model.provider
      ] as VertexProviderSetting;
      const project = vertexSettings?.projectId;
      const location = vertexSettings?.location;
      const serviceAccountKey = vertexSettings?.serviceAccountKey?.value;

      // Use a baseURL that does NOT pin to publishers/google so that
      // full publisher model IDs (e.g. publishers/deepseek-ai/models/...) work.
      const regionHost = `${location === "global" ? "" : `${location}-`}aiplatform.googleapis.com`;
      const baseURL = `https://${regionHost}/v1/projects/${project}/locations/${location}`;
      const provider = createGoogleVertex({
        project,
        location,
        baseURL,
        ...getModelClientFetchOption(),
        googleAuthOptions: serviceAccountKey
          ? {
              // Expecting the user to paste the full JSON of the service account key
              credentials: JSON.parse(serviceAccountKey),
            }
          : undefined,
      });
      return {
        modelClient: {
          // For built-in Google models on Vertex, the path must include
          // publishers/google/models/<model>. For partner MaaS models the
          // full publisher path is already included.
          model: provider(
            model.name.includes("/")
              ? model.name
              : `publishers/google/models/${model.name}`,
          ),
          builtinProviderId: providerId,
        },
        backupModelClients: [],
      };
    }
    case "openrouter": {
      const provider = createOpenAICompatible({
        name: "openrouter",
        baseURL: "https://openrouter.ai/api/v1",
        apiKey,
        headers: getOpenRouterAppAttributionHeaders(),
        ...getModelClientFetchOption(),
      });
      return {
        modelClient: {
          model: provider(model.name),
          builtinProviderId: providerId,
        },
        backupModelClients: [],
      };
    }
    case "azure": {
      // Check if we're in e2e testing mode
      const testAzureBaseUrl = getEnvVar("TEST_AZURE_BASE_URL");

      if (testAzureBaseUrl) {
        // Use fake server for e2e testing
        logger.info(`Using test Azure base URL: ${testAzureBaseUrl}`);
        const provider = createOpenAICompatible({
          name: "azure-test",
          baseURL: testAzureBaseUrl,
          apiKey: "fake-api-key-for-testing",
          ...getModelClientFetchOption(),
        });
        return {
          modelClient: {
            model: provider(model.name),
            builtinProviderId: providerId,
          },
          backupModelClients: [],
        };
      }

      const azureSettings = settings.providerSettings?.azure as
        | AzureProviderSetting
        | undefined;
      const azureApiKeyFromSettings = normalizeProviderApiKeyInput(
        azureSettings?.apiKey?.value,
      );
      const azureResourceNameFromSettings = (
        azureSettings?.resourceName ?? ""
      ).trim();
      const envResourceName = (getEnvVar("AZURE_RESOURCE_NAME") ?? "").trim();
      const envAzureApiKey = normalizeProviderApiKeyInput(
        getEnvVar("AZURE_API_KEY"),
      );

      const resourceName = azureResourceNameFromSettings || envResourceName;
      const azureApiKey = getProviderApiKeyForRequest(
        azureApiKeyFromSettings || envAzureApiKey,
        providerConfig.name ?? providerConfig.id,
      );

      if (!resourceName) {
        throw new Error(
          "Azure OpenAI resource name is required. Provide it in Settings or set the AZURE_RESOURCE_NAME environment variable.",
        );
      }

      if (!azureApiKey) {
        throw new Error(
          "Azure OpenAI API key is required. Provide it in Settings or set the AZURE_API_KEY environment variable.",
        );
      }

      const provider = createAzure({
        resourceName,
        apiKey: azureApiKey,
        ...getModelClientFetchOption(),
      });

      return {
        modelClient: {
          model: provider(model.name),
          builtinProviderId: providerId,
        },
        backupModelClients: [],
      };
    }
    case "ollama": {
      const provider = createOllamaProvider({
        baseURL: getOllamaApiUrl(),
        ...getModelClientFetchOption(),
      });
      return {
        modelClient: {
          model: provider(model.name),
          builtinProviderId: providerId,
        },
        backupModelClients: [],
      };
    }
    case "lmstudio": {
      // LM Studio uses OpenAI compatible API
      const baseURL = providerConfig.apiBaseUrl || getLmStudioBaseUrl() + "/v1";
      const provider = createOpenAICompatible({
        name: "lmstudio",
        baseURL,
        ...getModelClientFetchOption(),
      });
      return {
        modelClient: {
          model: provider(model.name),
        },
        backupModelClients: [],
      };
    }
    case "bedrock": {
      // AWS Bedrock supports API key authentication using AWS_BEARER_TOKEN_BEDROCK
      // See: https://sdk.vercel.ai/providers/ai-sdk-providers/amazon-bedrock#api-key-authentication
      const provider = createAmazonBedrock({
        apiKey: apiKey,
        region: getEnvVar("AWS_REGION") || "us-east-1",
        ...getModelClientFetchOption(),
      });
      return {
        modelClient: {
          model: provider(model.name),
          builtinProviderId: providerId,
        },
        backupModelClients: [],
      };
    }
    case "minimax": {
      const provider = createOpenAICompatible({
        name: "minimax",
        baseURL: "https://api.minimax.io/v1",
        apiKey,
        ...getModelClientFetchOption(),
      });
      return {
        modelClient: {
          model: provider(model.name),
          builtinProviderId: providerId,
        },
        backupModelClients: [],
      };
    }
    case "opencode": {
      // OpenCode gateway — OpenAI-compatible endpoint. Models like
      // mimo-v2.5 / kimi-k3 / deepseek-v4-pro route through this.
      const provider = createOpenAICompatible({
        name: "opencode",
        baseURL: "https://opencode.ai/zen/go/v1",
        apiKey,
        ...getModelClientFetchOption(),
      });
      return {
        modelClient: {
          model: provider(model.name),
          builtinProviderId: providerId,
        },
        backupModelClients: [],
      };
    }
    case "kilocode": {
      // Kilo gateway — OpenAI-compatible endpoint. Free-tier models like
      // kilo-auto/free and kilocode/default route through this.
      const provider = createOpenAICompatible({
        name: "kilocode",
        baseURL: KILOCODE_GATEWAY_BASE_URL,
        apiKey,
        ...getModelClientFetchOption(),
      });
      return {
        modelClient: {
          model: provider(model.name),
          builtinProviderId: providerId,
        },
        backupModelClients: [],
      };
    }
    default: {
      // Handle custom providers
      if (providerConfig.type === "custom") {
        if (!providerConfig.apiBaseUrl) {
          throw new Error(
            `Custom provider ${model.provider} is missing the API Base URL.`,
          );
        }
        // Assume custom providers are OpenAI compatible for now
        const provider = createOpenAICompatible({
          name: providerConfig.id,
          baseURL: providerConfig.apiBaseUrl,
          apiKey,
          ...getModelClientFetchOption(),
        });
        return {
          modelClient: {
            model: provider(model.name),
          },
          backupModelClients: [],
        };
      }
      // If it's not a known ID and not type 'custom', it's unsupported
      throw new DyadError(
        `Unsupported model provider: ${model.provider}`,
        DyadErrorKind.Validation,
      );
    }
  }
}

function getProviderApiKeyForRequest(
  value: string | null | undefined,
  providerDisplayName: string,
): string | undefined {
  const normalizedValue = normalizeProviderApiKeyInput(value);
  if (!normalizedValue) {
    return undefined;
  }
  const invalidCharacter = findInvalidProviderApiKeyCharacter(normalizedValue);
  if (invalidCharacter) {
    throw new DyadError(
      formatInvalidProviderApiKeyMessage(providerDisplayName, invalidCharacter),
      DyadErrorKind.Validation,
    );
  }
  return normalizedValue;
}
