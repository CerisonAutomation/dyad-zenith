import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAutoDiscoverModels } from "@/hooks/useAutoDiscoverModels";
import { useLocalLMSModels } from "@/hooks/useLMStudioModels";
import { useLanguageModelsByProviders } from "@/hooks/useLanguageModelsByProviders";
import { useLocalModels } from "@/hooks/useLocalModels";
import { type LargeLanguageModel, isDyadProEnabled } from "@/lib/schemas";
import { useNavigate } from "@tanstack/react-router";
import { usePostHog } from "posthog-js/react";
import { type ReactNode, useEffect, useMemo, useState } from "react";

import { PriceBadge } from "@/components/PriceBadge";
import { ProviderIcon } from "@/components/ProviderIcon";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useChatMode } from "@/hooks/useChatMode";
import { useFreeModelQuota } from "@/hooks/useFreeModelQuota";
import { useLanguageModelProviders } from "@/hooks/useLanguageModelProviders";
import { useSettings } from "@/hooks/useSettings";
import { useTrialModelRestriction } from "@/hooks/useTrialModelRestriction";
import { isModelKnownUnavailable } from "@/ipc/shared/language_model_constants";
import type {
  LanguageModel,
  LanguageModelProvider,
  LocalModel,
} from "@/ipc/types";
import {
  FREE_PRO_MODEL_FALLBACK_CHAT_MODE,
  isFreeProBuildModeCombination,
  isFreeProLanguageModel,
  isFreeProModel,
} from "@/lib/freeProModel";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { providerSettingsRoute } from "@/routes/settings/providers/$provider";
import { useQueryClient } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import { CheckIcon, CircleOffIcon, LockIcon } from "lucide-react";

const SCROLL_AREA_CLASS = "max-h-100 overflow-y-auto scrollbar-on-hover";

const PILL_CLASS =
  "text-[10px] leading-none px-1.5 py-1 rounded-full font-medium";

const isFreeOpenRouterModelName = (apiName: string) =>
  apiName.endsWith(":free") || apiName.endsWith("/free");

