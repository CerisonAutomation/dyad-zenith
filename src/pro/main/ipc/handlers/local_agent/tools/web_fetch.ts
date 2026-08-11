import { z } from "zod";
import log from "electron-log";

import { DyadError, DyadErrorKind } from "@/errors/dyad_error";

import { fetchWebPage } from "./direct_web";
import { AgentContext, escapeXmlContent, ToolDefinition } from "./types";

const logger = log.scope("web_fetch");
const MAX_CONTENT_LENGTH = 80_000;

const webFetchSchema = z.object({
  url: z.string().describe("Public HTTP(S) URL to fetch content from"),
});

const DESCRIPTION = `Fetch and read a public web page directly from the desktop app.

Use this when the user provides a URL and you need the live page contents. The
fetcher follows a small number of safe redirects, rejects private/reserved
network targets, caps response size, and converts HTML into compact markdown.

Use web_search when you do not know the URL. Fetch only the specific pages needed for the task.`;

function truncateContent(value: string): string {
  if (value.length <= MAX_CONTENT_LENGTH) return value;
  return `${value.slice(0, MAX_CONTENT_LENGTH)}\n\n<!-- truncated -->`;
}

export const webFetchTool: ToolDefinition<z.infer<typeof webFetchSchema>> = {
  name: "web_fetch",
  description: DESCRIPTION,
  inputSchema: webFetchSchema,
  defaultConsent: "ask",

  getConsentPreview: (args) => `Fetch URL: "${args.url}"`,

  buildXml: (args, isComplete) => {
    if (!args.url) return undefined;
    if (isComplete) return undefined;
    return `<dyad-web-fetch>${escapeXmlContent(args.url)}`;
  },

  execute: async (args, ctx: AgentContext) => {
    logger.log(`Executing direct web fetch: ${args.url}`);
    ctx.onXmlStream(`<dyad-web-fetch>${escapeXmlContent(args.url)}`);

    try {
      const page = await fetchWebPage(args.url);
      const content = page.markdown.trim();
      if (!content) {
        throw new DyadError(
          "No readable content was returned from the URL.",
          DyadErrorKind.NotFound,
        );
      }

      const title = page.title ? `# ${page.title}\n\n` : "";
      const result = `${title}Source: ${page.url}\n\n${content}`;
      ctx.onXmlComplete(
        `<dyad-web-fetch>${escapeXmlContent(page.url)}</dyad-web-fetch>`,
      );
      return truncateContent(result);
    } catch (error) {
      ctx.onXmlComplete(
        `<dyad-web-fetch>${escapeXmlContent(args.url)}</dyad-web-fetch>`,
      );
      throw error;
    }
  },
};
