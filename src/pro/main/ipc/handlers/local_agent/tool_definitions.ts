/**
 * Tool definitions for Local Agent v2
 * Each tool includes a zod schema, description, and execute function
 */

import { IpcMainInvokeEvent } from "electron";
import { readSettings, writeSettings } from "@/main/settings";
import type { SqlConsentMetadata } from "@/shared/sqlConsentMetadata";
import {
  rememberUserInputSubscriber,
  userInputRegistry,
} from "@/user_input/main";
import { writeFileTool } from "./tools/write_file";
import { deleteFileTool } from "./tools/delete_file";
import { renameFileTool } from "./tools/rename_file";
import { copyFileTool } from "./tools/copy_file";
import { addDependencyTool } from "./tools/add_dependency";
import { executeSqlTool } from "./tools/execute_sql";

import { readFileTool } from "./tools/read_file";
import { listFilesTool } from "./tools/list_files";
import { setChatSummaryTool } from "./tools/set_chat_summary";
import { addIntegrationTool } from "./tools/add_integration";
import { enableNitroTool } from "./tools/enable_nitro";
import { readLogsTool } from "./tools/read_logs";
import { searchReplaceTool } from "./tools/search_replace";
import { webSearchTool } from "./tools/web_search";
import { webFetchTool } from "./tools/web_fetch";
import { generateImageTool } from "./tools/generate_image";
import { updateTodosTool } from "./tools/update_todos";
import { runTypeChecksTool } from "./tools/run_type_checks";
import { runTestsTool } from "./tools/run_tests";
import { appLifecycleTool } from "./tools/app_lifecycle";
import { buildAppTool } from "./tools/build_app";
import { getDatabaseInfoTool } from "./tools/get_database_info";
import { grepTool } from "./tools/grep";
import { codeSearchTool } from "./tools/code_search";
import { exploreCodeTool } from "./tools/explore_code";
import { exploreChatHistoryTool } from "./tools/explore_chat_history";
import { searchChatsTool } from "./tools/search_chats";
import { readChatTool } from "./tools/read_chat";
import { planOrExecuteTool } from "./tools/plan_or_execute";
import { readGuideTool } from "./tools/read_guide";
import { executeSandboxScriptTool } from "./tools/execute_sandbox_script";
import { searchMcpToolsTool } from "./tools/search_mcp_tools";
import { getMcpToolSchemaTool } from "./tools/get_mcp_tool_schema";
import { writeAppBlueprintTool } from "./tools/write_app_blueprint";
import { exitPlanTool } from "./tools/exit_plan";
import { multiFetchTool } from "./tools/multi_fetch";
import { codeGraphTool } from "./tools/code_graph";
import { codebaseSummaryTool } from "./tools/codebase_summary";
import { codeReviewerTool } from "./tools/code_reviewer";
import { previewErrorFixerTool } from "./tools/preview_error_fixer";
import { architectureAnalyzerTool } from "./tools/architecture_analyzer";
import { uiUxReviewerTool } from "./tools/ui_ux_reviewer";
import { memoryLeakDetectorTool } from "./tools/memory_leak_detector";
import { webappTesterTool } from "./tools/webapp_tester";
import { productionAuditorTool } from "./tools/production_auditor";
import { errorAnalyzerTool } from "./tools/error_analyzer";
import { dependencyImpactTool } from "./tools/dependency_impact";
import { runtimeErrorCorrelatorTool } from "./tools/runtime_error_correlator";
import { testFailureDiagnoserTool } from "./tools/test_failure_diagnoser";
import {
  gitTool,
} from "./tools/git";
import type { LanguageModelV3ToolResultOutput } from "@ai-sdk/provider";
import {
  escapeXmlAttr,
  escapeXmlContent,
  type ToolDefinition,
  type AgentContext,
  type ToolResult,
} from "./tools/types";
import {
  assertAppBlueprintApproved,
  requireToolConsentOrThrow,
  shouldTrackToolMutation,
  trackAppMutation,
  trackFileEditTool,
} from "./tools/tool_invocation";
import type { AgentToolConsent } from "@/lib/schemas";
import { getSupabaseClientCode } from "@/supabase_admin/supabase_context";
import { getNeonClientCode } from "@/neon_admin/neon_context";
import { DyadError, DyadErrorKind } from "@/errors/dyad_error";
import { ExecuteAddDependencyError } from "@/ipc/processors/executeAddDependency";

