import fetch from "node-fetch"; // Electron main process might need node-fetch
import { shell } from "electron";
import log from "electron-log";
import { createLoggedHandler } from "./safe_handle";
import { createLoggedTypedHandler } from "./base";
import { readSettings } from "../../main/settings"; // Assuming settings are read this way
import {
  SubscriptionStatusSchema,
  systemContracts,
  UserBudgetInfo,
  UserBudgetInfoSchema,
} from "@/ipc/types";
import { IS_TEST_BUILD } from "../utils/test_utils";
import { z } from "zod";
import {
  AUDIO_REQUEST_ID_PATTERN,
  audioContracts,
  MAX_AUDIO_FILENAME_LENGTH,
  MAX_AUDIO_RECORDING_BYTES,
  MAX_AUDIO_REQUEST_ID_LENGTH,
} from "../types/audio";
import type { TranscribeAudioParams } from "../types/audio";
// Engine removed — voice transcription uses local/open providers.
const NO_ENGINE_BASE_URL = "http://localhost:0/engine-removed";
import { DyadError, DyadErrorKind } from "@/errors/dyad_error";

export const UserInfoResponseSchema = z.object({
  usedCredits: z.number(),
  totalCredits: z.number(),
  budgetResetDate: z.string(), // ISO date string from API
  userId: z.string(),
  isTrial: z.boolean().optional().default(false),
});
export type UserInfoResponse = z.infer<typeof UserInfoResponseSchema>;

const logger = log.scope("pro_handlers");
const handle = createLoggedHandler(logger);
const typedHandle = createLoggedTypedHandler(logger);

function validateAudioTranscriptionRequest(input: TranscribeAudioParams) {
  if (
    input.audioData.byteLength === 0 ||
    input.audioData.byteLength > MAX_AUDIO_RECORDING_BYTES
  ) {
    throw new DyadError(
      `Audio data must be between 1 and ${MAX_AUDIO_RECORDING_BYTES} bytes`,
      DyadErrorKind.Validation,
    );
  }

  const trimmedFilename = input.filename.trim();
  if (
    trimmedFilename.length === 0 ||
    trimmedFilename.length > MAX_AUDIO_FILENAME_LENGTH ||
    trimmedFilename.includes("/") ||
    trimmedFilename.includes("\\") ||
    trimmedFilename === "." ||
    trimmedFilename === ".."
  ) {
    throw new DyadError("Invalid audio filename", DyadErrorKind.Validation);
  }

  if (
    input.requestId.trim().length === 0 ||
    input.requestId.length > MAX_AUDIO_REQUEST_ID_LENGTH ||
    !AUDIO_REQUEST_ID_PATTERN.test(input.requestId)
  ) {
    throw new DyadError(
      "Invalid transcription request ID",
      DyadErrorKind.Validation,
    );
  }
}

function getUserInfoUrl() {
  // Overridable so tests point at the fake LLM server instead of the real API.
  if (process.env.DYAD_USER_INFO_URL) {
    return process.env.DYAD_USER_INFO_URL;
  }
  return "https://api.dyad.sh/v1/user/info";
}

function getSubscriptionStatusUrl() {
  return (
    process.env.DYAD_SUBSCRIPTION_STATUS_URL ??
    "https://academy.dyad.sh/api/desktop/subscription-status"
  );
}

function getSubscriptionStatusApiKey() {
  const url = getSubscriptionStatusUrl();
  const fixtureApiKey = process.env.DYAD_SUBSCRIPTION_STATUS_FIXTURE_API_KEY;
  if (fixtureApiKey) {
    try {
      const hostname = new URL(url).hostname;
      if (
        hostname === "127.0.0.1" ||
        hostname === "localhost" ||
        hostname === "[::1]"
      ) {
        return fixtureApiKey;
      }
    } catch {
      // The request path below will log and safely ignore an invalid URL.
    }
  }
  return (
    readSettings().providerSettings?.openai?.apiKey?.value ||
    readSettings().providerSettings?.anthropic?.apiKey?.value ||
    readSettings().providerSettings?.google?.apiKey?.value ||
    readSettings().providerSettings?.openrouter?.apiKey?.value ||
    readSettings().providerSettings?.auto?.apiKey?.value ||
    readSettings().providerSettings?.opencode?.apiKey?.value ||
    readSettings().providerSettings?.kilocode?.apiKey?.value ||
    readSettings().providerSettings?.xai?.apiKey?.value ||
    readSettings().providerSettings?.minimax?.apiKey?.value
  );
}

export function parseBillingActionUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new DyadError("Invalid billing action URL", DyadErrorKind.Validation);
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "academy.dyad.sh" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== ""
  ) {
    throw new DyadError("Invalid billing action URL", DyadErrorKind.Validation);
  }
  return url.toString();
}

