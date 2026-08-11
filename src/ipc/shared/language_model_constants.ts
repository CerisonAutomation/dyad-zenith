/**
 * Models whose upstream gateway provider is currently unavailable
 * (verified 2026-08-09 via direct gateway tests):
 * - grok-4.5 / hy3-preview / mimo-v2-pro / mimo-v2-omni: "Console Go"
 *   upstream down (400 "Endpoint is unavailable" / deprecated 404)
 * - deepseek-v4-flash: region-locked ("only available hosted in China")
 * The picker shows a badge; the agent auto-falls-back to a working model
 * if one of these is selected anyway.
 */
export const KNOWN_UNAVAILABLE_MODEL_NAMES: ReadonlySet<string> = new Set([
  "grok-4.5",
  "hy3-preview",
  "mimo-v2-pro",
  "mimo-v2-omni",
  "deepseek-v4-flash",
]);

export function isModelKnownUnavailable(apiName: string | undefined): boolean {
  return !!apiName && KNOWN_UNAVAILABLE_MODEL_NAMES.has(apiName);
}

export const PROVIDERS_THAT_SUPPORT_THINKING: (keyof typeof MODEL_OPTIONS)[] = [
  "google",
  "vertex",
];

export interface ModelOption {
  name: string;
  displayName: string;
  description: string;
  dollarSigns?: number;
  temperature?: number;
  tag?: string;
  tagColor?: string;
  maxOutputTokens?: number;
  contextWindow?: number;
}

export const GPT_5_2_MODEL_NAME = "gpt-5.2";
export const GPT_5_5_MODEL_NAME = "gpt-5.5";
export const SONNET_4_6 = "claude-sonnet-4-6";
export const OPUS_4_6 = "claude-opus-4-6";
export const OPUS_4_8 = "claude-opus-4-8";
export const GEMINI_3_5_FLASH = "gemini-3.5-flash";
export const GEMINI_3_FLASH = "gemini-3-flash-preview";
export const GEMINI_3_1_PRO_PREVIEW = "gemini-3.1-pro-preview";
export const NEMOTRON_3_SUPER_FREE = "nvidia/nemotron-3-super-120b-a12b:free";
export const GPT_5_NANO = "gpt-5-nano";

