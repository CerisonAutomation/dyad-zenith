import { useState } from "react";
import { useAtom } from "jotai";
import { ChevronDownIcon, CheckIcon } from "lucide-react";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@/components/ui/popover";
import {
  MODEL_OPTIONS,
  CLOUD_PROVIDERS,
  type ModelOption,
} from "@/ipc/shared/language_model_constants";
import { useSettings } from "@/hooks/useSettings";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { chatModelOverrideAtom } from "@/atoms/chatAtoms";
import type { LargeLanguageModel } from "@/lib/schemas";

interface ModelSelectorProps {
  chatId?: number;
  disabled?: boolean;
}

export function ModelSelector({ chatId, disabled }: ModelSelectorProps) {
  const [open, setOpen] = useState(false);
  const { settings, updateSettings } = useSettings();
  const queryClient = useQueryClient();
  const [overrides, setOverrides] = useAtom(chatModelOverrideAtom);

  const selectedModel = settings?.selectedModel;
  const override = chatId ? overrides.get(chatId) : undefined;
  const activeModel = override ?? selectedModel;

  // Get display name for the active model
  const getDisplayName = (): string => {
    if (!activeModel) return "Select model";
    const providerModels = MODEL_OPTIONS[activeModel.provider];
    if (providerModels) {
      const match = providerModels.find((m) => m.name === activeModel.name);
      if (match) return match.displayName;
    }
    return activeModel.name;
  };

  const handleSelect = (providerId: string, model: ModelOption) => {
    const newModel: LargeLanguageModel = {
      name: model.name,
      provider: providerId,
    };

    // Store per-chat override
    if (chatId) {
      setOverrides((prev) => {
        const next = new Map(prev);
        next.set(chatId, newModel);
        return next;
      });
    }

    // Also update global settings so the stream uses this model
    updateSettings({ selectedModel: newModel });
    queryClient.invalidateQueries({ queryKey: queryKeys.tokenCount.all });
    setOpen(false);
  };

  // Group providers: primary first, then secondary
  const primaryProviders = Object.keys(MODEL_OPTIONS).filter((id) => {
    const meta = CLOUD_PROVIDERS[id];
    return meta && !meta.secondary;
  });
  const secondaryProviders = Object.keys(MODEL_OPTIONS).filter((id) => {
    const meta = CLOUD_PROVIDERS[id];
    return meta && meta.secondary;
  });
  const orderedProviders = [...primaryProviders, ...secondaryProviders];

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        disabled={disabled}
        className={cn(
          "inline-flex items-center justify-center whitespace-nowrap rounded-lg text-xs font-medium transition-colors",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          "disabled:pointer-events-none disabled:opacity-50",
          "border-none bg-transparent shadow-none",
          "text-foreground/80 hover:text-foreground hover:bg-muted/60",
          "h-7 max-w-[130px] px-2 gap-1 cursor-pointer",
        )}
        data-testid="model-selector"
        title={getDisplayName()}
      >
        <span className="truncate">{getDisplayName()}</span>
        <ChevronDownIcon
          size={12}
          className={cn(
            "shrink-0 transition-transform duration-200",
            open && "rotate-180",
          )}
        />
      </PopoverTrigger>

      <PopoverContent
        align="start"
        side="top"
        sideOffset={4}
        className="w-72 p-0 max-h-96 overflow-y-auto scrollbar-on-hover"
      >
        <div className="py-1">
          {orderedProviders.map((providerId) => {
            const models = MODEL_OPTIONS[providerId];
            const providerMeta = CLOUD_PROVIDERS[providerId];
            if (!models || models.length === 0 || !providerMeta) return null;

            return (
              <div key={providerId}>
                {/* Provider header */}
                <div className="px-3 py-1.5 flex items-center gap-1.5">
                  <span className="text-[10px] uppercase tracking-wider font-medium text-muted-foreground">
                    {providerMeta.displayName}
                  </span>
                  {providerMeta.secondary && (
                    <span className="text-[9px] px-1 py-0.5 rounded bg-muted text-muted-foreground">
                      More
                    </span>
                  )}
                </div>

                {/* Model items */}
                {models.map((model) => {
                  const isSelected =
                    activeModel?.provider === providerId &&
                    activeModel?.name === model.name;

                  return (
                    <button
                      key={`${providerId}-${model.name}`}
                      type="button"
                      onClick={() => handleSelect(providerId, model)}
                      className={cn(
                        "w-full px-3 py-1.5 flex items-center justify-between gap-2",
                        "text-left text-sm transition-colors cursor-pointer",
                        "hover:bg-muted/60",
                        isSelected && "bg-primary/8",
                      )}
                    >
                      <span className="min-w-0 flex flex-col">
                        <span className="text-[13px] leading-tight truncate">
                          {model.displayName}
                        </span>
                        {model.description && (
                          <span className="text-[11px] text-muted-foreground truncate">
                            {model.description}
                          </span>
                        )}
                      </span>
                      <span className="flex shrink-0 items-center gap-1.5">
                        {model.dollarSigns !== undefined &&
                          model.dollarSigns > 0 && (
                            <span className="text-[10px] text-muted-foreground">
                              {"$".repeat(Math.min(model.dollarSigns, 6))}
                            </span>
                          )}
                        {model.dollarSigns === 0 && (
                          <span className="text-[10px] text-emerald-600 dark:text-emerald-400">
                            Free
                          </span>
                        )}
                        {isSelected && (
                          <CheckIcon
                            size={14}
                            className="text-primary shrink-0"
                          />
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