function getToolErrorDisplayDetails(error: unknown): string {
  if (error instanceof ExecuteAddDependencyError) {
    return error.displayDetails;
  }

  return error instanceof Error ? error.message : String(error);
}

function getToolErrorSummary(error: unknown): string {
  if (error instanceof ExecuteAddDependencyError) {
    return error.displaySummary;
  }

  return error instanceof Error ? error.message : String(error);
}

// Combined tool definitions array
export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  // Workspace & source control
  readFileTool,
  listFilesTool,
  grepTool,
  codeSearchTool,
  exploreCodeTool,
  writeFileTool,
  searchReplaceTool,
  copyFileTool,
  deleteFileTool,
  renameFileTool,
  gitTool,

  // Project execution
  addDependencyTool,
  executeSqlTool,
  runTypeChecksTool,
  runTestsTool,
  buildAppTool,
  appLifecycleTool,
  executeSandboxScriptTool,

  // App context & integrations
  getDatabaseInfoTool,
  setChatSummaryTool,
  exploreChatHistoryTool,
  searchChatsTool,
  readChatTool,
  addIntegrationTool,
  enableNitroTool,
  readLogsTool,
  readGuideTool,

  // Web, browser-adjacent & extensibility
  webSearchTool,
  webFetchTool,
  multiFetchTool,
  generateImageTool,
  searchMcpToolsTool,
  getMcpToolSchemaTool,

  // Planning and durable task state
  updateTodosTool,
  planOrExecuteTool,
  writeAppBlueprintTool,

  // Evidence-producing engineering intelligence. These inspect real project
  // state; meta-reasoning/orchestrator tools are intentionally not exposed.
  codeGraphTool,
  codebaseSummaryTool,
  codeReviewerTool,
  architectureAnalyzerTool,
  dependencyImpactTool,
  errorAnalyzerTool,
  runtimeErrorCorrelatorTool,
  testFailureDiagnoserTool,
  previewErrorFixerTool,
  memoryLeakDetectorTool,
  uiUxReviewerTool,
  webappTesterTool,
  productionAuditorTool,
];
// ============================================================================
// Agent Tool Name Type (derived from TOOL_DEFINITIONS)
// ============================================================================

export type AgentToolName = (typeof TOOL_DEFINITIONS)[number]["name"];

function getAgentToolConsentSettings(
  toolName: AgentToolName,
  consent: AgentToolConsent,
) {
  const settings = readSettings();
  return {
    agentToolConsents: {
      ...settings.agentToolConsents,
      [toolName]: consent,
    },
  };
}

// ============================================================================
// Agent Tool Consent Management
// ============================================================================

export function getDefaultConsent(toolName: AgentToolName): AgentToolConsent {
  const tool = TOOL_DEFINITIONS.find((t) => t.name === toolName);
  return tool?.defaultConsent ?? "ask";
}

/**
 * When autoApproveNonSchemaSql is enabled, execute_sql calls that the schema
 * classifier determines do not mutate the schema and do not delete data run
 * without a consent prompt. Schema-mutating or data-deleting SQL still
 * requires consent.
 */
export function shouldAutoApproveAgentTool(params: {
  toolName: AgentToolName;
  metadata?: SqlConsentMetadata | null;
  autoApproveNonSchemaSql: boolean | undefined;
}): boolean {
  return (
    params.toolName === "execute_sql" &&
    params.metadata?.sqlMutatesSchema === false &&
    params.metadata?.sqlDeletesData === false &&
    params.autoApproveNonSchemaSql === true
  );
}

