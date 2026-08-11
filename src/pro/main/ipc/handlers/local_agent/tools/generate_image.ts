import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import log from "electron-log";
import { z } from "zod";

import { DyadError, DyadErrorKind } from "@/errors/dyad_error";
import { getLanguageModelProviders } from "@/ipc/shared/language_model_helpers";
import { ImageGenerationApiResponseSchema } from "@/ipc/types/image_generation";
import { DYAD_MEDIA_DIR_NAME } from "@/ipc/utils/media_path_utils";
import { getEnvVar } from "@/ipc/utils/read_env";
import { normalizeProviderApiKeyInput } from "@/lib/providerApiKey";
import { readSettings } from "@/main/settings";

import {
  AgentContext,
  escapeXmlAttr,
  escapeXmlContent,
  ToolDefinition,
} from "./types";

const logger = log.scope("generate_image");
const IMAGE_TIMEOUT_MS = 120_000;
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;

const generateImageSchema = z.object({
  prompt: z
    .string()
    .trim()
    .min(1)
    .describe(
      "Detailed image prompt including subject, style, composition, colors, mood, and intended use.",
    ),
});

const DESCRIPTION = `Generate an image through the image provider configured in
Settings and save it under .dyad/media. This tool never sends provider keys to
the Dyad hosted engine.

Configure an OpenAI provider or an OpenAI-compatible custom provider, then set
its image model from Settings → Providers → Image generation model.`;

