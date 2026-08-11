import { readSettings, writeSettings } from "./settings";

export function handleDyadProReturn({ apiKey }: { apiKey: string }) {
  const settings = readSettings();
  writeSettings({
    providerSettings: {
      ...settings.providerSettings,
      auto: {
        ...settings.providerSettings.auto,
        // Do not validate keys returned by the Dyad Pro deeplink. The purchase
        // return path is critical, returned keys are very unlikely to be
        // invalid, and any future outage/regression in API key validation would
        // otherwise block users immediately after checkout.
        apiKey: {
          value: apiKey,
        },
      },
    },
    enableDyadPro: true,
    // Switch to local-agent mode for a good default experience
    selectedChatMode: "local-agent",
    // Preserve the user's selected model; do not override to auto
  });
}