export function getAgentToolConsent(toolName: AgentToolName): AgentToolConsent {
  const settings = readSettings();
  const stored = settings.agentToolConsents?.[toolName];
  if (stored) {
    return stored;
  }
  return getDefaultConsent(toolName);
}

export function setAgentToolConsent(
  toolName: AgentToolName,
  consent: AgentToolConsent,
): void {
  writeSettings(getAgentToolConsentSettings(toolName, consent));
}

export function getAllAgentToolConsents(): Record<
  AgentToolName,
  AgentToolConsent
> {
  const settings = readSettings();
  const stored = settings.agentToolConsents ?? {};
  const result: Record<string, AgentToolConsent> = {};

  // Start with defaults, override with stored values
  for (const tool of TOOL_DEFINITIONS) {
    const storedConsent = stored[tool.name];
    if (storedConsent) {
      result[tool.name] = storedConsent;
    } else {
      result[tool.name] = getDefaultConsent(tool.name as AgentToolName);
    }
  }

  return result as Record<AgentToolName, AgentToolConsent>;
}

export async function requireAgentToolConsent(
  event: IpcMainInvokeEvent,
  params: {
    chatId: number;
    toolName: AgentToolName;
    toolDescription?: string | null;
    inputPreview?: string | null;
    metadata?: SqlConsentMetadata | null;
    abortSignal?: AbortSignal;
  },
): Promise<boolean> {
  const current = getAgentToolConsent(params.toolName);

  if (current === "always") return true;
  if (current === "never")
    throw new DyadError(
      "Should not ask for consent for a tool marked as 'never'",
      DyadErrorKind.Internal,
    );

  if (
    shouldAutoApproveAgentTool({
      toolName: params.toolName,
      metadata: params.metadata,
      autoApproveNonSchemaSql: readSettings().autoApproveNonSchemaSql,
    })
  ) {
    return true;
  }

  rememberUserInputSubscriber(event.sender);
  const requestId = userInputRegistry.request({
    kind: "agent-consent",
    chatId: params.chatId,
    toolName: params.toolName,
    toolDescription: params.toolDescription,
    inputPreview: params.inputPreview,
    metadata: params.metadata,
    classifier: "none",
  });
  const response = await userInputRegistry.park(requestId, params.abortSignal);
  return response?.kind === "agent-consent" && response.decision !== "decline";
}

// ============================================================================
// Build Agent Tool Set
// ============================================================================

/**
 * Process placeholders in tool args (e.g. $$SUPABASE_CLIENT_CODE$$, $$NEON_CLIENT_CODE$$)
 * Recursively processes all string values in the args object.
 */
async function processArgPlaceholders<T extends Record<string, any>>(
  args: T,
  ctx: AgentContext,
): Promise<T> {
  const argsStr = JSON.stringify(args);
  const hasSupabasePlaceholder = argsStr.includes("$$SUPABASE_CLIENT_CODE$$");
  const hasNeonPlaceholder = argsStr.includes("$$NEON_CLIENT_CODE$$");

  if (!hasSupabasePlaceholder && !hasNeonPlaceholder) {
    return args;
  }

  let supabaseClientCode: string | undefined;
  if (hasSupabasePlaceholder && ctx.supabaseProjectId) {
    supabaseClientCode = await getSupabaseClientCode({
      projectId: ctx.supabaseProjectId,
      organizationSlug: ctx.supabaseOrganizationSlug ?? null,
    });
  }

  let neonClientCode: string | undefined;
  if (hasNeonPlaceholder) {
    if (ctx.neonProjectId) {
      neonClientCode = getNeonClientCode(ctx.frameworkType);
    } else {
      neonClientCode = "";
    }
  }

  // Process all string values in args
  const processValue = (value: any): any => {
    if (typeof value === "string") {
      let result = value;
      if (supabaseClientCode) {
        result = result.replace(
          /\$\$SUPABASE_CLIENT_CODE\$\$/g,
          supabaseClientCode,
        );
      }
      if (neonClientCode !== undefined) {
        result = result.replace(/\$\$NEON_CLIENT_CODE\$\$/g, neonClientCode);
      }
      return result;
    }
    if (Array.isArray(value)) {
      return value.map(processValue);
    }
    if (value && typeof value === "object") {
      const result: Record<string, any> = {};
      for (const [k, v] of Object.entries(value)) {
        result[k] = processValue(v);
      }
      return result;
    }
    return value;
  };

  return processValue(args) as T;
}

