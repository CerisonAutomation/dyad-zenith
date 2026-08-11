import { withLock } from "../ipc/utils/lock_utils";
import { readSettings, writeSettings } from "../main/settings";
import { Api, createApiClient } from "@neondatabase/api-client";
import log from "electron-log";
import { fetchWithRetry } from "../ipc/utils/retryWithRateLimit";
import { DyadError, DyadErrorKind } from "@/errors/dyad_error";
import { getNeonErrorMessage } from "./neon_errors";

const logger = log.scope("neon_management_client");

/**
 * Checks if the Neon access token is expired or about to expire
 * Returns true if token needs to be refreshed
 */
function isTokenExpired(expiresIn?: number): boolean {
  if (!expiresIn) return true;

  // Get when the token was saved (expiresIn is stored at the time of token receipt)
  const settings = readSettings();
  const tokenTimestamp = settings.neon?.tokenTimestamp || 0;
  const currentTime = Math.floor(Date.now() / 1000);

  // Check if the token is expired or about to expire (within 5 minutes)
  return currentTime >= tokenTimestamp + expiresIn - 300;
}

/**
 * Refreshes the Neon access token using the refresh token
 * Updates settings with new tokens and expiration time
 */
let refreshNeonTokenPromise: Promise<void> | null = null;

async function refreshNeonTokenOnce(): Promise<void> {
  const settings = readSettings();
  const refreshToken = settings.neon?.refreshToken?.value;

  if (!isTokenExpired(settings.neon?.expiresIn)) {
    return;
  }

  if (!refreshToken) {
    throw new DyadError(
      "Neon refresh token not found. Please authenticate first.",
      DyadErrorKind.Auth,
    );
  }

  try {
    // Make request to Neon refresh endpoint. Use fetchWithRetry so a burst of
    // token refreshes (e.g. running several in-app tests back-to-back) backs
    // off on 429 instead of failing the whole flow.
    const response = await fetchWithRetry(
      "https://oauth.dyad.sh/api/integrations/neon/refresh",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ refreshToken }),
      },
      "Refresh Neon token",
    );

    if (!response.ok) {
      throw new DyadError(
        `Token refresh failed: ${response.statusText}`,
        DyadErrorKind.External,
      );
    }

    const {
      accessToken,
      refreshToken: newRefreshToken,
      expiresIn,
    } = await response.json();

    // Update settings with new tokens
    writeSettings({
      neon: {
        accessToken: {
          value: accessToken,
        },
        refreshToken: {
          value: newRefreshToken,
        },
        expiresIn,
        tokenTimestamp: Math.floor(Date.now() / 1000), // Store current timestamp
      },
    });
  } catch (error) {
    logger.error("Error refreshing Neon token:", error);
    throw error;
  }
}

export function refreshNeonToken(): Promise<void> {
  if (!refreshNeonTokenPromise) {
    refreshNeonTokenPromise = refreshNeonTokenOnce().finally(() => {
      refreshNeonTokenPromise = null;
    });
  }
  return refreshNeonTokenPromise;
}

// Function to get the Neon API client
export async function getNeonClient(): Promise<Api<unknown>> {
  const settings = readSettings();

  // Check if Neon token exists in settings
  const neonAccessToken = settings.neon?.accessToken?.value;
  const expiresIn = settings.neon?.expiresIn;

  if (!neonAccessToken) {
    throw new DyadError(
      "Neon access token not found. Please authenticate first.",
      DyadErrorKind.Auth,
    );
  }

  // Check if token needs refreshing
  if (isTokenExpired(expiresIn)) {
    await withLock("refresh-neon-token", refreshNeonToken);
    // Get updated settings after refresh
    const updatedSettings = readSettings();
    const newAccessToken = updatedSettings.neon?.accessToken?.value;

    if (!newAccessToken) {
      throw new DyadError(
        "Failed to refresh Neon access token",
        DyadErrorKind.Auth,
      );
    }

    return createApiClient({
      apiKey: newAccessToken,
    });
  }

  return createApiClient({
    apiKey: neonAccessToken,
  });
}

/**
 * Get the user's first organization ID from Neon
 */
export async function getNeonOrganizationId(): Promise<string> {
  const neonClient = await getNeonClient();

  try {
    const response = await neonClient.getCurrentUserOrganizations();

    if (
      !response.data?.organizations ||
      response.data.organizations.length === 0
    ) {
      throw new DyadError(
        "No organizations found for this Neon account",
        DyadErrorKind.NotFound,
      );
    }

    // Return the first organization ID
    return response.data.organizations[0].id;
  } catch (error) {
    logger.error("Error fetching Neon organizations:", error);
    throw new DyadError(
      "Failed to fetch Neon organizations",
      DyadErrorKind.External,
    );
  }
}

// Pure error-parsing helpers live in ./neon_errors so they can be unit-tested
// without importing the full management client. Re-exported here so existing
// importers of neon_management_client keep working unchanged.
export {
  getNeonErrorMessage,
  isRetentionWindowError,
  getRetentionWindowFromError,
} from "./neon_errors";

const DEFAULT_EMAIL_PASSWORD_CONFIG = {
  enabled: false,
  email_verification_method: "otp" as const,
  require_email_verification: false,
  auto_sign_in_after_verification: true,
  send_verification_email_on_sign_up: false,
  send_verification_email_on_sign_in: false,
  disable_sign_up: false,
};

type EmailPasswordConfig = typeof DEFAULT_EMAIL_PASSWORD_CONFIG;

const EMAIL_PASSWORD_CONFIG_TTL_MS = 60_000;

const emailPasswordConfigCache = new Map<
  string,
  { data: EmailPasswordConfig; expiry: number }
>();

export function invalidateEmailPasswordConfigCache(
  projectId: string,
  branchId: string,
): void {
  emailPasswordConfigCache.delete(`${projectId}:${branchId}`);
}

export async function getCachedEmailPasswordConfig(
  projectId: string,
  branchId: string,
): Promise<EmailPasswordConfig> {
  const key = `${projectId}:${branchId}`;
  const cached = emailPasswordConfigCache.get(key);
  if (cached && Date.now() < cached.expiry) {
    return cached.data;
  }

  const neonClient = await getNeonClient();
  try {
    const response = await neonClient.getNeonAuthEmailAndPasswordConfig(
      projectId,
      branchId,
    );
    const data = response.data as EmailPasswordConfig;
    emailPasswordConfigCache.set(key, {
      data,
      expiry: Date.now() + EMAIL_PASSWORD_CONFIG_TTL_MS,
    });
    return data;
  } catch (error: any) {
    if (error.response?.status === 404) {
      emailPasswordConfigCache.set(key, {
        data: DEFAULT_EMAIL_PASSWORD_CONFIG,
        expiry: Date.now() + EMAIL_PASSWORD_CONFIG_TTL_MS,
      });
      return DEFAULT_EMAIL_PASSWORD_CONFIG;
    }
    logger.error(
      "Failed to fetch Neon Auth email/password config:",
      getNeonErrorMessage(error),
    );
    throw error;
  }
}