export function registerProHandlers() {
  // This method should try to avoid throwing errors because this is auxiliary
  // information and isn't critical to using the app
  handle("get-user-budget", async (): Promise<UserBudgetInfo | null> => {
    logger.debug("Custom build: returning synthetic unlimited budget.");

    // ADR-001: this build has no Dyad account; Pro features are unlocked via
    // BYOK/local providers. Report an effectively unlimited budget instead of
    // querying the Dyad billing API (which would 401 and return null, making
    // the UI show Pro features as unavailable).
    return {
      usedCredits: 0,
      totalCredits: 1_000_000,
      budgetResetDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      redactedUserId: "****open",
      isTrial: false,
    };

    const settings = readSettings();

    // Dyad billing endpoint only accepts Dyad-issued keys (auto provider).
    const apiKey = settings.providerSettings?.auto?.apiKey?.value;

    if (!apiKey) {
      // Expected state for non-Pro users; not an error.
      logger.debug("LLM Gateway API key (Dyad Pro) is not configured.");
      return null;
    }

    const url = getUserInfoUrl();
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    };

    try {
      // Use native fetch if available, otherwise node-fetch will be used via import
      const response = await fetch(url, {
        method: "GET",
        headers: headers,
      });

      if (!response.ok) {
        const errorBody = await response.text();
        logger.error(
          `Failed to fetch user budget. Status: ${response.status}. Body: ${errorBody}`,
        );
        return null;
      }

      const rawData = await response.json();

      // Validate the API response structure
      const data = UserInfoResponseSchema.parse(rawData);

      // Turn user_abc1234 =>  "****1234"
      // Preserve the last 4 characters so we can correlate bug reports
      // with the user.
      const redactedUserId =
        data.userId.length > 8 ? "****" + data.userId.slice(-4) : "<redacted>";

      logger.debug("Successfully fetched user budget information.");

      // Transform to UserBudgetInfo format
      const userBudgetInfo = UserBudgetInfoSchema.parse({
        usedCredits: data.usedCredits,
        totalCredits: data.totalCredits,
        budgetResetDate: new Date(data.budgetResetDate),
        redactedUserId: redactedUserId,
        isTrial: data.isTrial,
      });

      return userBudgetInfo;
    } catch (error: any) {
      logger.error(`Error fetching user budget: ${error.message}`, error);
      return null;
    }
  });

  typedHandle(systemContracts.getSubscriptionStatus, async () => {
    // ADR-001: custom build — always report a healthy active subscription so
    // Pro-gated UI features are enabled (no Dyad account required).
    return { alert: null, effectiveAt: null, actionUrl: null };

    const apiKey = getSubscriptionStatusApiKey();
    if (!apiKey) {
      return null;
    }
    if (IS_TEST_BUILD && !process.env.DYAD_SUBSCRIPTION_STATUS_URL) {
      return null;
    }

    try {
      const response = await fetch(getSubscriptionStatusUrl(), {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      });
      if (!response.ok) {
        logger.warn(
          `Failed to fetch subscription status. Status: ${response.status}`,
        );
        return null;
      }
      return SubscriptionStatusSchema.parse(await response.json());
    } catch (error) {
      logger.error("Failed to fetch subscription status", error);
      return null;
    }
  });

  typedHandle(systemContracts.openBillingAction, async (_event, value) => {
    const url = parseBillingActionUrl(value);
    if (IS_TEST_BUILD) {
      logger.debug("E2E test mode: skipped opening billing action URL", url);
      return;
    }
    await shell.openExternal(url);
  });

  typedHandle(
    audioContracts.transcribeAudio,
    async (_event, input: TranscribeAudioParams) => {
      const settings = readSettings();
      // Custom build: voice-to-text works with any configured provider API key
      // (routed through the provider's native OpenAI-compatible API, NOT the
      // Dyad Engine). OpenCode is preferred (it is this build's default
      // provider), then the other OpenAI-compatible providers, then engine.
      const opencodeApiKey =
        settings.providerSettings?.opencode?.apiKey?.value;
      const opencodeBaseURL: string =
        (String(
          (settings.providerSettings?.opencode as any)?.baseURL ?? "",
        ) || "https://opencode.ai/zen/go/v1");
      const apiKey =
        opencodeApiKey ||
        settings.providerSettings?.openai?.apiKey?.value ||
        settings.providerSettings?.anthropic?.apiKey?.value ||
        settings.providerSettings?.google?.apiKey?.value ||
        settings.providerSettings?.openrouter?.apiKey?.value ||
        settings.providerSettings?.auto?.apiKey?.value ||
        settings.providerSettings?.opencode?.apiKey?.value ||
        settings.providerSettings?.kilocode?.apiKey?.value ||
        settings.providerSettings?.xai?.apiKey?.value ||
        settings.providerSettings?.minimax?.apiKey?.value;

      if (!apiKey) {
        throw new DyadError(
          "Voice-to-text requires at least one provider API key configured in Settings.",
          DyadErrorKind.Auth,
        );
      }

      validateAudioTranscriptionRequest(input);

      const audioBuffer = Buffer.from(
        input.audioData.buffer,
        input.audioData.byteOffset,
        input.audioData.byteLength,
      );

      // Voice transcription: engine removed. Return clear guidance.
      throw new DyadError(
        "Voice-to-text requires an opencode or Kilo API key. Add one in Settings → Providers.",
        DyadErrorKind.Auth,
      );
    },
  );
}