/**
 * Convert our ToolResult to AI SDK format
 */
function convertToolResultForAiSdk(
  result: ToolResult,
): LanguageModelV3ToolResultOutput {
  if (typeof result === "string") {
    return { type: "text", value: result };
  }
  throw new DyadError(
    `Unsupported tool result type: ${typeof result}`,
    DyadErrorKind.Internal,
  );
}

export interface BuildAgentToolSetOptions {
  /**
   * If true, exclude tools that modify state (files, database, etc.).
   * Used for read-only modes like "ask" mode.
   */
  readOnly?: boolean;
  /**
   * If true, only include tools that are allowed in plan mode.
   * Plan mode has access to read-only tools plus planning-specific tools.
   */
  planModeOnly?: boolean;
  /**
   * If true, exclude Pro-only tools.
   * Used for basic agent mode where some tools may not be available.
   */
  basicAgentMode?: boolean;
  /**
   * Legacy compatibility flag. Local tools no longer depend on separate Dyad
   * Engine endpoints, so this does not suppress capabilities.
   */
  freeModelMode?: boolean;
  /**
   * If false, exclude app blueprint tools (write_app_blueprint).
   */
  enableAppBlueprint?: boolean;
}

/**
 * Tools that should ONLY be available in plan mode (excluded from normal agent mode).
 * The consolidated "plan_or_execute" tool covers questionnaire, write_plan, and exit_plan.
 */
const PLAN_MODE_ONLY_TOOLS = new Set(["plan_or_execute"]);

/**
 * Planning-specific tools that are allowed in plan mode despite modifying state.
 * Superset of PLAN_MODE_ONLY_TOOLS plus tools that participate in planning
 * but are also available in normal (pro) agent mode.
 */
const PLANNING_SPECIFIC_TOOLS = new Set(PLAN_MODE_ONLY_TOOLS);

/**
 * Tools only available in Pro agent mode (excluded from basic agent mode).
 */
const PRO_AGENT_ONLY_TOOLS = new Set<string>();

/**
 * Tools that are part of the app blueprint flow. Excluded when the feature
 * is disabled via the Workflow setting or once the per-app blueprint flag is
 * cleared.
 */
const APP_BLUEPRINT_TOOLS = new Set<string>(["write_app_blueprint"]);

/**
 * Tools that enforce the app-blueprint precondition themselves at the
 * capability layer instead of at the wrapper level. execute_sandbox_script
 * is state-modifying only because it MAY expose the write_file host
 * function; gating the whole tool would also block read-only inspection
 * scripts and MCP host calls during blueprint drafting, so the gate runs
 * inside the write_file host capability (see buildWriteFileCapability in
 * execute_sandbox_script.ts).
 */
const CAPABILITY_GATED_BLUEPRINT_TOOLS = new Set<string>([
  "execute_sandbox_script",
]);

// Merged dispatcher tools (e.g. `git`) stay available in read-only mode for
// their read sub-commands, but the blueprint approval gate still applies
// before ANY execution because a sub-command can mutate state.
const BLUEPRINT_GATED_DISPATCH_TOOLS = new Set<string>(["git"]);

function toolModifiesState(
  tool: (typeof TOOL_DEFINITIONS)[number],
  ctx: AgentContext,
): boolean {
  if (typeof tool.modifiesState === "function") {
    return tool.modifiesState(ctx);
  }
  return tool.modifiesState === true;
}

