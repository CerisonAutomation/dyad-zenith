import { z } from "zod";
import { ToolDefinition, escapeXmlAttr } from "./types";
import { DyadError, DyadErrorKind } from "@/errors/dyad_error";
import { db } from "@/db";
import { prompts } from "@/db/schema";
import { eq, or } from "drizzle-orm";

import addAuthentication from "@/prompts/guides/add-authentication.md?raw";
import addEmailVerification from "@/prompts/guides/add-email-verification.md?raw";
import addPasswordReset from "@/prompts/guides/add-password-reset.md?raw";
import codeFormatSql from "@/prompts/guides/code-format-sql.md?raw";
import codeReviewRigor from "@/prompts/guides/code-review-rigor.md?raw";
import databaseCreateMigration from "@/prompts/guides/database-create-migration.md?raw";
import databaseFunctions from "@/prompts/guides/database-functions.md?raw";
import databaseRlsPolicies from "@/prompts/guides/database-rls-policies.md?raw";
import declarativeDatabaseSchema from "@/prompts/guides/declarative-database-schema.md?raw";
import deepResearch from "@/prompts/guides/deep-research.md?raw";
import metaPrompting from "@/prompts/guides/meta-prompting.md?raw";
import fullAuto from "@/prompts/guides/full-auto.md?raw";
import promptFormula from "@/prompts/guides/prompt-formula.md?raw";
import specDrivenDevelopment from "@/prompts/guides/spec-driven-development.md?raw";
import proactiveSelfImproving from "@/prompts/guides/proactive-self-improving.md?raw";
import testDrivenDevelopment from "@/prompts/guides/test-driven-development.md?raw";
import vibeCodingWorkflow from "@/prompts/guides/vibe-coding-workflow.md?raw";
import { filterGuideByFramework } from "@/prompts/guides/filter_guide_by_framework";

/**
 * Registry of available guides. To add a new guide, import its .md file
 * with ?raw and add an entry here.
 */
const GUIDES: Record<string, string> = {
  "add-authentication": addAuthentication,
  "add-email-verification": addEmailVerification,
  "add-password-reset": addPasswordReset,
  "code-format-sql": codeFormatSql,
  "code-review-rigor": codeReviewRigor,
  "database-create-migration": databaseCreateMigration,
  "database-functions": databaseFunctions,
  "database-rls-policies": databaseRlsPolicies,
  "declarative-database-schema": declarativeDatabaseSchema,
  "deep-research": deepResearch,
  "meta-prompting": metaPrompting,
  "full-auto": fullAuto,
  "proactive-self-improving": proactiveSelfImproving,
  "prompt-formula": promptFormula,
  "spec-driven-development": specDrivenDevelopment,
  "test-driven-development": testDrivenDevelopment,
  "vibe-coding-workflow": vibeCodingWorkflow,
};

// Title/description index derived from each guide's raw markdown (first
// heading + first paragraph). Shared by the Library UI (prompts:list-guides)
// and the read_guide tool's availability list.
export function getGuideIndex(): Array<{
  slug: string;
  title: string;
  description: string;
}> {
  return Object.entries(GUIDES).map(([slug, raw]) => {
    const firstHeading = raw.match(/^#\s+(.+)$/m);
    const firstParagraph = raw
      .slice(firstHeading ? firstHeading.index! + firstHeading[0].length : 0)
      .trim()
      .split(/\n{2,}/)[0]
      ?.replace(/\s+/g, " ")
      .trim();
    return {
      slug,
      title: (firstHeading?.[1] ?? slug).replace(/^Guide:\s*/i, "").trim(),
      description: (firstParagraph ?? "").slice(0, 160),
    };
  });
}

const readGuideSchema = z.object({
  guide: z
    .string()
    .describe(
      "Name of the guide to read (e.g. 'add-authentication', 'code-format-sql', 'database-functions', 'database-rls-policies', 'database-create-migration', 'declarative-database-schema', 'spec-driven-development', 'test-driven-development', 'code-review-rigor', 'meta-prompting', 'prompt-formula', 'vibe-coding-workflow', 'deep-research', 'proactive-self-improving', 'full-auto')",
    ),
});

function normalizePromptKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
}

async function findUserPrompt(name: string): Promise<string | null> {
  const normalized = normalizePromptKey(name);
  if (!normalized) {
    return null;
  }
  try {
    const rows = db
      .select({
        title: prompts.title,
        slug: prompts.slug,
        content: prompts.content,
      })
      .from(prompts)
      .limit(50)
      .all();
    const hit = rows.find(
      (r) =>
        normalizePromptKey(r.slug ?? "") === normalized ||
        normalizePromptKey(r.title) === normalized,
    );
    return hit?.content ?? null;
  } catch {
    return null;
  }
}

async function listUserPromptNames(): Promise<string[]> {
  try {
    return db
      .select({ title: prompts.title })
      .from(prompts)
      .limit(50)
      .all()
      .map((r) => r.title)
      .filter(Boolean);
  } catch {
    return [];
  }
}

export const readGuideTool: ToolDefinition<z.infer<typeof readGuideSchema>> = {
  name: "read_guide",
  description:
    "Read a detailed instruction guide. Use this when the system prompt tells you to load a guide before implementing a feature. " +
    "Built-in guides include database/Postgres workflows (code-format-sql, database-functions, database-rls-policies, " +
    "database-create-migration, declarative-database-schema), engineering workflows (spec-driven-development, " +
    "test-driven-development, code-review-rigor) and auth guides. Guides the user uploaded in Library → Prompts " +
    "are also readable here by their title.",
  inputSchema: readGuideSchema,
  defaultConsent: "always",

  getConsentPreview: (args) => `Read guide: ${args.guide}`,

  buildXml: (args) => {
    if (!args.guide) return undefined;
    return `<dyad-read-guide name="${escapeXmlAttr(args.guide)}"></dyad-read-guide>`;
  },

  execute: async (args, ctx) => {
    const compiled = GUIDES[args.guide];
    if (compiled) {
      return filterGuideByFramework(compiled, ctx.frameworkType);
    }

    // Fall back to prompts the user uploaded via the Library → Prompts UI.
    const userPrompt = await findUserPrompt(args.guide);
    if (userPrompt) {
      return filterGuideByFramework(userPrompt, ctx.frameworkType);
    }

    const userPromptNames = await listUserPromptNames();
    const available = [...Object.keys(GUIDES), ...userPromptNames].join(", ");
    throw new DyadError(
      `Guide "${args.guide}" not found. Available guides: ${available}`,
      DyadErrorKind.NotFound,
    );
  },
};
