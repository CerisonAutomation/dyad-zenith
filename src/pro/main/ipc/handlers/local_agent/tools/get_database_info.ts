import { z } from "zod";
import {
  ToolDefinition,
  AgentContext,
  escapeXmlAttr,
  escapeXmlContent,
} from "./types";
import {
  getSupabaseProjectInfo,
  getSupabaseTableSchema,
} from "../../../../../../supabase_admin/supabase_context";
import {
  getNeonProjectInfo,
  getNeonTableSchema,
} from "../../../../../../neon_admin/neon_context";
import { DyadError, DyadErrorKind } from "@/errors/dyad_error";

const getDatabaseInfoSchema = z.object({
  database: z
    .enum(["auto", "supabase", "neon"])
    .optional()
    .describe(
      "Which connected database to query. Defaults to auto (supabase if connected, else neon).",
    ),
  tableName: z
    .string()
    .optional()
    .describe(
      "Optional table name to get the schema (DDL) for. If omitted, returns the project overview (project ID, keys, branches, table names).",
    ),
  includeDbFunctions: z
    .boolean()
    .optional()
    .describe(
      "When true, includes database functions in the project overview. Supabase only. Defaults to false.",
    ),
});

type DatabaseKind = "supabase" | "neon";

function resolveDatabase(
  requested: "auto" | "supabase" | "neon" | undefined,
  ctx: AgentContext,
): DatabaseKind {
  if (requested === "supabase") {
    if (!ctx.supabaseProjectId) {
      throw new DyadError(
        "Supabase is not connected to this app",
        DyadErrorKind.Precondition,
      );
    }
    return "supabase";
  }
  if (requested === "neon") {
    if (!ctx.neonProjectId || !ctx.neonActiveBranchId) {
      throw new DyadError(
        "Neon is not connected to this app",
        DyadErrorKind.Precondition,
      );
    }
    return "neon";
  }
  if (ctx.supabaseProjectId) return "supabase";
  if (ctx.neonProjectId && ctx.neonActiveBranchId) return "neon";
  throw new DyadError(
    "No database is connected to this app",
    DyadErrorKind.Precondition,
  );
}

export const getDatabaseInfoTool: ToolDefinition<
  z.infer<typeof getDatabaseInfoSchema>
> = {
  name: "get_database_info",
  description:
    "Inspect the app's connected database (Supabase or Neon). Without tableName, returns the project overview: project ID, keys, branches, and table names. With tableName, returns that table's PostgreSQL schema (DDL, constraints, indexes, policies). Use this to discover tables before writing SQL or queries.",
  inputSchema: getDatabaseInfoSchema,
  defaultConsent: "always",
  isEnabled: (ctx) =>
    !!ctx.supabaseProjectId ||
    (!!ctx.neonProjectId && !!ctx.neonActiveBranchId),

  getConsentPreview: () => "Get database info",

  execute: async (args, ctx: AgentContext) => {
    const db = resolveDatabase(args?.database, ctx);
    const tableName = args?.tableName?.trim() || undefined;

    if (tableName) {
      const tableAttr = ` table="${escapeXmlAttr(tableName)}"`;
      ctx.onXmlStream(
        `<dyad-db-table-schema provider="${db === "supabase" ? "Supabase" : "Neon"}"${tableAttr}></dyad-db-table-schema>`,
      );
      const schema =
        db === "supabase"
          ? await getSupabaseTableSchema({
              supabaseProjectId: ctx.supabaseProjectId ?? "",
              organizationSlug: ctx.supabaseOrganizationSlug ?? null,
              tableName,
            })
          : await getNeonTableSchema({
              projectId: ctx.neonProjectId ?? "",
              branchId: ctx.neonActiveBranchId ?? "",
              tableName,
            });
      ctx.onXmlComplete(
        `<dyad-db-table-schema provider="${db === "supabase" ? "Supabase" : "Neon"}"${tableAttr}>\n${escapeXmlContent(schema)}\n</dyad-db-table-schema>`,
      );
      return schema;
    }

    if (db === "supabase") {
      const info = await getSupabaseProjectInfo({
        supabaseProjectId: ctx.supabaseProjectId!,
        organizationSlug: ctx.supabaseOrganizationSlug ?? null,
        includeDbFunctions: args?.includeDbFunctions,
      });
      ctx.onXmlComplete(
        `<dyad-supabase-project-info>\n${escapeXmlContent(info)}\n</dyad-supabase-project-info>`,
      );
      return info;
    }

    const info = await getNeonProjectInfo({
      projectId: ctx.neonProjectId!,
      branchId: ctx.neonActiveBranchId ?? "",
    });
    ctx.onXmlComplete(
      `<dyad-neon-project-info>\n${escapeXmlContent(info)}\n</dyad-neon-project-info>`,
    );
    return info;
  },
};