export const MODEL_OPTIONS: Record<string, ModelOption[]> = {
  auto: [
    {
      name: "auto",
      displayName: "Zenith Auto",
      description:
        "Recommended: one Agent with free-first provider routing and automatic failover",
      maxOutputTokens: 32_000,
      contextWindow: 128_000,
      temperature: 0,
      dollarSigns: 0,
      tag: "Recommended",
    },
    {
      name: "free",
      displayName: "Zenith Free",
      description: "Use only configured zero-cost model routes",
      maxOutputTokens: 32_000,
      contextWindow: 128_000,
      temperature: 0,
      dollarSigns: 0,
      tag: "Free",
    },
    {
      name: "free-pro",
      displayName: "Dyad Free",
      description: "Hosted Dyad free model when a Dyad credential is configured",
      maxOutputTokens: 32_000,
      contextWindow: 128_000,
      temperature: 0,
      dollarSigns: 0,
    },
  ],
  openai: [
    {
      name: GPT_5_5_MODEL_NAME,
      displayName: "GPT 5.5",
      description: "OpenAI's most capable coding model",
      contextWindow: 1_000_000,
      temperature: 1,
      dollarSigns: 6,
    },
    // https://platform.openai.com/docs/models/gpt-5.1
    {
      name: GPT_5_2_MODEL_NAME,
      displayName: "GPT 5.2",
      description: "OpenAI's latest model",
      // Technically it's 128k but OpenAI errors if you set max_tokens instead of max_completion_tokens
      maxOutputTokens: undefined,
      contextWindow: 400_000,
      // Requires temperature to be default value (1)
      temperature: 1,
      dollarSigns: 3,
    },
    // https://platform.openai.com/docs/models/gpt-5.1
    {
      name: "gpt-5.1",
      displayName: "GPT 5.1",
      description:
        "OpenAI's flagship model- smarter, faster, and more conversational",
      // Technically it's 128k but OpenAI errors if you set max_tokens instead of max_completion_tokens
      maxOutputTokens: undefined,
      contextWindow: 400_000,
      // Requires temperature to be default value (1)
      temperature: 1,
      dollarSigns: 3,
    },
    // https://platform.openai.com/docs/models/gpt-5.1-codex
    {
      name: "gpt-5.1-codex",
      displayName: "GPT 5.1 Codex",
      description: "OpenAI's advanced coding workflows",
      // Technically it's 128k but OpenAI errors if you set max_tokens instead of max_completion_tokens
      maxOutputTokens: undefined,
      contextWindow: 400_000,
      // Requires temperature to be default value (1)
      temperature: 1,
      dollarSigns: 3,
    },
    // https://platform.openai.com/docs/models/gpt-5.1-codex-mini
    {
      name: "gpt-5.1-codex-mini",
      displayName: "GPT 5.1 Codex Mini",
      description: "OpenAI's compact and efficient coding model",
      // Technically it's 128k but OpenAI errors if you set max_tokens instead of max_completion_tokens
      maxOutputTokens: undefined,
      contextWindow: 400_000,
      // Requires temperature to be default value (1)
      temperature: 1,
      dollarSigns: 2,
    },

    // https://platform.openai.com/docs/models/gpt-5
    {
      name: "gpt-5",
      displayName: "GPT 5",
      description: "OpenAI's flagship model",
      // Technically it's 128k but OpenAI errors if you set max_tokens instead of max_completion_tokens
      maxOutputTokens: undefined,
      contextWindow: 400_000,
      // Requires temperature to be default value (1)
      temperature: 1,
      dollarSigns: 3,
    },
    // https://platform.openai.com/docs/models/gpt-5-codex
    {
      name: "gpt-5-codex",
      displayName: "GPT 5 Codex",
      description: "OpenAI's flagship model optimized for coding",
      // Technically it's 128k but OpenAI errors if you set max_tokens instead of max_completion_tokens
      maxOutputTokens: undefined,
      contextWindow: 400_000,
      // Requires temperature to be default value (1)
      temperature: 1,
      dollarSigns: 3,
    },
    // https://platform.openai.com/docs/models/gpt-5-mini
    {
      name: "gpt-5-mini",
      displayName: "GPT 5 Mini",
      description: "OpenAI's lightweight, but intelligent model",
      // Technically it's 128k but OpenAI errors if you set max_tokens instead of max_completion_tokens
      maxOutputTokens: undefined,
      contextWindow: 400_000,
      // Requires temperature to be default value (1)
      temperature: 1,
      dollarSigns: 2,
    },
  ],
  // https://docs.anthropic.com/en/docs/about-claude/models/all-models#model-comparison-table
  anthropic: [
    {
      name: OPUS_4_8,
      displayName: "Claude Opus 4.8",
      description: "Anthropic most capable model",
      maxOutputTokens: 64_000,
      contextWindow: 1_000_000,
      temperature: 1,
      dollarSigns: 6,
    },
    {
      name: "claude-opus-4-6",
      displayName: "Claude Opus 4.6",
      description:
        "Anthropic's best model for coding (note: this model is very expensive!)",
      // Set to 32k since context window is 1M tokens
      maxOutputTokens: 32_000,
      contextWindow: 1_000_000,
      temperature: 1,
      dollarSigns: 6,
    },
    // https://docs.anthropic.com/en/docs/about-claude/models/overview
    {
      name: SONNET_4_6,
      displayName: "Claude Sonnet 4.6",
      description:
        "Anthropic's fast and intelligent model (note: >200k tokens is very expensive!)",
      // Set to 32k since context window is 1M tokens
      maxOutputTokens: 32_000,
      contextWindow: 1_000_000,
      temperature: 1,
      dollarSigns: 5,
    },
  ],
  google: [
    // https://ai.google.dev/gemini-api/docs/models/gemini-3.1-pro-preview
    {
      name: "gemini-3.1-pro-preview",
      displayName: "Gemini 3.1 Pro (Preview)",
      description: "Google's most capable Gemini model",
      // See Flash 2.5 comment below (go 1 below just to be safe, even though it seems OK now).
      maxOutputTokens: 65_536 - 1,
      // Gemini context window = input token + output token
      contextWindow: 1_048_576,
      // Recommended by Google: https://ai.google.dev/gemini-api/docs/gemini-3?thinking=high#temperature
      temperature: 1.0,
      dollarSigns: 4,
    },
    // Mirrors the production catalog entry for Gemini 3.5 Flash.
    {
      name: GEMINI_3_5_FLASH,
      displayName: "Gemini 3.5 Flash",
      description: "Google's high-quality Flash model",
      // See Flash 2.5 comment below (go 1 below just to be safe, even though it seems OK now).
      maxOutputTokens: 65_536 - 1,
      // Gemini context window = input token + output token
      contextWindow: 1_048_576,
      // Recommended by Google: https://ai.google.dev/gemini-api/docs/gemini-3?thinking=high#temperature
      temperature: 1.0,
      dollarSigns: 3,
    },
    // https://ai.google.dev/gemini-api/docs/models#gemini-3-pro
    {
      name: GEMINI_3_FLASH,
      displayName: "Gemini 3 Flash (Preview)",
      description: "Powerful coding model at a good price",
      // See Flash 2.5 comment below (go 1 below just to be safe, even though it seems OK now).
      maxOutputTokens: 65_536 - 1,
      // Gemini context window = input token + output token
      contextWindow: 1_048_576,
      // Recommended by Google: https://ai.google.dev/gemini-api/docs/gemini-3?thinking=high#temperature
      temperature: 1.0,
      dollarSigns: 2,
    },
    // https://ai.google.dev/gemini-api/docs/models#gemini-2.5-pro-preview-03-25
    {
      name: "gemini-2.5-pro",
      displayName: "Gemini 2.5 Pro",
      description: "Google's Gemini 2.5 Pro model",
      // See Flash 2.5 comment below (go 1 below just to be safe, even though it seems OK now).
      maxOutputTokens: 65_536 - 1,
      // Gemini context window = input token + output token
      contextWindow: 1_048_576,
      temperature: 0,
      dollarSigns: 3,
    },
    // https://ai.google.dev/gemini-api/docs/models#gemini-2.5-flash-preview
    {
      name: "gemini-flash-latest",
      displayName: "Gemini 2.5 Flash",
      description: "Google's Gemini 2.5 Flash model (free tier available)",
      // Weirdly for Vertex AI, the output token limit is *exclusive* of the stated limit.
      maxOutputTokens: 65_536 - 1,
      // Gemini context window = input token + output token
      contextWindow: 1_048_576,
      temperature: 0,
      dollarSigns: 2,
    },
  ],
  vertex: [
    // Vertex Gemini 2.5 Pro
    {
      name: "gemini-2.5-pro",
      displayName: "Gemini 2.5 Pro",
      description: "Vertex Gemini 2.5 Pro",
      maxOutputTokens: 65_536 - 1,
      contextWindow: 1_048_576,
      temperature: 0,
    },
    // Vertex Gemini 2.5 Flash
    {
      name: "gemini-flash-latest",
      displayName: "Gemini 2.5 Flash",
      description: "Vertex Gemini 2.5 Flash",
      maxOutputTokens: 65_536 - 1,
      contextWindow: 1_048_576,
      temperature: 0,
    },
  ],
  openrouter: [
    // https://openrouter.ai/deepseek/deepseek-v3.1:free
    {
      name: "deepseek/deepseek-v3.1:free",
      displayName: "Ling 3.0 Tiny (Free)",
      description: "DeepSeek's free lightweight model",
      maxOutputTokens: 32_000,
      contextWindow: 128_000,
      temperature: 0,
      dollarSigns: 0,
    },
    // https://openrouter.ai/laguna/laguna-s-2.1:free
    {
      name: "laguna/laguna-s-2.1:free",
      displayName: "Laguna S 2.1 (Free)",
      description: "Free mid-tier coding model",
      maxOutputTokens: 32_000,
      contextWindow: 128_000,
      temperature: 0,
      dollarSigns: 0,
    },
    // https://openrouter.ai/laguna/laguna-xs-2.1:free
    {
      name: "laguna/laguna-xs-2.1:free",
      displayName: "Laguna XS 2.1 (Free)",
      description: "Free compact model",
      maxOutputTokens: 32_000,
      contextWindow: 128_000,
      temperature: 0,
      dollarSigns: 0,
    },
    // https://openrouter.ai/north/north-mini-code:free
    {
      name: "north/north-mini-code:free",
      displayName: "North Mini Code (Free)",
      description: "Free lightweight code-focused model",
      maxOutputTokens: 32_000,
      contextWindow: 128_000,
      temperature: 0,
      dollarSigns: 0,
    },
    {
      name: "openrouter/free",
      displayName: "Free (OpenRouter)",
      description:
        "Uses one of the free OpenRouter models (data may be used for training)",
      maxOutputTokens: 32_000,
      contextWindow: 200_000,
      temperature: 0,
      dollarSigns: 0,
    },
    // https://openrouter.ai/nvidia/nemotron-3-super-120b-a12b:free
    {
      name: NEMOTRON_3_SUPER_FREE,
      displayName: "Nemotron 3 Super (Free)",
      description: "NVIDIA's open 120B MoE model with a 1M context window",
      maxOutputTokens: 32_000,
      contextWindow: 1_000_000,
      temperature: 0,
      dollarSigns: 0,
    },
    // https://openrouter.ai/moonshotai/kimi-k2.5
    {
      name: "moonshotai/kimi-k2.5",
      displayName: "Kimi K2.5",
      description: "Moonshot AI's latest and most capable model",
      maxOutputTokens: 32_000,
      contextWindow: 256_000,
      temperature: 1.0,
      dollarSigns: 2,
    },
    // https://openrouter.ai/minimax/minimax-m2.7
    {
      name: "minimax/minimax-m2.7",
      displayName: "MiniMax M2.7",
      description: "Latest flagship model with enhanced reasoning and coding",
      maxOutputTokens: 32_000,
      contextWindow: 204_800,
      temperature: 0,
      dollarSigns: 1,
    },
    // https://openrouter.ai/minimax/minimax-m2.5
    {
      name: "minimax/minimax-m2.5",
      displayName: "MiniMax M2.5",
      description: "Strong cost-effective model for real-world productivity",
      maxOutputTokens: 32_000,
      contextWindow: 196_608,
      temperature: 0,
      dollarSigns: 1,
    },
    {
      name: "z-ai/glm-5",
      displayName: "GLM 5",
      description: "Z-AI's best coding model",
      maxOutputTokens: 32_000,
      contextWindow: 200_000,
      temperature: 0.7,
      dollarSigns: 2,
    },
    {
      name: "z-ai/glm-4.7",
      displayName: "GLM 4.7",
      description: "Z-AI's coding model",
      maxOutputTokens: 32_000,
      contextWindow: 200_000,
      temperature: 0.7,
      dollarSigns: 2,
    },
    {
      name: "qwen/qwen3-coder",
      displayName: "Qwen3 Coder",
      description: "Qwen's best coding model",
      maxOutputTokens: 32_000,
      contextWindow: 262_000,
      temperature: 0,
      dollarSigns: 2,
    },
    {
      name: "deepseek/deepseek-chat-v3.1",
      displayName: "DeepSeek v3.1",
      description: "Strong cost-effective model with optional thinking",
      maxOutputTokens: 32_000,
      contextWindow: 128_000,
      temperature: 0,
      dollarSigns: 2,
    },
  ],
  azure: [
    {
      name: "gpt-5.1",
      displayName: "GPT-5.1",
      description: "Azure OpenAI GPT-5.1 model",
      // See OpenAI comment above
      // maxOutputTokens: 128_000,
      contextWindow: 400_000,
      temperature: 1,
    },
    {
      name: "gpt-5.1-codex",
      displayName: "GPT-5.1 Codex",
      description: "Azure OpenAI GPT-5.1 Codex model",
      // See OpenAI comment above
      // maxOutputTokens: 128_000,
      contextWindow: 400_000,
      temperature: 1,
    },
    {
      name: "gpt-5.1-codex-mini",
      displayName: "GPT-5.1 Codex Mini",
      description: "Azure OpenAI GPT-5.1 Codex Mini model",
      // See OpenAI comment above
      // maxOutputTokens: 128_000,
      contextWindow: 400_000,
      temperature: 1,
    },
    {
      name: "gpt-5-codex",
      displayName: "GPT-5 Codex",
      description: "Azure OpenAI GPT-5 Codex model",
      // See OpenAI comment above
      // maxOutputTokens: 128_000,
      contextWindow: 400_000,
      temperature: 1,
    },
    {
      name: "gpt-5",
      displayName: "GPT-5",
      description: "Azure OpenAI GPT-5 model with reasoning capabilities",
      // See OpenAI comment above
      // maxOutputTokens: 128_000,
      contextWindow: 400_000,
      temperature: 1,
    },
    {
      name: "gpt-5-mini",
      displayName: "GPT-5 Mini",
      description: "Azure OpenAI GPT-5 Mini model",
      // See OpenAI comment above
      // maxOutputTokens: 128_000,
      contextWindow: 400_000,
      temperature: 1,
    },
    {
      name: "gpt-5-nano",
      displayName: "GPT-5 Nano",
      description: "Azure OpenAI GPT-5 Nano model",
      // See OpenAI comment above
      // maxOutputTokens: 128_000,
      contextWindow: 400_000,
      temperature: 1,
    },
    {
      name: "gpt-5-chat",
      displayName: "GPT-5 Chat",
      description: "Azure OpenAI GPT-5 Chat model",
      // See OpenAI comment above
      // maxOutputTokens: 16_384,
      contextWindow: 128_000,
      temperature: 1,
    },
  ],
  xai: [
    // https://docs.x.ai/docs/models
    {
      name: "grok-code-fast-1",
      displayName: "Grok Code Fast",
      description: "Fast coding model",
      maxOutputTokens: 32_000,
      contextWindow: 256_000,
      temperature: 0,
      dollarSigns: 1,
    },
    {
      name: "grok-4",
      displayName: "Grok 4",
      description: "Most capable coding model",
      maxOutputTokens: 32_000,
      contextWindow: 256_000,
      temperature: 0,
      dollarSigns: 4,
    },
    {
      name: "grok-3",
      displayName: "Grok 3",
      description: "Powerful coding model",
      maxOutputTokens: 32_000,
      contextWindow: 131_072,
      temperature: 0,
      dollarSigns: 4,
    },
  ],
  bedrock: [
    {
      name: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
      displayName: "Claude 4.5 Sonnet",
      description:
        "Anthropic's best model for coding (note: >200k tokens is very expensive!)",
      maxOutputTokens: 32_000,
      contextWindow: 1_000_000,
      temperature: 1,
    },
  ],
  // https://platform.minimax.io/docs/api-reference/text-anthropic-api
  minimax: [
    {
      name: "MiniMax-M2.7",
      displayName: "MiniMax M2.7",
      description: "Latest flagship model with enhanced reasoning and coding",
      maxOutputTokens: 32_000,
      contextWindow: 204_800,
      temperature: 1.0,
      dollarSigns: 1,
    },
    {
      name: "MiniMax-M2.7-highspeed",
      displayName: "MiniMax M2.7 High Speed",
      description: "High-speed version of M2.7 for low-latency scenarios",
      maxOutputTokens: 32_000,
      contextWindow: 204_800,
      temperature: 1.0,
      dollarSigns: 1,
    },
    {
      name: "MiniMax-M2.5",
      displayName: "MiniMax M2.5",
      description: "Peak Performance. Ultimate Value. Master the Complex",
      maxOutputTokens: 32_000,
      contextWindow: 204_800,
      temperature: 1.0,
      dollarSigns: 1,
    },
    {
      name: "MiniMax-M2.5-highspeed",
      displayName: "MiniMax M2.5 High Speed",
      description: "Same performance, faster and more agile",
      maxOutputTokens: 32_000,
      contextWindow: 204_800,
      temperature: 1.0,
      dollarSigns: 1,
    },
  ],
  opencode: [
    {
      name: "grok-4.5",
      displayName: "Grok 4.5",
      description: "xAI's most capable model via OpenCode",
      maxOutputTokens: 32_000,
      contextWindow: 131_072,
      temperature: 0,
      dollarSigns: 4,
    },
    {
      name: "gpt-5.6-luna",
      displayName: "GPT 5.6 Luna",
      description: "OpenAI's GPT 5.6 Luna via OpenCode",
      maxOutputTokens: 32_000,
      contextWindow: 128_000,
      temperature: 0,
      dollarSigns: 3,
    },
    {
      name: "glm-5.2",
      displayName: "GLM 5.2",
      description: "Z-AI's GLM 5.2 via OpenCode",
      maxOutputTokens: 32_000,
      contextWindow: 128_000,
      temperature: 0,
      dollarSigns: 2,
    },
    {
      name: "glm-5.1",
      displayName: "GLM 5.1",
      description: "Z-AI's GLM 5.1 via OpenCode",
      maxOutputTokens: 32_000,
      contextWindow: 128_000,
      temperature: 0,
      dollarSigns: 2,
    },
    {
      name: "glm-5",
      displayName: "GLM 5",
      description: "Z-AI's GLM 5 via OpenCode",
      maxOutputTokens: 32_000,
      contextWindow: 128_000,
      temperature: 0,
      dollarSigns: 2,
    },
    {
      name: "kimi-k3",
      displayName: "Kimi K3",
      description: "Moonshot AI's Kimi K3 via OpenCode",
      maxOutputTokens: 32_000,
      contextWindow: 128_000,
      temperature: 0,
      dollarSigns: 3,
    },
    {
      name: "kimi-k2.7-code",
      displayName: "Kimi K2.7 Code",
      description: "Moonshot AI's Kimi K2.7 Code via OpenCode",
      maxOutputTokens: 32_000,
      contextWindow: 128_000,
      temperature: 0,
      dollarSigns: 2,
    },
    {
      name: "kimi-k2.6",
      displayName: "Kimi K2.6",
      description: "Moonshot AI's Kimi K2.6 via OpenCode",
      maxOutputTokens: 32_000,
      contextWindow: 128_000,
      temperature: 0,
      dollarSigns: 2,
    },
    {
      name: "kimi-k2.5",
      displayName: "Kimi K2.5",
      description: "Moonshot AI's Kimi K2.5 via OpenCode",
      maxOutputTokens: 32_000,
      contextWindow: 128_000,
      temperature: 0,
      dollarSigns: 2,
    },
    {
      name: "mimo-v2.5",
      displayName: "Mimo V2.5",
      description: "MiMo V2.5 via OpenCode",
      maxOutputTokens: 32_000,
      contextWindow: 128_000,
      temperature: 0,
      dollarSigns: 2,
    },
    {
      name: "mimo-v2.5-pro",
      displayName: "Mimo V2.5 Pro",
      description: "MiMo V2.5 Pro via OpenCode",
      maxOutputTokens: 32_000,
      contextWindow: 128_000,
      temperature: 0,
      dollarSigns: 3,
    },
    {
      name: "mimo-v2-pro",
      displayName: "Mimo V2 Pro",
      description: "MiMo V2 Pro via OpenCode",
      maxOutputTokens: 32_000,
      contextWindow: 128_000,
      temperature: 0,
      dollarSigns: 2,
    },
    {
      name: "mimo-v2-omni",
      displayName: "Mimo V2 Omni",
      description: "MiMo V2 Omni via OpenCode",
      maxOutputTokens: 32_000,
      contextWindow: 128_000,
      temperature: 0,
      dollarSigns: 2,
    },
    {
      name: "minimax-m3",
      displayName: "MiniMax M3",
      description: "MiniMax M3 via OpenCode",
      maxOutputTokens: 32_000,
      contextWindow: 204_800,
      temperature: 0,
      dollarSigns: 2,
    },
    {
      name: "minimax-m2.7",
      displayName: "MiniMax M2.7",
      description: "MiniMax M2.7 via OpenCode",
      maxOutputTokens: 32_000,
      contextWindow: 204_800,
      temperature: 0,
      dollarSigns: 1,
    },
    {
      name: "minimax-m2.5",
      displayName: "MiniMax M2.5",
      description: "MiniMax M2.5 via OpenCode",
      maxOutputTokens: 32_000,
      contextWindow: 204_800,
      temperature: 0,
      dollarSigns: 1,
    },
    {
      name: "qwen3.8-max",
      displayName: "Qwen 3.8 Max",
      description: "Alibaba's Qwen 3.8 Max via OpenCode",
      maxOutputTokens: 32_000,
      contextWindow: 128_000,
      temperature: 0,
      dollarSigns: 3,
    },
    {
      name: "qwen3.7-max",
      displayName: "Qwen 3.7 Max",
      description: "Alibaba's Qwen 3.7 Max via OpenCode",
      maxOutputTokens: 32_000,
      contextWindow: 128_000,
      temperature: 0,
      dollarSigns: 2,
    },
    {
      name: "qwen3.7-plus",
      displayName: "Qwen 3.7 Plus",
      description: "Alibaba's Qwen 3.7 Plus via OpenCode",
      maxOutputTokens: 32_000,
      contextWindow: 128_000,
      temperature: 0,
      dollarSigns: 2,
    },
    {
      name: "qwen3.6-plus",
      displayName: "Qwen 3.6 Plus",
      description: "Alibaba's Qwen 3.6 Plus via OpenCode",
      maxOutputTokens: 32_000,
      contextWindow: 128_000,
      temperature: 0,
      dollarSigns: 1,
    },
    {
      name: "qwen3.5-plus",
      displayName: "Qwen 3.5 Plus",
      description: "Alibaba's Qwen 3.5 Plus via OpenCode",
      maxOutputTokens: 32_000,
      contextWindow: 128_000,
      temperature: 0,
      dollarSigns: 1,
    },
    {
      name: "deepseek-v4-pro",
      displayName: "DeepSeek V4 Pro",
      description: "DeepSeek V4 Pro via OpenCode",
      maxOutputTokens: 32_000,
      contextWindow: 128_000,
      temperature: 0,
      dollarSigns: 3,
    },
    {
      name: "deepseek-v4-flash",
      displayName: "DeepSeek V4 Flash",
      description: "DeepSeek V4 Flash via OpenCode",
      maxOutputTokens: 32_000,
      contextWindow: 128_000,
      temperature: 0,
      dollarSigns: 1,
    },
    {
      name: "hy3",
      displayName: "HY3",
      description: "HY3 model via OpenCode",
      maxOutputTokens: 32_000,
      contextWindow: 128_000,
      temperature: 0,
      dollarSigns: 2,
    },
    {
      name: "hy3-preview",
      displayName: "HY3 Preview",
      description: "HY3 Preview model via OpenCode",
      maxOutputTokens: 32_000,
      contextWindow: 128_000,
      temperature: 0,
      dollarSigns: 2,
    },
  ],
  kilocode: [
    {
      name: "kilo-auto/free",
      displayName: "Kilo Auto ★ Free",
      description: "Kilo's automatic free-tier model",
      maxOutputTokens: 32_000,
      contextWindow: 128_000,
      temperature: 0,
      dollarSigns: 0,
    },
    {
      name: "kilo-auto/frontier",
      displayName: "Kilo Auto Frontier",
      description: "Highest performance and capability for any task",
      maxOutputTokens: 128_000,
      contextWindow: 1_000_000,
      temperature: 0,
      dollarSigns: 3,
    },
    {
      name: "kilo-auto/balanced",
      displayName: "Kilo Auto Balanced",
      description: "Balanced performance and cost",
      maxOutputTokens: 64_000,
      contextWindow: 512_000,
      temperature: 0,
      dollarSigns: 2,
    },
    {
      name: "kilo-auto/efficient",
      displayName: "Kilo Auto Efficient",
      description: "Fast and cost-efficient responses",
      maxOutputTokens: 32_000,
      contextWindow: 256_000,
      temperature: 0,
      dollarSigns: 1,
    },
    {
      name: "kilocode/default",
      displayName: "Kilocode Default",
      description: "Kilocode's default model",
      maxOutputTokens: 32_000,
      contextWindow: 128_000,
      temperature: 0,
      dollarSigns: 2,
    },
  ],
};

