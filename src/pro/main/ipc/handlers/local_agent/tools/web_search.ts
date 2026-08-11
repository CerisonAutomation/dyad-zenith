import { z } from "zod";
import log from "electron-log";

import { DyadError, DyadErrorKind } from "@/errors/dyad_error";

import { searchWeb } from "./direct_web";
import {
  AgentContext,
  escapeXmlAttr,
  escapeXmlContent,
  ToolDefinition,
} from "./types";

const logger = log.scope("web_search");

const webSearchSchema = z.object({
  query: z.string().trim().min(1).max(500).describe("The web search query"),
});

const DESCRIPTION = `Search the live public web without using the Dyad hosted engine.

Use this for current documentation, releases, compatibility notes, exact error
messages, security advisories, and other information that may be newer than the
model's training data. Results are navigation/evidence targets; use web_fetch on
important results before relying on detailed claims.`;

export const webSearchTool: ToolDefinition<z.infer<typeof webSearchSchema>> = {
  name: "web_search",
  description: DESCRIPTION,
  inputSchema: webSearchSchema,
  defaultConsent: "ask",

  getConsentPreview: (args) => `Search the web: "${args.query}"`,

  execute: async (args, ctx: AgentContext) => {
    logger.log(`Executing direct web search: ${args.query}`);
    ctx.onXmlStream(
      `<dyad-web-search query="${escapeXmlAttr(args.query)}">Searching…`,
    );

    const results = await searchWeb(args.query, 8);
    if (results.length === 0) {
      throw new DyadError(
        "Web search returned no results.",
        DyadErrorKind.NotFound,
      );
    }

    const text = results
      .map((result, index) => {
        const snippet = result.snippet ? `\n   ${result.snippet}` : "";
        return `${index + 1}. ${result.title}\n   ${result.url}${snippet}`;
      })
      .join("\n\n");

    ctx.onXmlComplete(
      `<dyad-web-search query="${escapeXmlAttr(args.query)}">${escapeXmlContent(text)}</dyad-web-search>`,
    );
    return text;
  },
};
