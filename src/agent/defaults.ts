import type { LargeLanguageModel } from "@/lib/schemas";

/**
 * Single source of truth for Dyad's default intelligence path.
 *
 * There is one user-facing agent. "Zenith Auto" is a model-routing policy,
 * not a second agent or chat mode.
 */
export const DEFAULT_AGENT_MODE = "local-agent" as const;

export const DEFAULT_AGENT_MODEL: LargeLanguageModel = {
  provider: "auto",
  name: "auto",
};

/** Used once when the normal auto route fails mid-turn. */
export const RECOVERY_AGENT_MODEL: LargeLanguageModel = {
  provider: "auto",
  name: "free",
};
