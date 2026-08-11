import { useTranslation } from "react-i18next";
import { useState } from "react";
import { ArrowUpRight, KeyRound, Wallet } from "lucide-react";

import { Button } from "./ui/button";
import { cn } from "@/lib/utils";

// Provider logos as SVG data URIs
const openAiLogo =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 120 28'%3E%3Ctext x='0' y='20' font-family='system-ui' font-weight='600' font-size='16' fill='%23343541'%3EOpenAI%3C/text%3E%3C/svg%3E";
const googleLogo =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 120 28'%3E%3Ctext x='0' y='20' font-family='system-ui' font-weight='600' font-size='16' fill='%234285F4'%3EGoogle%3C/text%3E%3C/svg%3E";
const anthropicLogo =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 120 28'%3E%3Ctext x='0' y='20' font-family='system-ui' font-weight='600' font-size='16' fill='%23D97706'%3EAnthropic%3C/text%3E%3C/svg%3E";

export function ProBanner() {
  const [selectedBanner] = useState<"ai" | "smart">(() => {
    const options = ["ai", "smart"] as const;
    return options[Math.floor(Math.random() * options.length)];
  });

  return (
    <div className="mt-6 max-w-2xl mx-auto">
      {selectedBanner === "ai" ? <AiAccessBanner /> : <SmartContextBanner />}
    </div>
  );
}

export function ManageDyadProButton({ className }: { className?: string }) {
  const { t } = useTranslation("home");
  return (
    <Button
      variant="outline"
      size="lg"
      className={cn(
        "cursor-pointer w-full mt-4 bg-(--background-lighter) text-primary",
        className,
      )}
      disabled
    >
      <Wallet aria-hidden="true" className="w-5 h-5" />
      {t("proBanner.manageDyadPro")}
      <ArrowUpRight aria-hidden="true" className="w-5 h-5" />
    </Button>
  );
}

export function SetupDyadProButton() {
  const { t } = useTranslation("home");
  return (
    <button
      type="button"
      className="inline-flex cursor-pointer items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-primary hover:underline"
      disabled
    >
      <KeyRound aria-hidden="true" className="size-3.5" />
      {t("proBanner.alreadyHavePro")}
    </button>
  );
}

export function AiAccessBanner() {
  const { t } = useTranslation("home");
  return (
    <div className="w-full py-2 sm:py-2.5 md:py-3 rounded-lg bg-gradient-to-br from-white via-indigo-50 to-sky-100 dark:from-indigo-700 dark:via-indigo-700 dark:to-indigo-900 flex items-center justify-center relative overflow-hidden ring-1 ring-inset ring-black/5 dark:ring-white/10 shadow-sm transition-all duration-200">
      <div
        className="absolute inset-0 z-0 bg-gradient-to-tr from-white/60 via-transparent to-transparent pointer-events-none dark:from-white/10"
        aria-hidden="true"
      />
      <div className="absolute inset-0 z-0 pointer-events-none dark:hidden">
        <div className="absolute -top-8 -left-6 h-40 w-40 rounded-full blur-2xl bg-violet-200/40" />
        <div className="absolute -bottom-10 -right-6 h-48 w-48 rounded-full blur-3xl bg-sky-200/40" />
      </div>
      <div className="relative z-10 text-center flex flex-col items-center gap-0.5 sm:gap-1 md:gap-1.5 px-4 md:px-6 pr-6 md:pr-8">
        <div className="mt-0.5 sm:mt-1 flex items-center gap-2 sm:gap-3 justify-center">
          <div className="text-xl font-semibold tracking-tight text-indigo-900 dark:text-indigo-100">
            {t("proBanner.accessLeadingModels")}
          </div>
          <button
            type="button"
            aria-label="Pro features enabled"
            disabled
            className="inline-flex items-center rounded-md bg-white/90 text-indigo-800 shadow px-3 py-1.5 text-xs sm:text-sm font-semibold"
          >
            Pro Enabled
          </button>
        </div>

        <div className="mt-1.5 sm:mt-2 grid grid-cols-3 gap-6 md:gap-8 items-center justify-items-center opacity-90">
          <div className="flex items-center justify-center">
            <img
              src={openAiLogo}
              alt="OpenAI"
              width={96}
              height={28}
              className="h-4 md:h-5 w-auto dark:invert"
            />
          </div>
          <div className="flex items-center justify-center">
            <img
              src={googleLogo}
              alt="Google"
              width={110}
              height={30}
              className="h-4 md:h-5 w-auto"
            />
          </div>
          <div className="flex items-center justify-center">
            <img
              src={anthropicLogo}
              alt="Anthropic"
              width={110}
              height={30}
              className="h-3 w-auto dark:invert"
            />
          </div>
        </div>
      </div>
    </div>
  );
}

export function SmartContextBanner() {
  const { t } = useTranslation("home");
  return (
    <div className="w-full py-2 sm:py-2.5 md:py-3 rounded-lg bg-gradient-to-br from-emerald-50 via-emerald-100 to-emerald-200 dark:from-emerald-700 dark:via-indigo-700 dark:to-indigo-900 flex items-center justify-center relative overflow-hidden ring-1 ring-inset ring-emerald-900/10 dark:ring-white/10 shadow-sm transition-all duration-200">
      <div
        className="absolute inset-0 z-0 bg-gradient-to-tr from-white/60 via-transparent to-transparent pointer-events-none dark:from-white/10"
        aria-hidden="true"
      />
      <div className="absolute inset-0 z-0 pointer-events-none dark:hidden">
        <div className="absolute -top-10 -left-8 h-44 w-44 rounded-full blur-2xl bg-emerald-200/50" />
        <div className="absolute -bottom-12 -right-8 h-56 w-56 rounded-full blur-3xl bg-teal-200/50" />
      </div>
      <div className="relative z-10 px-4 md:px-6 pr-6 md:pr-8">
        <div className="mt-0.5 sm:mt-1 flex items-center gap-2 sm:gap-3 justify-center">
          <div className="flex flex-col items-center text-center">
            <div className="text-xl font-semibold tracking-tight text-emerald-900 dark:text-emerald-100">
              {t("proBanner.upTo3xCheaper")}
            </div>
            <div className="text-sm sm:text-base mt-1 text-emerald-700 dark:text-emerald-200/80">
              {t("proBanner.byUsingSmartContext")}
            </div>
          </div>
          <button
            type="button"
            aria-label="Pro features enabled"
            disabled
            className="inline-flex items-center rounded-md bg-white/90 text-emerald-800 shadow px-3 py-1.5 text-xs sm:text-sm font-semibold"
          >
            Pro Enabled
          </button>
        </div>
      </div>
    </div>
  );
}
