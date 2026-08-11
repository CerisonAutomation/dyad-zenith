import { z } from "zod";
import log from "electron-log";

import {
  capturePublicWebScreenshot,
  fetchWebPage,
} from "./direct_web";
import {
  getImageDimensionsFromDataUrl,
  isImageTooLarge,
  MAX_IMAGE_DIMENSION,
} from "./image_utils";
import { AgentContext, escapeXmlContent, ToolDefinition } from "./types";

const logger = log.scope("web_crawl");
const MAX_TEXT_SNIPPET_LENGTH = 16_000;

const webCrawlSchema = z.object({
  url: z.string().describe("Public URL to inspect for website recreation"),
});

const DESCRIPTION = `Inspect a public website for recreation/clone work. Fetches a
markdown snapshot directly and makes a best-effort isolated Electron screenshot.
Use only when the user asks to clone, recreate, replicate, mimic, or closely
reference a specific site URL.`;

const CLONE_INSTRUCTIONS_WITH_SCREENSHOT = `Replicate the referenced website using the screenshot as the primary visual reference and the markdown snapshot as structural/content evidence. Do not hotlink third-party assets; create local placeholders or replacement assets in the project.`;
const CLONE_INSTRUCTIONS_WITHOUT_SCREENSHOT = `Replicate the referenced website using the markdown snapshot as structural/content evidence. The screenshot capture was unavailable, so do not invent pixel-perfect visual details. Do not hotlink third-party assets; create local placeholders or replacement assets in the project.`;

export const webCrawlTool: ToolDefinition<z.infer<typeof webCrawlSchema>> = {
  name: "web_crawl",
  description: DESCRIPTION,
  inputSchema: webCrawlSchema,
  defaultConsent: "ask",

  getConsentPreview: (args) => `Inspect website: "${args.url}"`,

  buildXml: (args, isComplete) => {
    if (!args.url) return undefined;
    let xml = `<dyad-web-crawl>${escapeXmlContent(args.url)}`;
    if (isComplete) xml += "</dyad-web-crawl>";
    return xml;
  },

  execute: async (args, ctx: AgentContext) => {
    logger.log(`Executing direct web crawl: ${args.url}`);
    ctx.onXmlStream(`<dyad-web-crawl>${escapeXmlContent(args.url)}`);

    const page = await fetchWebPage(args.url);
    const screenshot = await capturePublicWebScreenshot(page.url);
    const dimensions = screenshot
      ? getImageDimensionsFromDataUrl(screenshot)
      : undefined;
    const screenshotTooLarge = Boolean(
      dimensions && isImageTooLarge(dimensions),
    );
    const includeScreenshot = Boolean(screenshot && !screenshotTooLarge);

    if (screenshotTooLarge && dimensions) {
      logger.warn(
        `Crawl screenshot ${dimensions.width}x${dimensions.height} exceeds ${MAX_IMAGE_DIMENSION}px; returning markdown only.`,
      );
    }

    const content: Parameters<typeof ctx.appendUserMessage>[0] = [
      {
        type: "text",
        text: includeScreenshot
          ? CLONE_INSTRUCTIONS_WITH_SCREENSHOT
          : CLONE_INSTRUCTIONS_WITHOUT_SCREENSHOT,
      },
    ];

    if (includeScreenshot && screenshot) {
      content.push({ type: "image-url", url: screenshot });
    }

    content.push({
      type: "text",
      text: formatSnippet("Markdown snapshot:", page.markdown, "markdown"),
    });
    ctx.appendUserMessage(content);
    ctx.onXmlComplete(
      `<dyad-web-crawl>${escapeXmlContent(page.url)}</dyad-web-crawl>`,
    );

    return includeScreenshot
      ? "Website inspection completed with markdown and screenshot evidence."
      : "Website inspection completed with markdown evidence; screenshot capture was unavailable or too large.";
  },
};

export function formatSnippet(
  label: string,
  value: string,
  lang: string,
): string {
  const sanitized = truncateText(value).replace(/```/g, "` ` `");
  return `${label}:\n\`\`\`${lang}\n${sanitized}\n\`\`\``;
}

function truncateText(value: string): string {
  if (value.length <= MAX_TEXT_SNIPPET_LENGTH) return value;
  return `${value.slice(0, MAX_TEXT_SNIPPET_LENGTH)}\n\n[truncated]`;
}