/**
 * Whether a tool belongs in this turn's tool set. Single source of truth for
 * inclusion, so a caller that needs the answer before the set is built (e.g. a
 * tool whose availability depends on another tool) can ask the same question
 * the builder does.
 */
export function shouldIncludeTool(
  tool: (typeof TOOL_DEFINITIONS)[number],
  ctx: AgentContext,
  options: BuildAgentToolSetOptions = {},
): boolean {
  if (getAgentToolConsent(tool.name) === "never") {
    return false;
  }
  // In plan mode, skip state-modifying tools unless they're planning-specific.
  if (
    options.planModeOnly &&
    toolModifiesState(tool, ctx) &&
    !PLANNING_SPECIFIC_TOOLS.has(tool.name)
  ) {
    return false;
  }
  // Skip plan-mode-only tools when NOT in plan mode.
  if (!options.planModeOnly && PLAN_MODE_ONLY_TOOLS.has(tool.name)) {
    return false;
  }
  // Skip Pro-only tools in basic agent mode.
  if (options.basicAgentMode && PRO_AGENT_ONLY_TOOLS.has(tool.name)) {
    return false;
  }
  // search_chats is superseded by the explore_chat_history sub-agent wherever
  // the explorer is present (Pro): broad recall routes through the explorer
  // and targeted drill-down through read_chat. When the explorer is filtered
  // out (non-Pro, free-model mode), direct search remains available so chat
  // history stays reachable.
  if (
    tool.name === "search_chats" &&
    shouldIncludeTool(exploreChatHistoryTool, ctx, options)
  ) {
    return false;
  }
  // Skip app blueprint tools when the feature is disabled.
  if (
    options.enableAppBlueprint === false &&
    APP_BLUEPRINT_TOOLS.has(tool.name)
  ) {
    return false;
  }
  // In read-only mode, skip tools that modify state.
  if (options.readOnly && toolModifiesState(tool, ctx)) {
    return false;
  }
  if (tool.isEnabled) {
    const enabled = tool.isEnabled(ctx);
    if (!enabled) {
      return false;
    }
  }
  return true;
}

/**
 * Legacy tool-name aliases from stock Dyad builds and old transcripts.
 * Early builds exposed the read tool as `dyad_read` (and the compaction
 * summaries the model writes still imitate that `<tool_call><function=...>`
 * format). When the model reads that history and calls a legacy name, execute
 * the current tool instead of failing with "unknown tool".
 */
const LEGACY_TOOL_ALIASES: Readonly<Record<string, string>> = {
  dyad_read: "read_file",
  dyad_read_file: "read_file",
  dyad_write: "write_file",
  dyad_search_replace: "search_replace",
  dyad_list_files: "list_files",
  dyad_grep: "grep",
  dyad_script: "execute_sandbox_script",
  dyad_execute_sandbox_script: "execute_sandbox_script",
  dyad_execute_sql: "execute_sql",
  dyad_read_logs: "read_logs",
  dyad_add_dependency: "add_dependency",
  dyad_restart_app: "restart_app",
  dyad_rebuild_app: "rebuild_app",
  dyad_read_guide: "read_guide",
  dyad_update_todos: "update_todos",
  dyad_exit_plan: "exit_plan",
  dyad_delete: "delete_file",
  dyad_copy: "copy_file",
  dyad_web_search: "web_search",
  dyad_web_fetch: "web_fetch",
  dyad_read_chat: "read_chat",
  dyad_write_plan: "write_plan",
  dyad_explore_code: "explore_code",
  dyad_codebase_summary: "codebase_summary",
  dyad_code_reviewer: "code_reviewer",
  dyad_architecture_analyzer: "architecture_analyzer",
  dyad_explore_chat_history: "explore_chat_history",
  dyad_git: "git",
  dyad_git_status: "git",
  dyad_git_diff: "git",
  dyad_git_log: "git",
  dyad_git_show_commit: "git",
  dyad_git_show_file: "git",
  dyad_git_restore_file: "git",
  dyad_build_app: "build_app",
  dyad_build: "build_app",
  dyad_build_production: "build_app",
  dyad_db_table_schema: "get_database_info",
  dyad_db_schema: "get_database_info",
  dyad_supabase_project_info: "get_database_info",
  dyad_neon_project_info: "get_database_info",
  dyad_image_generation: "generate_image",
};

