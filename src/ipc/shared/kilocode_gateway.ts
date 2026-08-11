/**
 * Kilo Gateway endpoints. Keep these centralized because the OpenAI-compatible
 * provider appends paths such as /chat/completions to the base URL.
 */
export const KILOCODE_GATEWAY_BASE_URL = "https://api.kilo.ai/api/gateway";
export const KILOCODE_MODELS_URL = `${KILOCODE_GATEWAY_BASE_URL}/models`;
export const KILOCODE_AUTO_FREE_MODEL = "kilo-auto/free";

export function canUseKilocodeAnonymously(modelName: string): boolean {
  return modelName === KILOCODE_AUTO_FREE_MODEL || modelName.endsWith(":free");
}