export function ModelPicker() {
  const { settings, updateSettings, loading: settingsLoading } = useSettings();
  const routerState = useRouterState();
  const isChatRoute = routerState.location.pathname === "/chat";
  const chatId = routerState.location.search.id as number | undefined;
  const { selectedMode, setChatMode } = useChatMode(
    isChatRoute ? chatId : null,
  );
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const posthog = usePostHog();
  const { isTrial } = useTrialModelRestriction();
  const freeModelQuota = useFreeModelQuota();
  const onModelSelect = async (model: LargeLanguageModel) => {
    posthog.capture("model-picker:select", {
      provider: model.provider,
      model: model.name,
    });
    if (isFreeProBuildModeCombination(model, selectedMode)) {
      await setChatMode(FREE_PRO_MODEL_FALLBACK_CHAT_MODE);
    }

    updateSettings({
      selectedModel: model,
      ...(isFreeProModel(model) && settings?.defaultChatMode === "build"
        ? { defaultChatMode: FREE_PRO_MODEL_FALLBACK_CHAT_MODE }
        : {}),
    });
    // Invalidate token count when model changes since different models have different context windows
    // (technically they have different tokenizers, but we don't keep track of that).
    queryClient.invalidateQueries({ queryKey: queryKeys.tokenCount.all });
  };

  const [open, setOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [unlockTarget, setUnlockTarget] = useState<{
    providerId: string;
    model: LanguageModel;
  } | null>(null);

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen) {
      setSearchQuery("");
      posthog.capture("model-picker:open", {
        isDyadPro: settings ? isDyadProEnabled(settings) : false,
      });
    }
  };

  // Cloud models from providers
  const { data: modelsByProviders, isLoading: modelsByProvidersLoading } =
    useLanguageModelsByProviders();

  // Auto-discover models from provider APIs
  const { data: autoDiscoveredModels, isLoading: autoDiscoverLoading } =
    useAutoDiscoverModels();

  const {
    data: providers,
    isLoading: providersLoading,
    isProviderSetup,
  } = useLanguageModelProviders();

  // Build a map for O(1) provider lookups (avoids repeated .find() in loops)
  const providerMap = useMemo(() => {
    if (!providers) return new Map<string, LanguageModelProvider>();
    return new Map(providers.map((p) => [p.id, p]));
  }, [providers]);

  // Merge auto-discovered models with catalog models
  const effectiveModelsByProviders = useMemo(() => {
    if (modelsByProviders && autoDiscoveredModels) {
      const merged = { ...modelsByProviders };
      for (const [providerId, apiModels] of Object.entries(
        autoDiscoveredModels,
      )) {
        const existingModels = merged[providerId] || [];
        const existingApiNames = new Set(existingModels.map((m) => m.apiName));
        const newModels = apiModels.filter(
          (m) => !existingApiNames.has(m.apiName),
        );
        if (newModels.length > 0) {
          merged[providerId] = [...existingModels, ...newModels];
        }
      }
      return merged;
    }
    return modelsByProviders ?? autoDiscoveredModels ?? undefined;
  }, [modelsByProviders, autoDiscoveredModels]);

  const loading =
    modelsByProvidersLoading || providersLoading || autoDiscoverLoading;
  const dyadProEnabled = settings ? isDyadProEnabled(settings) : false;
  // Ollama Models Hook
  const {
    models: ollamaModels,
    loading: ollamaLoading,
    error: ollamaError,
    loadModels: loadOllamaModels,
  } = useLocalModels();

  // LM Studio Models Hook
  const {
    models: lmStudioModels,
    loading: lmStudioLoading,
    error: lmStudioError,
    loadModels: loadLMStudioModels,
  } = useLocalLMSModels();

  // Load models when the dropdown opens
  useEffect(() => {
    if (open) {
      loadOllamaModels();
      loadLMStudioModels();
    }
  }, [open, loadOllamaModels, loadLMStudioModels]);

  // Get display name for the selected model
  const getModelDisplayName = () => {
    if (selectedModel.provider === "ollama") {
      return (
        ollamaModels.find(
          (model: LocalModel) => model.modelName === selectedModel.name,
        )?.displayName || selectedModel.name
      );
    }
    if (selectedModel.provider === "lmstudio") {
      return (
        lmStudioModels.find(
          (model: LocalModel) => model.modelName === selectedModel.name,
        )?.displayName || selectedModel.name // Fallback to path if not found
      );
    }

    // For cloud models, look up in the effectiveModelsByProviders data
    if (
      effectiveModelsByProviders &&
      effectiveModelsByProviders[selectedModel.provider]
    ) {
      const customFoundModel = effectiveModelsByProviders[
        selectedModel.provider
      ].find(
        (model) =>
          model.type === "custom" && model.id === selectedModel.customModelId,
      );
      if (customFoundModel) {
        return customFoundModel.displayName;
      }
      const foundModel = effectiveModelsByProviders[
        selectedModel.provider
      ].find((model) => model.apiName === selectedModel.name);
      if (foundModel) {
        return foundModel.displayName;
      }
    }

    // Fallback if not found
    return selectedModel.name;
  };

  // Determine availability of local models
  const hasOllamaModels =
    !ollamaLoading && !ollamaError && ollamaModels.length > 0;
  const hasLMStudioModels =
    !lmStudioLoading && !lmStudioError && lmStudioModels.length > 0;

  if (!settings) {
    return null;
  }
  const selectedModel = settings?.selectedModel;
  const modelDisplayName = getModelDisplayName();
  // Split providers into primary and secondary groups
  const providerEntries =
    !loading && effectiveModelsByProviders
      ? Object.entries(effectiveModelsByProviders)
      : [];
  const primaryProviderEntries = providerEntries.filter(
    ([providerId, models]) => {
      if (models.length === 0) return false;
      const provider = providerMap.get(providerId);
      return !(provider && provider.secondary);
    },
  );
  const primaryProviders: [string, LanguageModel[]][] = primaryProviderEntries;
  const secondaryProviders = providerEntries.filter(([providerId, models]) => {
    if (models.length === 0) return false;
    const provider = providerMap.get(providerId);
    return !!(provider && provider.secondary);
  });
  const groupedProviders: [string, LanguageModel[]][] = [
    ...primaryProviders,
    ...secondaryProviders,
  ];

  const getProviderDisplayName = (providerId: string) => {
    const provider = providerMap.get(providerId);
    return provider?.name ?? providerId;
  };

  // Jan-style live search: filter every provider's models by the query.
  // When a search is active, we show a flat "Search results" list instead
  // of the grouped provider sections.
  const normalizedQuery = searchQuery.trim().toLowerCase();
  const isSearching = normalizedQuery.length > 0;
  const searchResults: { providerId: string; model: LanguageModel }[] =
    isSearching
      ? groupedProviders.flatMap(([providerId, models]) =>
          models
            .filter((model) => {
              const providerName = (
                getProviderDisplayName(providerId) ?? ""
              ).toLowerCase();
              return (
                model.apiName.toLowerCase().includes(normalizedQuery) ||
                (model.displayName ?? "")
                  .toLowerCase()
                  .includes(normalizedQuery) ||
                providerName.includes(normalizedQuery)
              );
            })
            .map((model) => ({ providerId, model })),
        )
      : [];

  // Non-Pro users can still use any cloud model with their own API key, so a
  // model is only locked when neither Dyad Pro nor a provider key can run it.
  // Custom and local providers are never locked: Pro doesn't unlock those.
  // While settings/env vars are still loading we can't tell whether a key
  // exists, so fail open rather than flash a lock at env-var-configured users.
  const isModelLocked = (providerId: string) => {
    if (settingsLoading || dyadProEnabled) {
      return false;
    }
    const provider = providerMap.get(providerId);
    return provider?.type === "cloud" && !isProviderSetup(providerId);
  };

  const handleLockedModelClick = (providerId: string, model: LanguageModel) => {
    posthog.capture("model-picker:locked-model-click", {
      provider: providerId,
      model: model.apiName,
    });
    setOpen(false);
    setUnlockTarget({ providerId, model });
  };

  const handleUnlockDialogOwnKeyClick = () => {
    if (!unlockTarget) {
      return;
    }
    posthog.capture("model-picker:add-own-key-click", {
      provider: unlockTarget.providerId,
    });
    const providerId = unlockTarget.providerId;
    setUnlockTarget(null);
    navigate({
      to: providerSettingsRoute.id,
      params: { provider: providerId },
    });
  };

  const unlockTargetIsFreeModel = unlockTarget
    ? isFreeOpenRouterModelName(unlockTarget.model.apiName)
    : false;
  const unlockTargetProviderName = unlockTarget
    ? getProviderDisplayName(unlockTarget.providerId)
    : "";

  const handleCloudModelSelect = (providerId: string, model: LanguageModel) => {
    if (isModelLocked(providerId)) {
      handleLockedModelClick(providerId, model);
      return;
    }
    if (
      isFreeProLanguageModel(providerId, model.apiName) &&
      freeModelQuota.isQuotaExceeded
    ) {
      return;
    }

    const customModelId = model.type === "custom" ? model.id : undefined;
    void onModelSelect({
      name: model.apiName,
      provider: providerId,
      customModelId,
    });
    setOpen(false);
  };

  const renderCloudModelItem = ({
    providerId,
    model,
    showProvider = false,
    showPrice = true,
    label,
  }: {
    providerId: string;
    model: LanguageModel;
    showProvider?: boolean;
    showPrice?: boolean;
    label?: string;
  }) => {
    const isSelected =
      selectedModel.provider === providerId &&
      selectedModel.name === model.apiName;
    const isLocked = isModelLocked(providerId);
    const isFreeProRow = isFreeProLanguageModel(providerId, model.apiName);
    const isFreeProviderRow = isFreeOpenRouterModelName(model.apiName);
    const isUnavailable = isModelKnownUnavailable(model.apiName);
    const shouldShowDataSharingDisclosure = isFreeProRow || isFreeProviderRow;
    const freeProResetTimeLabel = freeModelQuota.resetTime
      ? new Intl.DateTimeFormat(undefined, {
          hour: "numeric",
          minute: "2-digit",
          timeZoneName: "short",
        }).format(new Date(freeModelQuota.resetTime))
      : null;
    const freeProQuotaLabel =
      freeModelQuota.isLoading && !freeModelQuota.quotaStatus
        ? "Loading"
        : freeModelQuota.error
          ? "Unavailable"
          : `${freeModelQuota.messagesRemaining}/${freeModelQuota.messagesLimit} left`;

    const item = (
      <DropdownMenuItem
        key={`${providerId}-${model.apiName}`}
        data-locked={isLocked || undefined}
        aria-label={
          isLocked
            ? isFreeProviderRow
              ? `${model.displayName} — requires an API key from ${getProviderDisplayName(providerId)}`
              : `${model.displayName} — requires Dyad Pro or an API key from ${getProviderDisplayName(providerId)}`
            : undefined
        }
        disabled={isFreeProRow && freeModelQuota.isQuotaExceeded}
        className={cn(
          "relative px-2 py-1.5",
          isFreeProRow &&
            freeModelQuota.isQuotaExceeded &&
            "opacity-60 cursor-default",
          isSelected &&
            "bg-primary/8 before:absolute before:inset-y-1.5 before:left-0 before:w-[3px] before:rounded-r-full before:bg-primary",
        )}
        onClick={() => {
          handleCloudModelSelect(providerId, model);
        }}
      >
        <div className="flex justify-between items-center gap-2 w-full">
          <span className="min-w-0 flex items-center gap-2">
            <ProviderIcon providerId={providerId} apiName={model.apiName} />
            <span className="min-w-0 flex flex-col items-start">
              <span
                className={cn(
                  "text-[13px] truncate leading-tight",
                  isLocked && "text-muted-foreground",
                )}
              >
                {label ?? model.displayName}
              </span>
              {showProvider && (
                <span className="text-xs text-muted-foreground truncate">
                  {getProviderDisplayName(providerId)}
                </span>
              )}
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-1.5">
            {showPrice && <PriceBadge dollarSigns={model.dollarSigns} />}
            {model.tag && !isFreeProRow && (
              <span
                className={cn(
                  PILL_CLASS,
                  "bg-primary/10 text-primary",
                  model.tagColor,
                )}
              >
                {model.tag}
              </span>
            )}
            {isLocked && (
              <LockIcon className="size-3.5 text-muted-foreground shrink-0" />
            )}
            {isUnavailable && (
              <span
                className={cn(
                  PILL_CLASS,
                  "bg-amber-500/15 text-amber-700 dark:text-amber-300 gap-1",
                )}
                title="Upstream provider temporarily unavailable — auto-fallback will pick a working model"
              >
                <CircleOffIcon className="size-3" />
                down
              </span>
            )}
            {isSelected && (
              <CheckIcon className="size-3.5 text-primary shrink-0" />
            )}
            {isFreeProRow && (
              <span
                className={cn(
                  PILL_CLASS,
                  freeModelQuota.isQuotaExceeded
                    ? "bg-destructive/10 text-destructive"
                    : "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
                )}
                title={
                  freeProResetTimeLabel
                    ? `Resets at ${freeProResetTimeLabel}`
                    : undefined
                }
              >
                {freeProQuotaLabel}
              </span>
            )}
            {shouldShowDataSharingDisclosure && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span
                      className={cn(
                        PILL_CLASS,
                        "bg-amber-500/15 text-amber-700 dark:text-amber-300",
                      )}
                    >
                      Data sharing
                    </span>
                  }
                />
                <TooltipContent side="right" align="start">
                  Data may be shared with the AI provider and used for training
                  models.
                </TooltipContent>
              </Tooltip>
            )}
          </span>
        </div>
      </DropdownMenuItem>
    );

    if (!model.description) {
      return item;
    }

    return (
      <Tooltip key={`${providerId}-${model.apiName}`}>
        <TooltipTrigger render={item} />
        <TooltipContent side="right" align="start">
          <span className="max-w-64">{model.description}</span>
        </TooltipContent>
      </Tooltip>
    );
  };

  return (
    <>
      <DropdownMenu open={open} onOpenChange={handleOpenChange}>
        <DropdownMenuTrigger
          className="inline-flex items-center justify-center whitespace-nowrap rounded-lg text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 border-none bg-transparent shadow-none text-foreground/80 hover:text-foreground hover:bg-muted/60 h-7 max-w-[130px] px-2 gap-1.5 cursor-pointer"
          data-testid="model-picker"
          title={modelDisplayName}
        >
          <span className="truncate">{modelDisplayName}</span>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-[17rem]" align="start">
          {/* Jan-style model search */}
          {!isTrial && (
            <div className="px-2 pt-1.5 pb-1">
              <input
                autoFocus
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search models…"
                className="w-full rounded-md border border-border bg-muted/40 px-2.5 py-1.5 text-xs text-foreground placeholder:text-muted-foreground outline-none focus:border-ring focus:ring-1 focus:ring-ring"
                data-testid="model-search-input"
              />
            </div>
          )}
          {/* Cloud models */}
          {!isTrial &&
            (loading ? (
              <div className="text-xs text-center py-2 text-muted-foreground">
                Loading models...
              </div>
            ) : !effectiveModelsByProviders ||
              Object.keys(effectiveModelsByProviders).length === 0 ? (
              <div className="text-xs text-center py-2 text-muted-foreground">
                No cloud models available
              </div>
            ) : isSearching ? (
              /* Search results — flat list across providers */
              searchResults.length === 0 ? (
                <div className="text-xs text-center py-2 text-muted-foreground">
                  No models match “{searchQuery.trim()}”
                </div>
              ) : (
                <div className={cn(SCROLL_AREA_CLASS)}>
                  {searchResults.map(({ providerId, model }) =>
                    renderCloudModelItem({
                      providerId,
                      model,
                      label: `${model.displayName || model.apiName} · ${getProviderDisplayName(providerId)}`,
                    }),
                  )}
                </div>
              )
            ) : (
              /* Cloud models loaded */
              <>
                {(() => {
                  const nodes: ReactNode[] = [];
                  let prevWasProvider = false;

                  groupedProviders.forEach(([providerId, models], _i) => {
                    const visibleModels = models.filter((model) => {
                      if (
                        dyadProEnabled &&
                        isFreeOpenRouterModelName(model.apiName)
                      ) {
                        return false;
                      }
                      return true;
                    });

                    if (visibleModels.length === 0) return;

                    const provider = providerMap.get(providerId);
                    const providerDisplayName =
                      getProviderDisplayName(providerId);

                    // Add separator between providers
                    if (prevWasProvider) {
                      nodes.push(
                        <DropdownMenuSeparator key={`sep-${providerId}`} />,
                      );
                    }

                    // Provider header
                    nodes.push(
                      <div
                        key={`provider-header-${providerId}`}
                        className="flex items-center gap-1.5 px-2 pt-1.5 pb-1"
                      >
                        <span className="text-[10px] uppercase tracking-wider font-medium text-muted-foreground shrink-0">
                          {providerDisplayName}
                        </span>
                        {provider?.type === "custom" && (
                          <span
                            className={cn(
                              PILL_CLASS,
                              "bg-amber-500 text-white",
                            )}
                          >
                            Custom
                          </span>
                        )}
                        <span className="text-[11px] text-muted-foreground/85">
                          {visibleModels.length} models
                        </span>
                      </div>,
                    );

                    // Models under this provider
                    visibleModels.forEach((model) => {
                      nodes.push(renderCloudModelItem({ providerId, model }));
                    });

                    prevWasProvider = true;
                  });

                  return nodes;
                })()}
              </>
            ))}

          {/* Local Models - only show for non-trial users */}
          {!isTrial && (
            <>
              <DropdownMenuSeparator />
              {/* Local Models Parent SubMenu */}
              <DropdownMenuSub>
                <DropdownMenuSubTrigger className="w-full font-normal">
                  <span>Local models</span>
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-64">
                  {/* Ollama Models SubMenu */}
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger
                      disabled={ollamaLoading && !hasOllamaModels} // Disable if loading and no models yet
                      className="w-full font-normal"
                    >
                      <div className="flex flex-col items-start">
                        <span>Ollama</span>
                        {ollamaLoading ? (
                          <span className="text-xs text-muted-foreground">
                            Loading...
                          </span>
                        ) : ollamaError ? (
                          <span className="text-xs text-red-500">
                            Error loading
                          </span>
                        ) : !hasOllamaModels ? (
                          <span className="text-xs text-muted-foreground">
                            None available
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            {ollamaModels.length} models
                          </span>
                        )}
                      </div>
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent
                      className={cn("w-64", SCROLL_AREA_CLASS)}
                    >
                      <DropdownMenuLabel>Ollama Models</DropdownMenuLabel>
                      <DropdownMenuSeparator />

                      {ollamaLoading && ollamaModels.length === 0 ? ( // Show loading only if no models are loaded yet
                        <div className="text-xs text-center py-2 text-muted-foreground">
                          Loading models...
                        </div>
                      ) : ollamaError ? (
                        <div className="px-2 py-1.5 text-sm text-red-600">
                          <div className="flex flex-col">
                            <span>Error loading models</span>
                            <span className="text-xs text-muted-foreground">
                              Is Ollama running?
                            </span>
                          </div>
                        </div>
                      ) : !hasOllamaModels ? (
                        <div className="px-2 py-1.5 text-sm">
                          <div className="flex flex-col">
                            <span>No local models found</span>
                            <span className="text-xs text-muted-foreground">
                              Ensure Ollama is running and models are pulled.
                            </span>
                          </div>
                        </div>
                      ) : (
                        ollamaModels.map((model: LocalModel) => {
                          const isSelected =
                            selectedModel.provider === "ollama" &&
                            selectedModel.name === model.modelName;
                          return (
                            <DropdownMenuItem
                              key={`ollama-${model.modelName}`}
                              className={cn(
                                "relative py-1.5",
                                isSelected &&
                                  "bg-primary/8 before:absolute before:inset-y-1.5 before:left-0 before:w-[3px] before:rounded-r-full before:bg-primary",
                              )}
                              onClick={() => {
                                void onModelSelect({
                                  name: model.modelName,
                                  provider: "ollama",
                                });
                                setOpen(false);
                              }}
                            >
                              <div className="flex w-full items-center gap-2">
                                <ProviderIcon providerId="ollama" />
                                <div className="min-w-0 flex flex-col">
                                  <span className="text-[13px] leading-tight">
                                    {model.displayName}
                                  </span>
                                  <span className="text-xs text-muted-foreground truncate">
                                    {model.modelName}
                                  </span>
                                </div>
                                {isSelected && (
                                  <CheckIcon className="ml-auto size-3.5 text-primary shrink-0" />
                                )}
                              </div>
                            </DropdownMenuItem>
                          );
                        })
                      )}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>

                  {/* LM Studio Models SubMenu */}
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger
                      disabled={lmStudioLoading && !hasLMStudioModels} // Disable if loading and no models yet
                      className="w-full font-normal"
                    >
                      <div className="flex flex-col items-start">
                        <span>LM Studio</span>
                        {lmStudioLoading ? (
                          <span className="text-xs text-muted-foreground">
                            Loading...
                          </span>
                        ) : lmStudioError ? (
                          <span className="text-xs text-red-500">
                            Error loading
                          </span>
                        ) : !hasLMStudioModels ? (
                          <span className="text-xs text-muted-foreground">
                            None available
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            {lmStudioModels.length} models
                          </span>
                        )}
                      </div>
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent
                      className={cn("w-64", SCROLL_AREA_CLASS)}
                    >
                      <DropdownMenuLabel>LM Studio Models</DropdownMenuLabel>
                      <DropdownMenuSeparator />

                      {lmStudioLoading && lmStudioModels.length === 0 ? ( // Show loading only if no models are loaded yet
                        <div className="text-xs text-center py-2 text-muted-foreground">
                          Loading models...
                        </div>
                      ) : lmStudioError ? (
                        <div className="px-2 py-1.5 text-sm text-red-600">
                          <div className="flex flex-col">
                            <span>Error loading models</span>
                            <span className="text-xs text-muted-foreground">
                              {lmStudioError.message}{" "}
                              {/* Display specific error */}
                            </span>
                          </div>
                        </div>
                      ) : !hasLMStudioModels ? (
                        <div className="px-2 py-1.5 text-sm">
                          <div className="flex flex-col">
                            <span>No loaded models found</span>
                            <span className="text-xs text-muted-foreground">
                              Ensure LM Studio is running and models are loaded.
                            </span>
                          </div>
                        </div>
                      ) : (
                        lmStudioModels.map((model: LocalModel) => {
                          const isSelected =
                            selectedModel.provider === "lmstudio" &&
                            selectedModel.name === model.modelName;
                          return (
                            <DropdownMenuItem
                              key={`lmstudio-${model.modelName}`}
                              className={cn(
                                "relative py-1.5",
                                isSelected &&
                                  "bg-primary/8 before:absolute before:inset-y-1.5 before:left-0 before:w-[3px] before:rounded-r-full before:bg-primary",
                              )}
                              onClick={() => {
                                void onModelSelect({
                                  name: model.modelName,
                                  provider: "lmstudio",
                                });
                                setOpen(false);
                              }}
                            >
                              <div className="flex w-full items-center gap-2">
                                <ProviderIcon providerId="lmstudio" />
                                <div className="min-w-0 flex flex-col">
                                  <span className="text-[13px] leading-tight">
                                    {model.displayName}
                                  </span>
                                  <span className="text-xs text-muted-foreground truncate">
                                    {model.modelName}
                                  </span>
                                </div>
                                {isSelected && (
                                  <CheckIcon className="ml-auto size-3.5 text-primary shrink-0" />
                                )}
                              </div>
                            </DropdownMenuItem>
                          );
                        })
                      )}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Unlock dialog for locked models */}
      <Dialog
        open={unlockTarget !== null}
        onOpenChange={(dialogOpen) => {
          if (!dialogOpen) {
            setUnlockTarget(null);
          }
        }}
      >
        <DialogContent
          className="sm:max-w-md"
          data-testid="unlock-model-dialog"
        >
          {/* Free models aren't a Pro feature, so don't sell Pro for them —
              they just need the user's own (free) provider API key. */}
          {unlockTargetIsFreeModel ? (
            <>
              <DialogHeader>
                <DialogTitle>
                  Use {unlockTarget?.model.displayName} with your own{" "}
                  {unlockTargetProviderName} API key
                </DialogTitle>
                <DialogDescription>
                  Free models run through your own {unlockTargetProviderName}{" "}
                  account. Add an API key in provider settings to use this
                  model.
                </DialogDescription>
              </DialogHeader>
              <Button
                className="cursor-pointer w-full"
                onClick={handleUnlockDialogOwnKeyClick}
              >
                Add {unlockTargetProviderName} API key
              </Button>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>
                  Use {unlockTarget?.model.displayName} with your own{" "}
                  {unlockTargetProviderName} API key
                </DialogTitle>
                <DialogDescription>
                  Add an API key in provider settings to use this model.
                </DialogDescription>
              </DialogHeader>
              <Button
                className="cursor-pointer w-full"
                onClick={handleUnlockDialogOwnKeyClick}
              >
                Add {unlockTargetProviderName} API key
              </Button>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