/**
 * Build ToolSet for AI SDK from tool definitions
 */
export function buildAgentToolSet(
  ctx: AgentContext,
  options: BuildAgentToolSetOptions = {},
) {
  const toolSet: Record<string, any> = {};

  for (const tool of TOOL_DEFINITIONS) {
    if (!shouldIncludeTool(tool, ctx, options)) {
      continue;
    }

    toolSet[tool.name] = {
      description: tool.description,
      inputSchema: tool.inputSchema,
      execute: async (args: any) => {
        try {
          // Guard against state-modifying tools running before the app
          // blueprint approval is resolved. `write_app_blueprint` owns the
          // approval gate; blueprint tools themselves are allowed through so
          // the flow can progress to approval. Skip entirely when the
          // blueprint feature is disabled — otherwise a plan left over from
          // before the toggle would permanently block the agent.
          //
          // When the feature is enabled, also block if NO plan exists yet —
          // the prompt instructs the model to call write_app_blueprint first,
          // but the prompt isn't an enforcement boundary. Without this check,
          // a model that skips write_app_blueprint can still call e.g.
          // write_file and bypass the required blueprint approval flow.
          if (
            (toolModifiesState(tool, ctx) ||
              BLUEPRINT_GATED_DISPATCH_TOOLS.has(tool.name)) &&
            !APP_BLUEPRINT_TOOLS.has(tool.name) &&
            !PLANNING_SPECIFIC_TOOLS.has(tool.name) &&
            !CAPABILITY_GATED_BLUEPRINT_TOOLS.has(tool.name)
          ) {
            assertAppBlueprintApproved({
              toolName: tool.name,
              chatId: ctx.chatId,
              enabled: options.enableAppBlueprint !== false,
            });
          }

          const processedArgs = await processArgPlaceholders(args, ctx);

          // Check consent before executing the tool
          await requireToolConsentOrThrow(tool, processedArgs, ctx);

          // Track file edit tool usage before execution to capture all attempts
          // (including failures) for retry/fallback telemetry
          trackFileEditTool(ctx, tool.name, processedArgs);
          const result = await tool.execute(processedArgs, ctx);

          // Only completed mutations unblock run_tests. Failed tool calls are
          // still present in fileEditTracker for retry/fallback telemetry, but
          // must not masquerade as a code change.
          trackAppMutation(
            ctx,
            tool.name,
            shouldTrackToolMutation(tool, processedArgs, result, ctx),
          );


          return convertToolResultForAiSdk(result);
        } catch (error) {
          const errorMessage = getToolErrorSummary(error);
          const errorDetails = getToolErrorDisplayDetails(error);

          ctx.onXmlComplete(
            `<dyad-output type="error" message="Tool '${tool.name}' failed: ${escapeXmlAttr(errorMessage)}">${escapeXmlContent(errorDetails)}</dyad-output>`,
          );
          throw error;
        }
      },
    };
  }

  // Register legacy aliases (dyad_read etc.) pointing at the current tool
  // implementations, so tool calls imitated from old transcripts/compaction
  // summaries execute properly instead of failing as unknown tools.
  for (const [alias, canonicalName] of Object.entries(LEGACY_TOOL_ALIASES)) {
    const canonical = toolSet[canonicalName];
    if (canonical && !toolSet[alias]) {
      toolSet[alias] = {
        ...canonical,
        description: `Legacy alias for "${canonicalName}" — kept so older transcripts keep working. Prefer calling "${canonicalName}".`,
      };
    }
  }

  return toolSet;
}