interface ImageEndpoint {
  providerId: string;
  providerName: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

function joinApiPath(baseUrl: string, suffix: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${suffix.replace(/^\/+/, "")}`;
}

async function resolveImageEndpoint(): Promise<ImageEndpoint> {
  const settings = readSettings();
  const providerId = settings.imageGenerationProvider || "openai";
  const providers = await getLanguageModelProviders();
  const provider = providers.find((candidate) => candidate.id === providerId);

  if (!provider) {
    throw new DyadError(
      `Image provider "${providerId}" was not found. Configure it in Settings → Providers.`,
      DyadErrorKind.NotFound,
    );
  }

  const providerSetting = settings.providerSettings?.[providerId] as
    | { apiKey?: { value?: string }; imageModel?: string }
    | undefined;
  const apiKey = normalizeProviderApiKeyInput(
    providerSetting?.apiKey?.value ||
      (provider.envVarName ? getEnvVar(provider.envVarName) : undefined),
  );
  if (!apiKey) {
    // Custom build: image generation needs a provider API key. Surface
    // a clear error so the agent can tell the user what to configure
    // without aborting the entire turn.
    throw new DyadError(
      `Image generation needs a ${provider.name} API key. Add one in Settings → Providers.`,
      DyadErrorKind.Auth,
    );
  }

  let baseUrl: string;
  if (providerId === "openai") {
    baseUrl = "https://api.openai.com/v1";
  } else if (provider.type === "custom" && provider.apiBaseUrl) {
    baseUrl = provider.apiBaseUrl;
  } else {
    throw new DyadError(
      `${provider.name} is not configured as an OpenAI-compatible image provider. Select OpenAI or a custom provider with an /images/generations endpoint in Settings.`,
      DyadErrorKind.Precondition,
    );
  }

  const model =
    settings.imageGenerationModel ||
    providerSetting?.imageModel ||
    (providerId === "openai" ? "gpt-image-1" : undefined);
  if (!model) {
    throw new DyadError(
      `Choose an image-generation model for ${provider.name} in Settings → Providers.`,
      DyadErrorKind.Precondition,
    );
  }

  return {
    providerId,
    providerName: provider.name,
    baseUrl,
    apiKey,
    model,
  };
}

async function callGenerateImage(prompt: string) {
  const endpoint = await resolveImageEndpoint();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), IMAGE_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(joinApiPath(endpoint.baseUrl, "images/generations"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${endpoint.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt,
        model: endpoint.model,
        response_format: "b64_json",
      }),
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new DyadError(
        "Image generation timed out.",
        DyadErrorKind.External,
        { cause: error },
      );
    }
    throw new DyadError(
      `Could not reach ${endpoint.providerName} image generation.`,
      DyadErrorKind.External,
      { cause: error },
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    // Deliberately do not include response bodies: providers may echo request
    // metadata and credentials in diagnostics.
    throw new DyadError(
      `Image generation failed via ${endpoint.providerName} (HTTP ${response.status}).`,
      response.status === 401 || response.status === 403
        ? DyadErrorKind.Auth
        : response.status === 429
          ? DyadErrorKind.RateLimited
          : DyadErrorKind.External,
    );
  }

  const parsed = ImageGenerationApiResponseSchema.safeParse(
    await response.json(),
  );
  if (!parsed.success || !parsed.data.data?.length) {
    throw new DyadError(
      `${endpoint.providerName} returned an invalid image response.`,
      DyadErrorKind.External,
    );
  }
  return parsed.data.data[0];
}

async function saveGeneratedImage(
  imageData: z.infer<typeof ImageGenerationApiResponseSchema>["data"][number],
  appPath: string,
): Promise<string> {
  const mediaDir = path.join(appPath, DYAD_MEDIA_DIR_NAME);
  await fs.mkdir(mediaDir, { recursive: true });

  const fileName = `generated-${Date.now()}-${crypto.randomBytes(8).toString("hex")}.png`;
  const filePath = path.join(mediaDir, fileName);
  const relativePath = path.join(DYAD_MEDIA_DIR_NAME, fileName);

  let buffer: Buffer;
  if (imageData.b64_json) {
    buffer = Buffer.from(imageData.b64_json, "base64");
  } else if (imageData.url) {
    const url = new URL(imageData.url);
    if (url.protocol !== "https:") {
      throw new DyadError(
        "Generated image download URL must use HTTPS.",
        DyadErrorKind.External,
      );
    }
    const response = await fetch(url);
    if (!response.ok) {
      throw new DyadError(
        `Failed to download generated image (HTTP ${response.status}).`,
        DyadErrorKind.External,
      );
    }
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > MAX_IMAGE_BYTES) {
      throw new DyadError(
        "Generated image exceeds the 50 MB safety limit.",
        DyadErrorKind.Validation,
      );
    }
    buffer = Buffer.from(bytes);
  } else {
    throw new DyadError(
      "Image provider returned no image data.",
      DyadErrorKind.External,
    );
  }

  if (buffer.byteLength > MAX_IMAGE_BYTES) {
    throw new DyadError(
      "Generated image exceeds the 50 MB safety limit.",
      DyadErrorKind.Validation,
    );
  }
  await fs.writeFile(filePath, buffer);
  return relativePath;
}

export const generateImageTool: ToolDefinition<
  z.infer<typeof generateImageSchema>
> = {
  name: "generate_image",
  description: DESCRIPTION,
  inputSchema: generateImageSchema,
  defaultConsent: "always",
  modifiesState: true,

  getConsentPreview: (args) => `Generate image: "${args.prompt}"`,

  shouldTrackMutation: (_args, result) =>
    result.startsWith("Image generated and saved"),

  buildXml: (args, isComplete) => {
    if (!args.prompt) return undefined;
    if (isComplete) return undefined;
    return `<dyad-image-generation prompt="${escapeXmlAttr(args.prompt)}">`;
  },

  execute: async (args, ctx: AgentContext) => {
    logger.log(`Executing configured image generation: ${args.prompt}`);
    ctx.onXmlStream(
      `<dyad-image-generation prompt="${escapeXmlAttr(args.prompt)}">`,
    );

    try {
      const imageData = await callGenerateImage(args.prompt);
      const relativePath = await saveGeneratedImage(imageData, ctx.appPath);
      ctx.onXmlComplete(
        `<dyad-image-generation prompt="${escapeXmlAttr(args.prompt)}" path="${escapeXmlAttr(relativePath)}">${escapeXmlContent(relativePath)}</dyad-image-generation>`,
      );
      return `Image generated and saved to: ${relativePath}\nUse copy_file to move it into the app's public/assets directory if needed.`;
    } catch (error) {
      ctx.onXmlComplete(
        `<dyad-image-generation prompt="${escapeXmlAttr(args.prompt)}"></dyad-image-generation>`,
      );
      throw error;
    }
  },
};