export const FREE_OPENROUTER_MODEL_NAMES = MODEL_OPTIONS.openrouter
  .filter(
    (model) => model.name.endsWith(":free") || model.name.endsWith("/free"),
  )
  .map((model) => model.name);

export const PROVIDER_TO_ENV_VAR: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GEMINI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  azure: "AZURE_API_KEY",
  xai: "XAI_API_KEY",
  bedrock: "AWS_BEARER_TOKEN_BEDROCK",
  minimax: "MINIMAX_API_KEY",
  opencode: "OPENCODE_API_KEY",
  kilocode: "KILOCODE_API_KEY",
};

export const CLOUD_PROVIDERS: Record<
  string,
  {
    displayName: string;
    hasFreeTier?: boolean;
    websiteUrl?: string;
    gatewayPrefix: string;
    secondary?: boolean;
  }
> = {
  auto: {
    displayName: "Zenith Auto",
    hasFreeTier: true,
    websiteUrl: "https://www.dyad.sh",
    gatewayPrefix: "",
  },

  openai: {
    displayName: "OpenAI",
    hasFreeTier: false,
    websiteUrl: "https://platform.openai.com/api-keys",
    gatewayPrefix: "",
  },
  anthropic: {
    displayName: "Anthropic",
    hasFreeTier: false,
    websiteUrl: "https://console.anthropic.com/settings/keys",
    gatewayPrefix: "anthropic/",
  },
  google: {
    displayName: "Google",
    hasFreeTier: true,
    websiteUrl: "https://aistudio.google.com/api-keys",
    gatewayPrefix: "gemini/",
  },
  vertex: {
    displayName: "Google Vertex AI",
    hasFreeTier: false,
    websiteUrl: "https://console.cloud.google.com/vertex-ai",
    // Use the same gateway prefix as Google Gemini for Dyad Pro compatibility.
    gatewayPrefix: "gemini/",
    secondary: true,
  },
  openrouter: {
    displayName: "OpenRouter",
    hasFreeTier: true,
    websiteUrl: "https://openrouter.ai/settings/keys",
    gatewayPrefix: "openrouter/",
  },
  azure: {
    displayName: "Azure OpenAI",
    hasFreeTier: false,
    websiteUrl: "https://portal.azure.com/",
    gatewayPrefix: "",
    secondary: true,
  },
  xai: {
    displayName: "xAI",
    hasFreeTier: false,
    websiteUrl: "https://console.x.ai/",
    gatewayPrefix: "xai/",
    secondary: true,
  },
  bedrock: {
    displayName: "AWS Bedrock",
    hasFreeTier: false,
    websiteUrl: "https://console.aws.amazon.com/bedrock/",
    gatewayPrefix: "bedrock/",
    secondary: true,
  },
  minimax: {
    displayName: "MiniMax",
    hasFreeTier: false,
    websiteUrl: "https://platform.minimax.io/",
    gatewayPrefix: "minimax/",
    secondary: true,
  },
  opencode: {
    displayName: "OpenCode",
    hasFreeTier: false,
    websiteUrl: "https://opencode.ai/docs/go/",
    gatewayPrefix: "opencode/",
  },
  kilocode: {
    displayName: "Kilocode",
    hasFreeTier: true,
    websiteUrl: "https://kilo.ai",
    gatewayPrefix: "kilocode/",
    secondary: true,
  },
};

export const LOCAL_PROVIDERS: Record<
  string,
  {
    displayName: string;
    hasFreeTier: boolean;
  }
> = {
  ollama: {
    displayName: "Ollama",
    hasFreeTier: true,
  },
  lmstudio: {
    displayName: "LM Studio",
    hasFreeTier: true,
  },
};
