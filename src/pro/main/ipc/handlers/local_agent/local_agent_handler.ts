/**
 * Local Agent v2 Handler
 * Main orchestrator for tool-based agent mode with parallel execution
 */

import { IpcMainInvokeEvent } from "electron";
import {
  streamText,
  ToolSet,
  stepCountIs,
  hasToolCall,
  ModelMessage,
  type ToolExecutionOptions,
} from "ai";
import log from "electron-log";
import { withHeadroom } from "headroom-ai/vercel-ai";

import { db } from "@/db";
import { chats, messages, mcpServers } from "@/db/schema";
import { eq } from "drizzle-orm";
import { mcpManager } from "@/ipc/utils/mcp_manager";
import { requireMcpToolConsent } from "@/ipc/utils/mcp_consent";
import { isObject } from "@/shared/typeGuards";
import { buildMcpAutoApprove } from "./mcp_auto_consent";
import { scheduleChatSearchIndexing } from "./chat_search_indexer";
import { parseMcpToolKey, sanitizeMcpName } from "@/ipc/utils/mcp_tool_utils";
import { sanitizeMcpToolResult } from "@/ipc/utils/mcp_result_sanitizer";

import {
  hasConfiguredAgentModel,
  isDyadProEnabled,
  type UserSettings,
} from "@/lib/schemas";
import type { SqlConsentMetadata } from "@/shared/sqlConsentMetadata";
import { RECOVERY_AGENT_MODEL } from "@/agent/defaults";
import { readSettings } from "@/main/settings";
import { getDyadAppPath } from "@/paths/paths";
import { detectFrameworkType } from "@/ipc/utils/framework_utils";
import { getModelClient } from "@/ipc/utils/get_model_client";
import { safeSend } from "@/ipc/utils/safe_sender";
import { sendChatChunk } from "@/ipc/utils/high_volume_delivery";
import { broadcastToRegisteredWindows } from "@/ipc/utils/window_broadcast";
import { publishQueryInvalidations } from "@/ipc/utils/query_invalidation_delivery";
import {
  cancelOrphanedBaseStream,
  fastTextOutput,
} from "@/ipc/utils/stream_text_utils";
import {
  estimateToolResultTokens,
  getMaxTokens,
  getTemperature,
} from "@/ipc/utils/token_utils";
import {
  getProviderOptions,
  getAiHeaders,
  DYAD_INTERNAL_REQUEST_ID_HEADER,
} from "@/ipc/utils/provider_options";

import {
  AgentToolName,
  buildAgentToolSet,
  shouldIncludeTool,
  requireAgentToolConsent,
} from "./tool_definitions";
import {
  deployAllFunctionsIfNeeded,
  commitAllChanges,
} from "./processors/file_operations";
import { storeDbTimestampAtCurrentVersion } from "@/ipc/utils/neon_timestamp_utils";
import { getAiMessagesJsonIfWithinLimit } from "@/ipc/utils/ai_messages_utils";
import { deleteAppBlueprintForChat } from "@/ipc/handlers/app_blueprint_handlers";
import {
  detectPreviewCompilationError,
  buildPreviewErrorMessage,
} from "./tools/auto_trigger";

import type { ChatStreamParams, ChatResponseEnd } from "@/ipc/types";
import {
  AgentContext,
  parsePartialJson,
  escapeXmlAttr,
  escapeXmlContent,
  UserMessageContentPart,
  FileEditTracker,
  type Todo,
} from "./tools/types";
import { sendTelemetryEvent } from "@/ipc/utils/telemetry";
import {
  prepareStepMessages,
  hasIncompleteTodos,
  formatTodoSummary,
  sanitizeStepMessages,
  type InjectedMessage,
} from "./prepare_step_utils";
import { deleteTodos, loadTodos, saveTodos } from "./todo_persistence";
import { ensureDyadGitignored } from "@/ipc/handlers/gitignoreUtils";
import { TOOL_DEFINITIONS } from "./tool_definitions";
import {
  parseAiMessagesJson,
  sanitizeToolCallTranscript,
  type DbMessageForParsing,
} from "@/ipc/utils/ai_messages_utils";
import {
  buildExecuteSandboxScriptDescription,
  executeSandboxScriptTool,
} from "./tools/execute_sandbox_script";
import { writeFileTool } from "./tools/write_file";
import {
  collectMcpToolDefs,
  estimateMcpInlineTokens,
  getMcpInlineTokenThreshold,
  type McpToolDef,
} from "./tools/mcp_type_defs";
import { addIntegrationTool } from "./tools/add_integration";
import { planOrExecuteTool } from "./tools/plan_or_execute";
import { writeAppBlueprintTool } from "./tools/write_app_blueprint";
import { appendCancelledResponseNotice } from "@/shared/chatCancellation";
import {
  isModelRefusal,
  MODEL_REFUSAL_WARNING,
} from "@/ipc/utils/model_refusal";
import {
  isChatPendingCompaction,
  performCompaction,
  checkAndMarkForCompaction,
} from "@/ipc/handlers/compaction/compaction_handler";
import { getPostCompactionMessages } from "@/ipc/handlers/compaction/compaction_utils";
import { DEFAULT_MAX_TOOL_CALL_STEPS } from "@/constants/settings_constants";
import { DyadError, DyadErrorKind } from "@/errors/dyad_error";
import {
  type RetryReplayEvent,
  maybeCaptureRetryReplayEvent,
  maybeCaptureRetryReplayText,
  maybeAppendRetryReplayForRetry,
} from "./retry_replay_utils";
import { setChatSummaryTool } from "./tools/set_chat_summary";
import { computeStreamingPatch } from "@/ipc/utils/stream_text_utils";
import { userInputRegistry } from "@/user_input/main";
import {
  toRendererMessage,
  type RendererMessageRow,
} from "@/ipc/utils/renderer_chat_message";

export function clearPendingLocalAgentInputsForChat(chatId: number): void {
  userInputRegistry.sweepChat(chatId);
}

const logger = log.scope("local_agent_handler");
const PLANNING_TOOL_NAME = "plan_or_execute";
const MAX_TERMINATED_STREAM_RETRIES = 5;
const MAX_ERROR_RESPONSE_BODY_DEPTH = 5;
const STREAM_RETRY_BASE_DELAY_MS = 500;
const STREAM_CONTINUE_MESSAGE =
  "[System] Your previous response stream was interrupted by a transient network error. Continue from exactly where you left off and do not repeat text that has already been sent.";
const TOOL_ERROR_STATUS_MAX_CHARS = 4_000;

const RETRYABLE_STREAM_ERROR_STATUS_CODES = new Set([
  408, 429, 499, 500, 502, 503, 504, 520, 521, 522, 523, 524,
]);
const RETRYABLE_STREAM_ERROR_PATTERNS = [
  // Server-side errors
  "server_error",
  "internal server error",
  "service unavailable",
  "bad gateway",
  "gateway timeout",
  "too many requests",
  "rate_limit",
  "rate limit",
  "overloaded",
  "overloaded_error",
  "capacity exceeded",
  "insufficient_quota",
  "quota exceeded",
  // Network errors
  "econnrefused",
  "enotfound",
  "econnreset",
  "epipe",
  "etimedout",
  "socket hang up",
  "fetch failed",
  "network",
  "EPIPE",
  "ECONNRESET",
  "ETIMEDOUT",
  // Stream-specific
  "terminated",
  "stream terminated",
  "stream was terminated",
  "aborted",
  "request aborted",
  "abort",
  // Provider-specific (common gateways)
  "upstream",
  "timeout",
  "deadline exceeded",
  "context deadline exceeded",
  "503 service",
  "502 bad",
  "504 gateway",
];

// ============================================================================
// Tool Streaming State Management
// ============================================================================

/**
 * Track streaming state per tool call ID
 */
interface ToolStreamingEntry {
  toolName: string;
  argsAccumulated: string;
}
const toolStreamingEntries = new Map<string, ToolStreamingEntry>();

function getOrCreateStreamingEntry(
  id: string,
  toolName?: string,
): ToolStreamingEntry | undefined {
  let entry = toolStreamingEntries.get(id);
  if (!entry && toolName) {
    entry = {
      toolName,
      argsAccumulated: "",
    };
    toolStreamingEntries.set(id, entry);
  }
  return entry;
}

function cleanupStreamingEntry(id: string): void {
  toolStreamingEntries.delete(id);
}

function findToolDefinition(toolName: string) {
  return TOOL_DEFINITIONS.find((t) => t.name === toolName);
}

function buildPreExecutionToolErrorStatus(
  toolName: string,
  error: unknown,
): string {
  const fullMessage = getErrorMessage(error);
  const message =
    fullMessage.length > TOOL_ERROR_STATUS_MAX_CHARS
      ? `${fullMessage.slice(0, TOOL_ERROR_STATUS_MAX_CHARS)}…[truncated]`
      : fullMessage;
  return `<dyad-status title="${escapeXmlAttr(`Tool "${toolName}" failed`)}" state="error">\n${escapeXmlContent(message)}\n</dyad-status>`;
}

function appendGitContext(
  parsed: ModelMessage[],
  annotation: string,
): ModelMessage[] {
  const finalMessage = parsed.at(-1);
  if (finalMessage?.role !== "assistant") {
    return [...parsed, { role: "assistant", content: annotation }];
  }

  if (
    typeof finalMessage.content !== "string" &&
    !Array.isArray(finalMessage.content)
  ) {
    return [...parsed, { role: "assistant", content: annotation }];
  }

  const content =
    typeof finalMessage.content === "string"
      ? [
          { type: "text" as const, text: finalMessage.content },
          { type: "text" as const, text: annotation },
        ]
      : [...finalMessage.content, { type: "text" as const, text: annotation }];

  return [...parsed.slice(0, -1), { ...finalMessage, content }];
}

export function buildChatMessageHistory(
  chatMessages: Array<
    DbMessageForParsing & {
      isCompactionSummary: boolean | null;
      createdAt: Date;
    }
  >,
  options?: { excludeMessageIds?: Set<number> },
): ModelMessage[] {
  const excludedIds = options?.excludeMessageIds;
  const relevantMessages = getPostCompactionMessages(chatMessages);
  const reorderedMessages = [...relevantMessages];

  // For mid-turn compaction, keep the summary immediately after the triggering
  // user message so subsequent turns reflect that compaction happened before
  // post-compaction tool-loop steps.
  for (const summary of [...reorderedMessages].filter(
    (message) => message.isCompactionSummary,
  )) {
    const summaryIndex = reorderedMessages.findIndex(
      (m) => m.id === summary.id,
    );
    if (summaryIndex < 0) {
      continue;
    }

    const triggeringUser = [...reorderedMessages]
      .filter((m) => m.role === "user" && m.id < summary.id)
      .sort((a, b) => b.id - a.id)[0];
    if (!triggeringUser) {
      continue;
    }

    const triggeringUserIndex = reorderedMessages.findIndex(
      (m) => m.id === triggeringUser.id,
    );
    if (triggeringUserIndex < 0) {
      continue;
    }

    const isMidTurnSummary =
      summary.createdAt.getTime() >= triggeringUser.createdAt.getTime();
    if (!isMidTurnSummary || summaryIndex === triggeringUserIndex + 1) {
      continue;
    }

    reorderedMessages.splice(summaryIndex, 1);
    const targetIndex = Math.min(
      triggeringUserIndex + 1,
      reorderedMessages.length,
    );
    reorderedMessages.splice(targetIndex, 0, summary);
  }

  const filtered = reorderedMessages
    .filter((msg) => !excludedIds?.has(msg.id))
    .filter((msg) => msg.content || msg.aiMessagesJson);

  const history = filtered.flatMap((msg) => {
    const parsed = parseAiMessagesJson(msg);
    if (msg.role !== "assistant") {
      return parsed;
    }
    const annotation = msg.commitHash
      ? `<dyad-git-context commit="${escapeXmlAttr(msg.commitHash)}"></dyad-git-context>`
      : msg.sourceCommitHash
        ? `<dyad-git-context source_commit="${escapeXmlAttr(msg.sourceCommitHash)}" no_commit="true"></dyad-git-context>`
        : null;
    return annotation ? appendGitContext(parsed, annotation) : parsed;
  });

  return applyHistoryBudget(
    history.map((msg) => ({
      ...msg,
      content: truncateModelMessageContent(
        (msg as ModelMessageWithContent).content,
        MAX_HISTORY_MESSAGE_CHARS,
      ),
    })),
  );
}

interface ModelMessageWithContent {
  content: unknown;
}

// ── Context budget caps ──────────────────────────────────────────────
// Autopilot-era runs stored multi-megabyte `<think>` blocks and tool XML in
// single messages (some >2M chars ≈ 500K tokens), which blows through any
// context window when replayed into history. Cap each message and the total
// history so the model always sees a usable window.
const MAX_HISTORY_MESSAGE_CHARS = 60_000;
const MAX_HISTORY_TOTAL_CHARS = 200_000;
const HISTORY_TRUNCATION_MARKER =
  "\n\n[Earlier conversation history was truncated to fit the context window.]\n";

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `[Truncated ${text.length - maxChars} chars of this message]\n` + text.slice(-maxChars);
}

function truncateModelMessageContent(
  content: unknown,
  maxChars: number,
): unknown {
  if (typeof content === "string") {
    return truncateText(content, maxChars);
  }
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === "string") {
        return truncateText(part, maxChars);
      }
      if (part && typeof part === "object") {
        const record = part as Record<string, unknown>;
        if (typeof record.text === "string") {
          return { ...record, text: truncateText(record.text, maxChars) };
        }
        if (typeof record.output === "string") {
          return { ...record, output: truncateText(record.output, maxChars) };
        }
      }
      return part;
    });
  }
  return content;
}

function applyHistoryBudget(messages: Array<ModelMessageWithContent>): ModelMessage[] {
  let total = 0;
  const kept: ModelMessage[] = [];
  // Walk from the newest message backward; always keep the newest message.
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as ModelMessageWithContent;
    const content = msg.content;
    const size =
      typeof content === "string"
        ? content.length
        : (JSON.stringify(content)?.length ?? 0);
    if (i > 0 && total + size > MAX_HISTORY_TOTAL_CHARS) {
      break;
    }
    total += size;
    kept.push(msg as ModelMessage);
  }
  kept.reverse();
  // Tell the model that older history was dropped.
  if (kept.length < messages.length && kept.length > 0) {
    const oldest = kept[0] as ModelMessageWithContent;
    if (typeof oldest.content === "string") {
      oldest.content = HISTORY_TRUNCATION_MARKER + oldest.content;
    }
  }
  return kept;
}

/**
 * Append a `<system-reminder>` to the latest user message listing referenced
 * apps so the agent knows which `app_name` values it can pass to read-only
 * tools (`read_file`, `list_files`, `grep`, `code_search`). Mutates the last
 * user message in-place to avoid copying unrelated parts of the history.
 */
function injectReferencedAppsReminder(
  messageHistory: ModelMessage[],
  referencedApps: readonly { appName: string }[],
  options: { codeExplorerAvailable: boolean },
): void {
  const list = referencedApps.map(({ appName }) => `\`${appName}\``).join(", ");
  const searchTool = options.codeExplorerAvailable
    ? "`explore_code`"
    : "`code_search`";
  const reminder = `\n\n<system-reminder>\nThe user has mentioned the following apps in their prompt: ${list}. These apps are separate from the current app and are READ-ONLY. To inspect them, pass the app name as the \`app_name\` parameter to read-only tools (\`read_file\`, \`list_files\`, \`grep\`, ${searchTool}); matching is case-insensitive. Write tools cannot target these apps. Omit \`app_name\` to operate on the current app.\n</system-reminder>`;

  for (let i = messageHistory.length - 1; i >= 0; i--) {
    const msg = messageHistory[i];
    if (msg.role !== "user") continue;
    if (typeof msg.content === "string") {
      messageHistory[i] = { ...msg, content: msg.content + reminder };
    } else {
      messageHistory[i] = {
        ...msg,
        content: [...msg.content, { type: "text", text: reminder }],
      };
    }
    return;
  }
}

function getMidTurnCompactionSummaryIds(
  chatMessages: Array<{
    id: number;
    role: string;
    createdAt: Date;
    isCompactionSummary: boolean | null;
  }>,
): Set<number> {
  const hiddenIds = new Set<number>();

  for (const summary of chatMessages.filter((m) => m.isCompactionSummary)) {
    const triggeringUserMessage = [...chatMessages]
      .filter((m) => m.role === "user" && m.id < summary.id)
      .sort((a, b) => b.id - a.id)[0];

    if (!triggeringUserMessage) {
      continue;
    }

    if (
      summary.createdAt.getTime() >= triggeringUserMessage.createdAt.getTime()
    ) {
      hiddenIds.add(summary.id);
    }
  }

  return hiddenIds;
}

function getMessageText(message: ModelMessage): string {
  if (typeof message.content === "string") {
    return message.content;
  }
  if (!Array.isArray(message.content)) {
    return "";
  }
  return message.content
    .map((part) =>
      part && typeof part === "object" && "text" in part
        ? String(part.text)
        : "",
    )
    .join("\n");
}

function isAttachmentAccessToolCall(toolName: string, input: unknown): boolean {
  if (!isObject(input)) {
    return false;
  }

  if (
    toolName === "execute_sandbox_script" &&
    typeof input.script === "string"
  ) {
    return (
      /\b(?:read_file|file_stats)\s*\(\s*["']attachments:/.test(input.script) ||
      /\blist_files\s*\(\s*["']attachments:?["']\s*\)/.test(input.script)
    );
  }
  if (toolName === "read_file" && typeof input.path === "string") {
    return input.path.startsWith("attachments:");
  }
  if (toolName === "copy_file" && typeof input.from === "string") {
    return input.from.startsWith("attachments:");
  }
  return false;
}

/**
 * Handle a chat stream in local-agent mode
 */
export async function handleLocalAgentStream(
  event: IpcMainInvokeEvent,
  req: ChatStreamParams,
  abortController: AbortController,
  {
    placeholderMessageId,
    systemPrompt,
    dyadRequestId,
    readOnly = false,
    planModeOnly = false,
    messageOverride,
    settingsOverride,
    freeModelMode,
    referencedApps = [],
    currentTurnHasOnDiskAttachment,
  }: {
    placeholderMessageId: number;
    systemPrompt: string;
    dyadRequestId: string;
    /**
     * If true, the agent operates in read-only mode (e.g., ask mode).
     * State-modifying tools are disabled, and no commits/deploys are made.
     */
    readOnly?: boolean;
    /**
     * If true, only include tools allowed in plan mode.
     * This includes read-only exploration tools and planning-specific tools.
     */
    planModeOnly?: boolean;
    /**
     * If provided, use these messages instead of fetching from the database.
     * Used for summarization where messages need to be transformed.
     */
    messageOverride?: ModelMessage[];
    settingsOverride?: UserSettings;
    freeModelMode?: boolean;
    /**
     * Apps referenced via `@app:Name` mentions in the user's prompt.
     * Read-only tools can target these via an `app_name` parameter.
     */
    referencedApps?: {
      appName: string;
      appPath: string;
    }[];
    currentTurnHasOnDiskAttachment?: boolean;
  },
): Promise<boolean> {
  const settings = settingsOverride ?? readSettings();
  const maxToolCallSteps =
    settings.maxToolCallSteps ?? DEFAULT_MAX_TOOL_CALL_STEPS;
  let fullResponse = "";
  let streamingPreview = ""; // Temporary preview for current tool, not persisted
  let streamingPreviewToolCallId: string | null = null;
  // Tracks what was last sent to the renderer for the placeholder
  // assistant message so we can emit only the tail diff. Updated by both
  // streaming-patch sends and full-messages-replacement sends so that the
  // next tail patch is computed against the renderer's actual state.
  // Held in a ref object so sendResponseChunk can mutate it.
  const lastSentRef = { value: "" };
  let activeRetryReplayEvents: RetryReplayEvent[] | null = null;
  // Mid-turn compaction inserts a DB summary row for LLM history, but we render
  // the user-facing compaction indicator inline in the active assistant turn.
  const hiddenMessageIdsForStreaming = new Set<number>();
  // Convenience wrapper that binds the stream-invariant context args so call
  // sites only pass the two things that vary: the current response content and
  // whether to send the full messages array.
  const sendChunk = (
    response: string,
    { fullMessages = false }: { fullMessages?: boolean } = {},
  ) =>
    sendResponseChunk(
      event,
      req.chatId,
      req.invocationRef,
      req.streamId,
      chat,
      response,
      placeholderMessageId,
      hiddenMessageIdsForStreaming,
      fullMessages,
      lastSentRef,
    );
  // Sidecar preview send — independent of the patch protocol. The renderer
  // overlays this string after the message's parsed blocks and clears the
  // overlay when content is empty. Used for tool-input XML preview.
  const sendPreview = (content: string) => {
    sendChatChunk(event.sender, {
      chatId: req.chatId,
      invocationRef: req.invocationRef,
      streamId: req.streamId,
      streamingPreview: { content },
    });
  };
  const commitToolXml = (finalXml: string, toolCallId?: string) => {
    const xmlChunk = `${finalXml}\n`;
    fullResponse += xmlChunk;
    const shouldClearPreview =
      toolCallId === undefined || streamingPreviewToolCallId === toolCallId;
    if (shouldClearPreview) {
      streamingPreview = "";
      streamingPreviewToolCallId = null;
    }
    updateResponseInDb(placeholderMessageId, fullResponse);
    sendChunk(fullResponse);
    if (shouldClearPreview) {
      sendPreview("");
    }
  };
  let postMidTurnCompactionStartStep: number | null = null;

  const appendInlineCompactionToTurn = async (
    summary?: string,
    backupPath?: string,
  ) => {
    const summaryText =
      summary && summary.trim().length > 0
        ? summary
        : "Conversation compacted.";
    const inlineCompaction = `<dyad-compaction title="Conversation compacted" state="finished">\n${escapeXmlContent(
      sanitizeCompactionSummary(summaryText),
    )}\n</dyad-compaction>`;
    const backupPathNote = backupPath
      ? `\nIf you need to retrieve earlier parts of the conversation history, you can read the backup file at: ${backupPath}\nNote: This file may be large. Read only the sections you need or use grep to search for specific content rather than reading the entire file.`
      : "";
    const separator =
      fullResponse.length > 0 && !fullResponse.endsWith("\n") ? "\n" : "";
    fullResponse = `${fullResponse}${separator}${inlineCompaction}${backupPathNote}\n`;
    await updateResponseInDb(placeholderMessageId, fullResponse);
  };

  // Local agent intelligence runs through the explicit model selected in
  // Settings. Hosted Dyad Pro entitlement is intentionally not a prerequisite
  // for BYOK/local models.
  if (!hasConfiguredAgentModel(settings)) {
    safeSend(event.sender, "chat:response:error", {
      chatId: req.chatId,
      invocationRef: req.invocationRef,
      streamId: req.streamId,
      error:
        "Agent mode needs a model provider. Configure Kilo (recommended free route), OpenRouter, or another provider in Settings → Providers.",
    });
    return false;
  }

  const loadChat = async () =>
    db.query.chats.findFirst({
      where: eq(chats.id, req.chatId),
      with: {
        messages: {
          orderBy: (messages, { asc }) => [
            asc(messages.createdAt),
            asc(messages.id),
          ],
          // Memory guard: window the relation so a pathological chat (hundreds
          // of huge messages) cannot load unbounded content into the main
          // process per request. 500 latest messages covers real chats and
          // keeps worst-case memory bounded; mid-turn compaction summary rows
          // live inside this window for any realistically-sized chat.
          take: 500,
        },
        app: true,
      },
    });

  // Get the chat and app — may be re-queried after compaction
  const initialChat = await loadChat();

  if (!initialChat || !initialChat.app) {
    throw new DyadError(
      `Chat not found: ${req.chatId}`,
      DyadErrorKind.NotFound,
    );
  }

  let chat = initialChat;

  for (const id of getMidTurnCompactionSummaryIds(chat.messages)) {
    hiddenMessageIdsForStreaming.add(id);
  }

  const appPath = getDyadAppPath(chat.app.path);

  const maybePerformPendingCompaction = async (options?: {
    showOnTopOfCurrentResponse?: boolean;
    force?: boolean;
  }) => {
    if (
      settings.enableContextCompaction === false ||
      (!options?.force && !(await isChatPendingCompaction(req.chatId)))
    ) {
      return false;
    }

    logger.info(`Performing pending compaction for chat ${req.chatId}`);
    const existingCompactionSummaryIds = new Set(
      chat.messages
        .filter((message) => message.isCompactionSummary)
        .map((message) => message.id),
    );
    const compactionResult = await performCompaction(
      event,
      req.chatId,
      appPath,
      dyadRequestId,
      (accumulatedSummary: string) => {
        // Stream compaction summary to the frontend in real-time.
        // During mid-turn compaction, keep already streamed content visible.
        // streamingPreview rides a separate overlay channel — do NOT mix it
        // into message.content here; the renderer continues to show its
        // preview overlay alongside this compaction-progress block.
        const compactionPreview = `<dyad-compaction title="Compacting conversation">\n${escapeXmlContent(
          sanitizeCompactionSummary(accumulatedSummary),
        )}\n</dyad-compaction>`;
        const previewContent = options?.showOnTopOfCurrentResponse
          ? `${fullResponse}\n${compactionPreview}`
          : compactionPreview;
        sendChunk(previewContent, { fullMessages: true });
      },
      {
        // Mid-turn compaction should not render as a separate message above the
        // current turn on subsequent streams, so keep its DB timestamp in turn order.
        createdAtStrategy: options?.showOnTopOfCurrentResponse
          ? "now"
          : "before-latest-user",
        abortSignal: abortController.signal,
      },
    );
    if (compactionResult.skipped) {
      return false;
    }
    if (compactionResult.aborted) {
      return false;
    }
    if (!compactionResult.success) {
      logger.warn(
        `Compaction failed for chat ${req.chatId}: ${compactionResult.error}`,
      );
      // Continue anyway - compaction failure shouldn't block the conversation
    }

    // Re-query to pick up the newly inserted compaction summary message.
    // Only update if compaction succeeded — a failed compaction may have left
    // partial state that would corrupt subsequent message history.
    if (compactionResult.success) {
      const refreshedChat = await loadChat();
      if (refreshedChat?.app) {
        chat = refreshedChat;
      }

      if (options?.showOnTopOfCurrentResponse) {
        for (const message of chat.messages) {
          if (
            message.isCompactionSummary &&
            !existingCompactionSummaryIds.has(message.id)
          ) {
            hiddenMessageIdsForStreaming.add(message.id);
          }
        }
        await appendInlineCompactionToTurn(
          compactionResult.summary,
          compactionResult.backupPath,
        );
      }
    }

    if (options?.showOnTopOfCurrentResponse) {
      // streamingPreview rides the overlay channel; don't double-render it
      // by mixing into message.content here.
      sendChunk(fullResponse, { fullMessages: true });
    }

    return compactionResult.success;
  };

  // Check if compaction is pending and enabled before processing the message
  await maybePerformPendingCompaction();

  if (abortController.signal.aborted) {
    await db
      .update(messages)
      .set({
        content: appendCancelledResponseNotice(fullResponse ?? ""),
      })
      .where(eq(messages.id, placeholderMessageId));
    return false;
  }

  // Send initial message update. Routed through sendChunk so lastSentRef
  // stays in sync automatically (same as every other full-messages send).
  sendChunk(fullResponse, { fullMessages: true });

  // Track pending user messages to inject after tool results
  const pendingUserMessages: UserMessageContentPart[][] = [];
  // Store injected messages with their insertion index to re-inject at the same spot each step
  const allInjectedMessages: InjectedMessage[] = [];
  const warningMessages: string[] = [];
  // Snapshot of todos persisted by a previous turn. Declared outside the try so
  // the cancellation handler in `catch` can roll back to this pre-turn state.
  let persistedTodos: Todo[] = [];

  try {
    // Get model client
    let modelClient = (
      await getModelClient(settings.selectedModel, settings)
    ).modelClient;
    let fallbackModelClient: Awaited<ReturnType<typeof getModelClient>>["modelClient"] | null = null;
    let usedFallbackModel = false;

    // Load persisted todos from a previous turn (if any)
    persistedTodos = await loadTodos(appPath, chat.id);
    // Ensure .dyad/ is gitignored (idempotent; also done by compaction/plans)
    // Skip in read-only/plan-only mode to avoid modifying the workspace
    if (!readOnly && !planModeOnly) {
      await ensureDyadGitignored(appPath).catch((err: unknown) =>
        logger.warn("Failed to ensure .dyad gitignored:", err),
      );
    }
    if (persistedTodos.length > 0) {
      // Emit loaded todos to the renderer so the UI shows them immediately
      broadcastToRegisteredWindows(event.sender, "agent-tool:todos-update", {
        chatId: chat.id,
        todos: persistedTodos,
      });
    }

    // Build tool execute context
    const fileEditTracker: FileEditTracker = Object.create(null);
    const referencedAppsMap = new Map(
      referencedApps.map((ref) => [ref.appName.toLowerCase(), ref.appPath]),
    );
    // The legacy hosted free-Pro model path is disabled in this build.
    const effectiveFreeModelMode = false;
    const ctx: AgentContext = {
      event,
      appId: chat.app.id,
      appPath,
      referencedApps: referencedAppsMap,
      chatId: chat.id,
      planAcceptInNewChat: req.planAcceptInNewChat,
      supabaseProjectId: chat.app.supabaseProjectId,
      supabaseOrganizationSlug: chat.app.supabaseOrganizationSlug,
      neonProjectId: chat.app.neonProjectId,
      neonActiveBranchId:
        chat.app.neonActiveBranchId ?? chat.app.neonDevelopmentBranchId,
      frameworkType: detectFrameworkType(appPath),
      messageId: placeholderMessageId,
      isSharedModulesChanged: false,
      sharedServerModulePaths: [],
      pendingFunctionDeploys: [],
      todos: persistedTodos,
      dyadRequestId,
      fileEditTracker,
      testingEnabled: Boolean(chat.app.testingEnabled),
      testRunAttempts: new Map(),
      isDyadPro: isDyadProEnabled(settings),
      freeModelMode: effectiveFreeModelMode,
      readOnly,
      planModeOnly,
      onXmlStream: (accumulatedXml: string) => {
        // Stream the in-progress tool XML as a sidecar preview overlay.
        // Does NOT enter `message.content` or `fullResponse` — the patch
        // protocol stays strictly append-only. buildXml output (which
        // rewrites the prefix every JSON delta as attribute values grow)
        // therefore can't perturb the streaming-patch base.
        streamingPreview = accumulatedXml;
        sendPreview(streamingPreview);
      },
      onXmlComplete: (finalXml: string) => {
        // Commit final XML to fullResponse and clear the preview overlay.
        commitToolXml(finalXml);
      },
      requireConsent: async (params: {
        toolName: string;
        toolDescription?: string | null;
        inputPreview?: string | null;
        metadata?: SqlConsentMetadata | null;
      }) => {
        return requireAgentToolConsent(event, {
          chatId: chat.id,
          toolName: params.toolName as AgentToolName,
          toolDescription: params.toolDescription,
          inputPreview: params.inputPreview,
          metadata: params.metadata,
          abortSignal: abortController.signal,
        });
      },
      appendUserMessage: (content: UserMessageContentPart[]) => {
        pendingUserMessages.push(content);
      },
      onUpdateTodos: (todos) => {
        broadcastToRegisteredWindows(event.sender, "agent-tool:todos-update", {
          chatId: chat.id,
          todos,
        });
      },
      onWarningMessage: (message) => {
        warningMessages.push(message);
      },
      onAttachmentAccess: () => {
        usedAttachmentAccessTool = true;
      },
      abortSignal: abortController.signal,
      rebuildAppToolAvailable:
        !readOnly &&
        !planModeOnly &&
        settings.agentToolConsents?.["app_lifecycle"] !== "never" &&
        settings.agentToolConsents?.["rebuild_app"] !== "never",
    };

    // Read-only mode includes only read-only tools (MCP tools are skipped since
    // we can't tell if they modify state); plan mode includes only planning tools.
    const buildOptions = {
      readOnly,
      planModeOnly,
      basicAgentMode: false,
      freeModelMode: effectiveFreeModelMode,
      enableAppBlueprint:
        settings.enableAppBlueprint && chat.app.needsAppBlueprint,
    };
    // Same inclusion predicate the tool-set builder uses for the write_file
    // tool, so the sandbox write host can never stay exposed in a turn where
    // the direct tool is filtered out.
    ctx.sandboxWriteFileHostEnabled = shouldIncludeTool(
      writeFileTool,
      ctx,
      buildOptions,
    );
    ctx.enableAppBlueprint = buildOptions.enableAppBlueprint;
    // search_mcp_tools.isEnabled reads this during the build, so set it up front
    // from the same predicate the builder uses. Off in read-only and plan mode.
    const mcpInSandboxEnabled =
      !readOnly &&
      !planModeOnly &&
      shouldIncludeTool(executeSandboxScriptTool, ctx, buildOptions);
    ctx.mcpToolsEnabled = mcpInSandboxEnabled;

    // Collect MCP defs before building the tool set so the inline-vs-search
    // decision is available up front. The same defs build the description and
    // the sandbox capability map (via ctx.mcpToolDefs).
    let mcpDefs: McpToolDef[] = [];
    if (mcpInSandboxEnabled) {
      try {
        mcpDefs = await collectMcpToolDefs();
        ctx.mcpToolDefs = mcpDefs;
      } catch (e) {
        logger.warn("Failed to collect MCP tool defs", e);
      }
    }
    // When execute_sandbox_script is active, MCP tools become sandbox host
    // functions instead of individual LLM tools. Search mode (list tool names
    // and let the model fetch schemas on demand) is available if both of the
    // following are true:
    // 1) the tool search setting is on, and
    // 2) inlining every tool declaration would exceed the size threshold.
    // Otherwise inline every declaration in the description.
    ctx.isMcpToolSearchAvailable =
      mcpInSandboxEnabled &&
      !!settings.enableMcpToolSearch &&
      estimateMcpInlineTokens(mcpDefs) > getMcpInlineTokenThreshold();

    const agentTools = buildAgentToolSet(ctx, buildOptions);
    // search_mcp_tools returns full tool declarations, so it alone is enough for
    // search mode. If tool permissions removed it, fall back to inline and drop
    // the now-unused get_mcp_tool_schema tool.
    let useMcpToolSearch = ctx.isMcpToolSearchAvailable;
    if (useMcpToolSearch && agentTools.search_mcp_tools == undefined) {
      useMcpToolSearch = false;
      delete agentTools.get_mcp_tool_schema;
    }
    // get_mcp_tool_schema can also be removed by tool permissions on its own, so
    // only advertise it in the description when it actually registered.
    const hasGetSchemaTool = agentTools.get_mcp_tool_schema != undefined;
    const mcpToolsForRegistration: ToolSet =
      !readOnly && !planModeOnly
        ? await getMcpTools(event, ctx)
        : {};
    if (agentTools.execute_sandbox_script != undefined) {
      // Start with the file-inspection-only preamble so a failure in the MCP
      // build below still leaves usable docs.
      agentTools.execute_sandbox_script.description =
        await buildExecuteSandboxScriptDescription([], {
          useSearch: useMcpToolSearch,
          hasGetSchemaTool,
          includeWriteFile: ctx.sandboxWriteFileHostEnabled,
        });
      if (mcpInSandboxEnabled && mcpDefs.length > 0) {
        try {
          agentTools.execute_sandbox_script.description =
            await buildExecuteSandboxScriptDescription(mcpDefs, {
              useSearch: useMcpToolSearch,
              hasGetSchemaTool,
              includeWriteFile: ctx.sandboxWriteFileHostEnabled,
            });
        } catch (e) {
          logger.warn(
            "Failed to build dynamic execute_sandbox_script description",
            e,
          );
        }
      }
    }
    const allTools: ToolSet = { ...agentTools, ...mcpToolsForRegistration };
    const registeredToolNames = new Set(Object.keys(allTools));

    // Prepare message history with graceful fallback
    // Use messageOverride if provided (e.g., for summarization)
    // If a compaction summary exists, only include messages from that point onward
    // (pre-compaction messages are preserved in DB for the user but not sent to LLM)
    const messageHistory: ModelMessage[] = messageOverride
      ? messageOverride
      : buildChatMessageHistory(chat.messages);
    const latestUserMessage = [...messageHistory]
      .reverse()
      .find((message) => message.role === "user");
    const shouldWarnIfAttachmentUnread =
      currentTurnHasOnDiskAttachment ??
      (latestUserMessage != null &&
        getMessageText(latestUserMessage).includes(
          "Attachments available on disk",
        ));

    // Inject the referenced-apps manifest into the user's latest message as a
    // `<system-reminder>` block (instead of appending it to the system prompt)
    // so the system prompt stays static and cacheable.
    if (referencedApps.length > 0) {
      injectReferencedAppsReminder(messageHistory, referencedApps, {
        codeExplorerAvailable: agentTools.explore_code != undefined,
      });
    }

    // Used to swap out pre-compaction history while preserving in-flight turn steps.
    let baseMessageHistoryCount = messageHistory.length;
    let compactBeforeNextStep = false;
    let compactedMidTurn = false;
    let compactionFailedMidTurn = false;
    // Tracks the difference between the compacted base message count and the
    // SDK's initialMessages count. Used to adjust injection indices after
    // compaction so that subsequent steps (which use the SDK's shorter base)
    // inject user messages at the correct position.
    let compactionIndexDelta = 0;

    const maxOutputTokens = await getMaxTokens(settings.selectedModel);
    const temperature = await getTemperature(settings.selectedModel);

    // Run one or more generation passes. If the model emits a chat message while
    // there are still incomplete todos, we append a reminder and do another pass.
    const maxTodoFollowUpLoops = 2;
    let todoFollowUpLoops = 0;
    let hasInjectedPlanningQuestionnaireReflection = false;
    let currentMessageHistory = messageHistory;
    const accumulatedAiMessages: ModelMessage[] = [];
    let usedAttachmentAccessTool = false;
    // Track total steps across all passes to detect step limit
    let totalStepsExecuted = 0;
    let hitStepLimit = false;
    let modelRefused = false;

    // If there are persisted todos from a previous turn, inject a synthetic
    // user message so the LLM is aware of them. Inserted BEFORE the user's
    // current message so the user's actual request is the last thing the LLM
    // reads, giving it natural priority over stale todos.
    if (
      !messageOverride &&
      !readOnly &&
      !planModeOnly &&
      persistedTodos.length > 0 &&
      hasIncompleteTodos(persistedTodos)
    ) {
      const incompleteTodos = persistedTodos.filter(
        (t) => t.status === "pending" || t.status === "in_progress",
      );
      const todoSummary = formatTodoSummary(incompleteTodos);
      const syntheticMessage: ModelMessage = {
        role: "user",
        content: [
          {
            type: "text",
            text: `[System] You have unfinished todos from your previous turn:\n${todoSummary}\n\nThe user's next message is their current request. If their request relates to these todos, continue working on them. If their request is about something different, discard these old todos by calling update_todos with merge=false and an empty list, then focus entirely on the user's new request.`,
          },
        ],
      };
      // Insert before the last message (the user's current message) so the
      // user's intent is the final thing the LLM sees.
      const insertIndex = Math.max(0, currentMessageHistory.length - 1);
      currentMessageHistory = [
        ...currentMessageHistory.slice(0, insertIndex),
        syntheticMessage,
        ...currentMessageHistory.slice(insertIndex),
      ];
    }

    while (!abortController.signal.aborted) {
      // Reset mid-turn compaction state at the start of each pass.
      // These flags track compaction within a single pass and must not persist
      // across passes (e.g., todo follow-up passes).
      compactedMidTurn = false;
      compactionFailedMidTurn = false;
      compactBeforeNextStep = false;
      compactionIndexDelta = 0;
      postMidTurnCompactionStartStep = null;
      baseMessageHistoryCount = currentMessageHistory.length;

      let passProducedChatText = false;
      // Track whether text was produced AFTER the last tool call. This
      // distinguishes a preamble (text before tools) from a genuine "wrap-up"
      // (text after all tools are done). Only the latter should trigger the
      // "ended with text" break condition.
      let textAfterLastToolCall = false;
      let lastToolCallIndex = -1;
      let responseMessages: ModelMessage[] = [];
      let steps: Array<{
        toolCalls: Array<unknown>;
        response?: { messages?: ModelMessage[] };
      }> = [];
      let terminatedRetryCount = 0;
      let needsContinuationInstruction = false;
      // Set when the model emitted build-mode XML tags (<dyad-read> etc.) as
      // text and the recovery pass executed them. Skips the todo-follow-up
      // break so the agent loop continues until the task is complete.
      let recoveredTextToolsExecuted = false;

      // Retry loop: if the stream terminates with a transient error, captured text/tool events are replayed into message history, a continuation instruction is appended, and the stream is re-opened.
      while (!abortController.signal.aborted) {
        let streamErrorFromCallback: unknown;
        const retryReplayEvents: RetryReplayEvent[] = [];
        activeRetryReplayEvents = retryReplayEvents;
        // Keep the stored history and its compaction boundary in the same
        // canonical shape as the initial messages passed to the AI SDK. The
        // sanitizer can merge split tool-result messages or remove orphaned
        // messages, so a count taken before sanitization can skip generated
        // in-flight messages during mid-turn compaction.
        currentMessageHistory = sanitizeToolCallTranscript(
          currentMessageHistory,
        );
        baseMessageHistoryCount = currentMessageHistory.length;
        const attemptMessages = needsContinuationInstruction
          ? [
              ...currentMessageHistory,
              buildTerminatedRetryContinuationInstruction(),
            ]
          : currentMessageHistory;
        const sanitizedAttemptMessages =
          sanitizeToolCallTranscript(attemptMessages);
        const attemptToolInputIds = new Set<string>();
        const invalidToolCallIds = new Set<string>();
        const rejectedToolCallIds = new Set<string>();
        const validatedToolCallIds = new Set<string>();
        const completedToolXmlByCallId = new Map<string, string>();
        const cleanupAttemptToolStreamingEntries = () => {
          for (const toolCallId of attemptToolInputIds) {
            cleanupStreamingEntry(toolCallId);
          }
          attemptToolInputIds.clear();
        };
        const responseBeforeAttempt = fullResponse;

        try {
          const streamResult = streamText({
            output: fastTextOutput(),
            // Cast resolves the dual ai-package LanguageModel type mismatch
            // between headroom-ai's internal type and the top-level ai import.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            model: withHeadroom(modelClient.model as any, {
              stack: "dyad-agent",
            }) as any,
            // Provider-stall watchdog: a silent upstream (no parts, no error)
            // must not freeze the agent forever. The retry loop below treats
            // the resulting timeout as a transient error and replays/continues.
            timeout: { totalMs: 360_000 },
            headers: {
              ...getAiHeaders({
                builtinProviderId: modelClient.builtinProviderId,
              }),
              [DYAD_INTERNAL_REQUEST_ID_HEADER]: dyadRequestId,
            },
            providerOptions: getProviderOptions({
              dyadAppId: chat.app.id,
              dyadRequestId,
              dyadDisableFiles: true, // Local agent uses tools, not file injection
              files: [],
              mentionedAppsCodebases: [],
              builtinProviderId: modelClient.builtinProviderId,
              settings,
            }),
            maxOutputTokens,
            temperature,
            maxRetries: 2,
            system: systemPrompt,
            messages: sanitizedAttemptMessages,
            tools: allTools,
            stopWhen: [
              stepCountIs(maxToolCallSteps),
              // Stop after the integration tool so the next stream is started
              // with a freshly built system prompt that includes the new
              // Supabase/Neon context. The frontend auto-triggers a hidden
              // continuation message once the user clicks Continue.
              hasToolCall(addIntegrationTool.name),
              // End the turn after the blueprint tool returns: approval may have
              // renamed the app folder, so `ctx.appPath` is now stale. The
              // renderer queues a follow-up user message that starts a fresh
              // turn with a refreshed ctx (see pendingAppBlueprintImplementationAtom).
              hasToolCall(writeAppBlueprintTool.name),
              // In plan mode, also stop after the plan_or_execute tool is called.
              ...(planModeOnly ? [hasToolCall(planOrExecuteTool.name)] : []),
            ],
            abortSignal: abortController.signal,
            // Inject pending user messages (e.g., images from web_crawl) between steps
            // We must re-inject all accumulated messages each step because the AI SDK
            // doesn't persist dynamically injected messages in its internal state.
            // We track the insertion index so messages appear at the same position each step.
            prepareStep: async (options) => {
              let stepOptions = options;

              if (
                !messageOverride &&
                compactBeforeNextStep &&
                !compactedMidTurn &&
                settings.enableContextCompaction !== false
              ) {
                compactBeforeNextStep = false;
                const inFlightTailMessages = options.messages.slice(
                  baseMessageHistoryCount,
                );
                const compacted = await maybePerformPendingCompaction({
                  showOnTopOfCurrentResponse: true,
                  force: true,
                });

                if (compacted) {
                  compactedMidTurn = true;
                  // Preserve only messages generated after this compaction boundary.
                  postMidTurnCompactionStartStep = options.stepNumber;
                  // Clear stale injected messages — their insertAtIndex values are
                  // based on the pre-compaction message array which has been rebuilt
                  // with a different (typically smaller) count. Keeping them would
                  // cause injectMessagesAtPositions to splice at wrong positions.
                  allInjectedMessages.length = 0;
                  const preCompactionBaseCount = baseMessageHistoryCount;
                  const compactedMessageHistory = buildChatMessageHistory(
                    chat.messages,
                    {
                      // Keep the structured in-flight assistant/tool messages from
                      // the current stream instead of the placeholder DB content.
                      excludeMessageIds: new Set([placeholderMessageId]),
                    },
                  );
                  // The referenced-apps reminder lives only in-memory on the
                  // latest user message and is not persisted, so rebuilding
                  // history from the DB drops it. Re-inject so post-compaction
                  // tool steps keep the explicit app_name allow-list.
                  if (referencedApps.length > 0) {
                    injectReferencedAppsReminder(
                      compactedMessageHistory,
                      referencedApps,
                      {
                        codeExplorerAvailable:
                          agentTools.explore_code != undefined,
                      },
                    );
                  }
                  baseMessageHistoryCount = compactedMessageHistory.length;
                  // The compacted history includes the compaction summary, but the
                  // AI SDK's initialMessages does not. Track the delta so we can
                  // adjust injection indices after prepareStepMessages runs.
                  compactionIndexDelta =
                    baseMessageHistoryCount - preCompactionBaseCount;
                  stepOptions = {
                    ...options,
                    // Preserve in-flight turn messages so same-turn tool loops can
                    // continue, while later turns are compacted via persisted history.
                    messages: [
                      ...compactedMessageHistory,
                      ...inFlightTailMessages,
                    ],
                  };
                } else {
                  // Prevent repeated compaction attempts if the first one fails.
                  compactionFailedMidTurn = true;
                }
              }

              const preparedStep = prepareStepMessages(
                stepOptions,
                pendingUserMessages,
                allInjectedMessages,
              );

              // After mid-turn compaction, injection indices are based on the
              // compacted message array (which includes the compaction summary).
              // The AI SDK's internal messages don't include this summary, so
              // subsequent steps have a shorter base. Adjust indices now so
              // future re-injections land at the correct position.
              if (compactionIndexDelta !== 0) {
                for (const injection of allInjectedMessages) {
                  injection.insertAtIndex = Math.max(
                    0,
                    injection.insertAtIndex - compactionIndexDelta,
                  );
                }
                // Always reset, even when no injections exist yet — a tool may
                // add pending messages in a later step and their indices should
                // not be shifted by a stale delta.
                compactionIndexDelta = 0;
              }

              // prepareStepMessages returns undefined when it has no additional
              // injections/cleanups to apply. If we already replaced the base
              // message history (e.g., after mid-turn compaction), we still need
              // to return the updated options.
              let result =
                preparedStep ??
                (stepOptions === options ? undefined : stepOptions);

              // Defensive: ensure injected user messages and split tool result
              // messages don't break tool_use/tool_result pairing. This also
              // runs when prepareStepMessages had no other changes to apply.
              const normalizedStep = sanitizeStepMessages(
                result?.messages ?? stepOptions.messages,
              );
              if (normalizedStep.changed) {
                logger.warn(
                  `Normalized local-agent tool-call transcript before step for chat ${req.chatId}`,
                );
                result = {
                  ...(result ?? stepOptions),
                  messages: normalizedStep.messages,
                };
              }

              return result;
            },
            onStepFinish: async (step) => {
              if (!hasInjectedPlanningQuestionnaireReflection) {
                const questionnaireError =
                  getPlanningQuestionnaireErrorFromStep(step);
                if (questionnaireError) {
                  pendingUserMessages.push([
                    {
                      type: "text",
                      text: buildPlanningQuestionnaireReflectionMessage(
                        questionnaireError,
                        planModeOnly,
                      ),
                    },
                  ]);
                  hasInjectedPlanningQuestionnaireReflection = true;
                  logger.info(
                    `Injected synthetic plan_or_execute reflection message for chat ${req.chatId}`,
                  );
                }
              }

              if (
                settings.enableContextCompaction === false ||
                compactedMidTurn ||
                typeof step.usage.totalTokens !== "number"
              ) {
                return;
              }

              const toolErrors = (step.content ?? []).filter(
                (part) => part.type === "tool-error",
              );
              const toolResultTokens = estimateToolResultTokens(
                step.toolResults ?? [],
                toolErrors,
              );
              const projectedNextRequestTokens =
                step.usage.totalTokens + toolResultTokens;
              const shouldCompact = await checkAndMarkForCompaction(
                req.chatId,
                projectedNextRequestTokens,
              );

              if (toolResultTokens > 0) {
                logger.info(
                  `Projected next request for chat ${req.chatId}: ${projectedNextRequestTokens} tokens (${step.usage.totalTokens} engine-reported + ${toolResultTokens} estimated tool-result tokens)`,
                );
              }

              // If this step triggered tool calls, compact before the next step
              // in this same user turn instead of waiting for the next message.
              // Only attempt mid-turn compaction once per turn.
              if (
                shouldCompact &&
                step.toolCalls.length > 0 &&
                !compactionFailedMidTurn
              ) {
                compactBeforeNextStep = true;
              }
            },
            onFinish: async (response) => {
              const totalTokens = response.usage?.totalTokens;
              const inputTokens = response.usage?.inputTokens;
              const cachedInputTokens = response.usage?.cachedInputTokens;
              logger.log(
                "Total tokens used:",
                totalTokens,
                "Input tokens:",
                inputTokens,
                "Cached input tokens:",
                cachedInputTokens,
                "Cache hit ratio:",
                cachedInputTokens
                  ? (cachedInputTokens ?? 0) / (inputTokens ?? 0)
                  : 0,
              );
              if (typeof totalTokens === "number") {
                await db
                  .update(messages)
                  .set({ maxTokensUsed: totalTokens })
                  .where(eq(messages.id, placeholderMessageId))
                  .catch((err) =>
                    logger.error("Failed to save token count", err),
                  );
              }


              // Preview compilation error detection: check if the dev server
              // reported errors that the agent should fix automatically.
              if (ctx.appId) {
                const previewError = detectPreviewCompilationError(ctx.appId);
                if (previewError) {
                  const previewErrorMsg = buildPreviewErrorMessage(previewError);
                  logger.info(`Preview error detected: ${previewError.summary}`);
                  // Surface as a system message so the agent sees it
                  // and can invoke preview_error_fixer on the next turn
                }
              }
            },
            onError: (error: any) => {
              const normalizedError = unwrapStreamError(error);
              streamErrorFromCallback = normalizedError;
              logger.error(
                "Local agent stream error:",
                getErrorMessage(normalizedError),
              );
            },
          });

          // Read .fullStream now (not lazily) so the SDK's `teeStream()`
          // runs synchronously, then cancel the orphaned tee branch
          // before any chunks are pumped. See `cancelOrphanedBaseStream`
          // for the underlying SDK behavior and why this is required.
          const fullStream = streamResult.fullStream;
          cancelOrphanedBaseStream(streamResult);

          let inThinkingBlock = false;
          let streamErrorFromIteration: unknown;

          try {
            for await (const part of fullStream) {
              if (abortController.signal.aborted) {
                logger.log(`Stream aborted for chat ${req.chatId}`);
                // Clean up pending consent/questionnaire/integration requests to prevent stale UI banners
                clearPendingLocalAgentInputsForChat(req.chatId);
                deleteAppBlueprintForChat(req.chatId);
                break;
              }

              let chunk = "";
              let clearStreamingPreviewAfterChunk = false;

              // Handle thinking block transitions
              if (
                inThinkingBlock &&
                ![
                  "reasoning-delta",
                  "reasoning-end",
                  "reasoning-start",
                ].includes(part.type)
              ) {
                chunk = "</think>\n";
                inThinkingBlock = false;
              }

              switch (part.type) {
                case "finish":
                  if (isModelRefusal(part)) {
                    // Refusals are successful responses and may arrive after
                    // incomplete output, so replace this attempt with a warning.
                    fullResponse = responseBeforeAttempt;
                    passProducedChatText = false;
                    textAfterLastToolCall = false;
                    inThinkingBlock = false;
                    chunk = MODEL_REFUSAL_WARNING;
                    modelRefused = true;
                  }
                  break;

                case "text-delta":
                  passProducedChatText = true;
                  // Track whether this text is AFTER the last tool call
                  textAfterLastToolCall = steps.length > lastToolCallIndex;
                  chunk += part.text;
                  maybeCaptureRetryReplayText(
                    activeRetryReplayEvents,
                    part.text,
                  );
                  break;

                case "reasoning-start":
                  if (!inThinkingBlock) {
                    chunk = "<think>";
                    inThinkingBlock = true;
                  }
                  break;

                case "reasoning-delta":
                  if (!inThinkingBlock) {
                    chunk = "<think>";
                    inThinkingBlock = true;
                  }
                  chunk += part.text;
                  break;

                case "reasoning-end":
                  if (inThinkingBlock) {
                    chunk = "</think>\n";
                    inThinkingBlock = false;
                  }
                  break;

                case "tool-input-start": {
                  // Initialize streaming state for this tool call
                  getOrCreateStreamingEntry(part.id, part.toolName);
                  attemptToolInputIds.add(part.id);
                  break;
                }

                case "tool-input-delta": {
                  // Accumulate args and stream XML preview
                  const entry = getOrCreateStreamingEntry(part.id);
                  if (entry) {
                    entry.argsAccumulated += part.delta;
                    const toolDef = registeredToolNames.has(entry.toolName)
                      ? findToolDefinition(entry.toolName)
                      : undefined;
                    if (toolDef?.buildXml) {
                      const argsPartial = parsePartialJson(
                        entry.argsAccumulated,
                      );
                      const xml = toolDef.buildXml(argsPartial, false);
                      if (xml) {
                        streamingPreviewToolCallId = part.id;
                        ctx.onXmlStream(xml);
                      }
                    }
                  }
                  break;
                }

                case "tool-input-end": {
                  // Prepare final XML, but do not persist it until the SDK's
                  // matching tool-call confirms that schema validation passed.
                  const entry = getOrCreateStreamingEntry(part.id);
                  if (entry) {
                    const toolDef = registeredToolNames.has(entry.toolName)
                      ? findToolDefinition(entry.toolName)
                      : undefined;
                    if (toolDef?.buildXml) {
                      const argsPartial = parsePartialJson(
                        entry.argsAccumulated,
                      );
                      const xml = toolDef.buildXml(argsPartial, true);
                      if (xml) {
                        if (validatedToolCallIds.delete(part.id)) {
                          commitToolXml(xml, part.id);
                        } else if (!rejectedToolCallIds.has(part.id)) {
                          completedToolXmlByCallId.set(part.id, xml);
                        }
                      }
                    }
                  }
                  cleanupStreamingEntry(part.id);
                  attemptToolInputIds.delete(part.id);
                  break;
                }

                case "tool-call":
                  lastToolCallIndex = steps.length;
                  textAfterLastToolCall = false;
                  // AI SDK keeps the original validation exception on the
                  // invalid tool-call part, but stringifies it before the
                  // following tool-error part. Remember the call identity so
                  // the string-valued error can still be classified as a
                  // pre-execution failure.
                  if ("invalid" in part && part.invalid === true) {
                    invalidToolCallIds.add(part.toolCallId);
                    rejectedToolCallIds.add(part.toolCallId);
                    completedToolXmlByCallId.delete(part.toolCallId);
                  } else {
                    const completedXml = completedToolXmlByCallId.get(
                      part.toolCallId,
                    );
                    if (completedXml) {
                      completedToolXmlByCallId.delete(part.toolCallId);
                      commitToolXml(completedXml, part.toolCallId);
                    } else {
                      validatedToolCallIds.add(part.toolCallId);
                    }
                  }
                  if (isAttachmentAccessToolCall(part.toolName, part.input)) {
                    usedAttachmentAccessTool = true;
                  }
                  maybeCaptureRetryReplayEvent(retryReplayEvents, part);
                  // Tool execution happens via execute callbacks
                  break;

                case "tool-result":
                  maybeCaptureRetryReplayEvent(retryReplayEvents, part);
                  // Tool results are already handled by the execute callback
                  break;

                case "tool-error":
                  // Schema validation and unknown-tool errors happen before a
                  // tool's execute callback, so the callback cannot replace
                  // its pending XML preview with a completed card. Persist a
                  // visible terminal state and clear the sidecar only after
                  // that status has reached the renderer. Execution errors
                  // are excluded because buildAgentToolSet already renders
                  // those as dyad-output cards.
                  if (invalidToolCallIds.delete(part.toolCallId)) {
                    chunk += `${buildPreExecutionToolErrorStatus(
                      part.toolName,
                      part.error,
                    )}\n`;
                    clearStreamingPreviewAfterChunk =
                      streamingPreviewToolCallId === part.toolCallId;
                  }
                  break;
              }

              if (chunk) {
                fullResponse += chunk;
                await updateResponseInDb(placeholderMessageId, fullResponse);
                sendChunk(fullResponse);
              }

              if (clearStreamingPreviewAfterChunk) {
                streamingPreview = "";
                streamingPreviewToolCallId = null;
                sendPreview("");
              }

              if (modelRefused) {
                break;
              }
            }
          } catch (error) {
            if (!abortController.signal.aborted) {
              streamErrorFromIteration = error;
            } else {
              logger.log(
                `Stream interrupted after abort for chat ${req.chatId}`,
              );
            }
          }

          // Close thinking block if still open
          if (inThinkingBlock) {
            const closingThinkBlock = "</think>\n";
            fullResponse += closingThinkBlock;
            await updateResponseInDb(placeholderMessageId, fullResponse);
            sendChunk(fullResponse);
          }
          activeRetryReplayEvents = null;

          if (abortController.signal.aborted) {
            break;
          }

          if (modelRefused) {
            // Instead of immediately stopping, try falling back to a
            // different model that might not have the same safety filter.
            if (
              !usedFallbackModel &&
              !abortController.signal.aborted
            ) {
              try {
                fallbackModelClient = (
                  await getModelClient(RECOVERY_AGENT_MODEL, settings)
                ).modelClient;
                modelClient = fallbackModelClient;
                usedFallbackModel = true;
                needsContinuationInstruction = true;
                modelRefused = false;
                maybeAppendRetryReplayForRetry({
                  retryReplayEvents,
                  currentMessageHistoryRef: currentMessageHistory,
                  accumulatedAiMessagesRef: accumulatedAiMessages,
                  onCurrentMessageHistoryUpdate: (next) =>
                    (currentMessageHistory = next),
                });
                sendTelemetryEvent("local_agent:model_refusal_fallback", {
                  chatId: req.chatId,
                  dyadRequestId,
                  fallbackModel: RECOVERY_AGENT_MODEL.name,
                });
                logger.warn(
                  `Model refused for chat ${req.chatId}; falling back to ${RECOVERY_AGENT_MODEL.name} and retrying`,
                );
                await delay(STREAM_RETRY_BASE_DELAY_MS);
                continue;
              } catch (fallbackError: unknown) {
                logger.warn(
                  `Failed to build fallback model client: ${String(fallbackError)}`,
                );
              }
            }
            // No fallback available or already used — stop (like canonical)
            responseMessages = [];
            steps = [];
            break;
          }

          const streamError =
            streamErrorFromIteration ?? streamErrorFromCallback;
          if (streamError) {
            // A dead/unavailable model upstream (e.g. Console Go's grok-4.5)
            // must ALWAYS fall back to a verified working model and retry —
            // not only when the error looks transient. Provider 400s like
            // "Error from provider (Console Go): Upstream request failed:
            // [400] Provider returned error" do not match the transient
            // classifier (408/429/5xx), so without this hoisted check the
            // turn would die with the raw error and the agent would "stop".
            if (
              !usedFallbackModel &&
              !abortController.signal.aborted &&
              isProviderUnavailableError(streamError)
            ) {
              try {
                fallbackModelClient = (
                  await getModelClient(RECOVERY_AGENT_MODEL, settings)
                ).modelClient;
                modelClient = fallbackModelClient;
                usedFallbackModel = true;
                needsContinuationInstruction = true;
                maybeAppendRetryReplayForRetry({
                  retryReplayEvents,
                  currentMessageHistoryRef: currentMessageHistory,
                  accumulatedAiMessagesRef: accumulatedAiMessages,
                  onCurrentMessageHistoryUpdate: (next) =>
                    (currentMessageHistory = next),
                });
                sendTelemetryEvent(
                  "local_agent:provider_unavailable_fallback",
                  {
                    chatId: req.chatId,
                    dyadRequestId,
                    error: String(streamError).slice(0, 300),
                    fallbackModel: RECOVERY_AGENT_MODEL.name,
                    phase: "stream_iteration",
                  },
                );
                logger.warn(
                  `Model upstream unavailable for chat ${req.chatId}; falling back to ${RECOVERY_AGENT_MODEL.name} and retrying`,
                );
                await delay(STREAM_RETRY_BASE_DELAY_MS);
                continue;
              } catch (fallbackError: unknown) {
                logger.warn(
                  `Failed to build fallback model client: ${String(fallbackError)}`,
                );
              }
            }
            if (
              shouldRetryTransientStreamError({
                error: streamError,
                retryCount: terminatedRetryCount,
                aborted: abortController.signal.aborted,
              })
            ) {
              maybeAppendRetryReplayForRetry({
                retryReplayEvents,
                currentMessageHistoryRef: currentMessageHistory,
                accumulatedAiMessagesRef: accumulatedAiMessages,
                onCurrentMessageHistoryUpdate: (next) =>
                  (currentMessageHistory = next),
              });
              terminatedRetryCount += 1;
              needsContinuationInstruction = true;
              const retryDelayMs =
                STREAM_RETRY_BASE_DELAY_MS * terminatedRetryCount;
              // If the configured model's upstream is unavailable (dead
              // provider endpoint, deprecated model, region lock), fall back to
              // a verified-working default model for the retry instead of
              // looping on the dead one.
              if (
                isProviderUnavailableError(streamError) &&
                !usedFallbackModel
              ) {
                try {
                  fallbackModelClient = (
                    await getModelClient(RECOVERY_AGENT_MODEL, settings)
                  ).modelClient;
                  modelClient = fallbackModelClient;
                  usedFallbackModel = true;
                  logger.warn(
                    `Model upstream unavailable for chat ${req.chatId}; falling back to ${RECOVERY_AGENT_MODEL.name} for retry`,
                  );
                } catch (fallbackError: unknown) {
                  logger.warn(
                    `Failed to build fallback model client: ${String(fallbackError)}`,
                  );
                }
              }
              sendTelemetryEvent("local_agent:terminated_stream_retry", {
                chatId: req.chatId,
                dyadRequestId,
                retryCount: terminatedRetryCount,
                error: String(streamError),
                phase: "stream_iteration",
                usedFallbackModel,
              });
              logger.warn(
                `Transient stream termination for chat ${req.chatId}; retrying pass (${terminatedRetryCount}/${MAX_TERMINATED_STREAM_RETRIES}) after ${retryDelayMs}ms`,
              );
              await delay(retryDelayMs);
              continue;
            }
            sendTelemetryEvent(
              "local_agent:terminated_stream_retries_exhausted",
              {
                chatId: req.chatId,
                dyadRequestId,
                retryCount: terminatedRetryCount,
                error: String(streamError),
                phase: "stream_iteration",
              },
            );
            // Instead of throwing (which kills the turn), try fallback model
            if (!usedFallbackModel && !abortController.signal.aborted) {
              try {
                fallbackModelClient = (
                  await getModelClient(RECOVERY_AGENT_MODEL, settings)
                ).modelClient;
                modelClient = fallbackModelClient;
                usedFallbackModel = true;
                needsContinuationInstruction = true;
                maybeAppendRetryReplayForRetry({
                  retryReplayEvents,
                  currentMessageHistoryRef: currentMessageHistory,
                  accumulatedAiMessagesRef: accumulatedAiMessages,
                  onCurrentMessageHistoryUpdate: (next) =>
                    (currentMessageHistory = next),
                });
                logger.warn(
                  `Retries exhausted for chat ${req.chatId}; falling back to ${RECOVERY_AGENT_MODEL.name} instead of stopping`,
                );
                await delay(STREAM_RETRY_BASE_DELAY_MS);
                continue;
              } catch (fallbackError: unknown) {
                logger.warn(
                  `Failed to build fallback model client: ${String(fallbackError)}`,
                );
              }
            }
            // All fallbacks exhausted — surface the error so the outer catch sends it to the UI
            throw streamError;
          }

          try {
            const response = await streamResult.response;
            steps = (await streamResult.steps) ?? [];
            responseMessages = response.messages;
          } catch (err) {
            // Same hoisted provider-unavailable fallback as the stream path:
            // a dead model upstream must fall back to the free-first recovery route even when the
            // error is not classified as transient (e.g. provider 400s).
            if (
              !usedFallbackModel &&
              !abortController.signal.aborted &&
              isProviderUnavailableError(err)
            ) {
              try {
                fallbackModelClient = (
                  await getModelClient(RECOVERY_AGENT_MODEL, settings)
                ).modelClient;
                modelClient = fallbackModelClient;
                usedFallbackModel = true;
                needsContinuationInstruction = true;
                maybeAppendRetryReplayForRetry({
                  retryReplayEvents,
                  currentMessageHistoryRef: currentMessageHistory,
                  accumulatedAiMessagesRef: accumulatedAiMessages,
                  onCurrentMessageHistoryUpdate: (next) =>
                    (currentMessageHistory = next),
                });
                sendTelemetryEvent(
                  "local_agent:provider_unavailable_fallback",
                  {
                    chatId: req.chatId,
                    dyadRequestId,
                    error: String(err).slice(0, 300),
                    fallbackModel: RECOVERY_AGENT_MODEL.name,
                    phase: "response_finalization",
                  },
                );
                logger.warn(
                  `Model upstream unavailable while finalizing for chat ${req.chatId}; falling back to ${RECOVERY_AGENT_MODEL.name} and retrying`,
                );
                await delay(STREAM_RETRY_BASE_DELAY_MS);
                continue;
              } catch (fallbackError: unknown) {
                logger.warn(
                  `Failed to build fallback model client: ${String(fallbackError)}`,
                );
              }
            }
            if (
              shouldRetryTransientStreamError({
                error: err,
                retryCount: terminatedRetryCount,
                aborted: abortController.signal.aborted,
              })
            ) {
              maybeAppendRetryReplayForRetry({
                retryReplayEvents,
                currentMessageHistoryRef: currentMessageHistory,
                accumulatedAiMessagesRef: accumulatedAiMessages,
                onCurrentMessageHistoryUpdate: (next) =>
                  (currentMessageHistory = next),
              });
              terminatedRetryCount += 1;
              needsContinuationInstruction = true;
              const retryDelayMs =
                STREAM_RETRY_BASE_DELAY_MS * terminatedRetryCount;
              sendTelemetryEvent("local_agent:terminated_stream_retry", {
                chatId: req.chatId,
                dyadRequestId,
                retryCount: terminatedRetryCount,
                error: String(err),
                phase: "response_finalization",
              });
              logger.warn(
                `Transient stream termination while finalizing response for chat ${req.chatId}; retrying pass (${terminatedRetryCount}/${MAX_TERMINATED_STREAM_RETRIES}) after ${retryDelayMs}ms`,
              );
              await delay(retryDelayMs);
              continue;
            }
            if (isTerminatedStreamError(err)) {
              // Instead of silently giving up, try fallback model
              if (!usedFallbackModel && !abortController.signal.aborted) {
                try {
                  fallbackModelClient = (
                    await getModelClient(RECOVERY_AGENT_MODEL, settings)
                  ).modelClient;
                  modelClient = fallbackModelClient;
                  usedFallbackModel = true;
                  needsContinuationInstruction = true;
                  maybeAppendRetryReplayForRetry({
                    retryReplayEvents,
                    currentMessageHistoryRef: currentMessageHistory,
                    accumulatedAiMessagesRef: accumulatedAiMessages,
                    onCurrentMessageHistoryUpdate: (next) =>
                      (currentMessageHistory = next),
                  });
                  sendTelemetryEvent(
                    "local_agent:terminated_stream_fallback",
                    {
                      chatId: req.chatId,
                      dyadRequestId,
                      error: String(err).slice(0, 300),
                      phase: "response_finalization",
                      fallbackModel: RECOVERY_AGENT_MODEL.name,
                    },
                  );
                  logger.warn(
                    `Terminated stream during finalization for chat ${req.chatId}; falling back to ${RECOVERY_AGENT_MODEL.name} and retrying`,
                  );
                  await delay(STREAM_RETRY_BASE_DELAY_MS);
                  continue;
                } catch (fallbackError: unknown) {
                  logger.warn(
                    `Failed to build fallback model client: ${String(fallbackError)}`,
                  );
                }
              }
              sendTelemetryEvent(
                "local_agent:terminated_stream_retries_exhausted",
                {
                  chatId: req.chatId,
                  dyadRequestId,
                  retryCount: terminatedRetryCount,
                  error: String(err),
                  phase: "response_finalization",
                },
              );
            }
            logger.warn("Failed to retrieve stream response messages:", err);
            steps = [];
            responseMessages = [];
          }

          break;
        } finally {
          cleanupAttemptToolStreamingEntries();
        }
      }

      if (abortController.signal.aborted) {
        break;
      }

      if (modelRefused) {
        break;
      }

      // --- Text-emitted tool-tag recovery ---
      // Some gateway models occasionally emit
      // build-mode XML tags (<dyad-read path="...">, <dyad-write ...>) as
      // plain text instead of structured tool calls. Without recovery the pass
      // ends with zero executed tools and the turn appears to "stop" mid-task.
      // Parse the tags out of the final text step, execute them through the
      // real tool registry, and feed the results back so the agent loop keeps
      // running until the task is complete.
      if (!abortController.signal.aborted && !modelRefused) {
        try {
          const recovered = await recoverTextEmittedToolCalls({
            steps,
            ctx,
            readOnly,
            planModeOnly,
          });
          if (recovered.executed > 0) {
            recoveredTextToolsExecuted = true;
            totalStepsExecuted += recovered.executed;
            currentMessageHistory = [
              ...currentMessageHistory,
              {
                role: "user",
                content: [{ type: "text", text: recovered.feedbackMessage }],
              },
            ];
            accumulatedAiMessages.push({
              role: "assistant",
              content: [{ type: "text", text: recovered.feedbackMessage }],
            });
            passProducedChatText = true;
            logger.info(
              `Recovered ${recovered.executed} text-emitted tool tags for chat ${req.chatId}; continuing agent loop`,
            );
          }
        } catch (recoveryError) {
          // Never let tag recovery break the turn; fall through to normal
          // termination if parsing/execution fails for any reason.
          logger.warn(
            `Text tool-tag recovery failed for chat ${req.chatId}: ${getErrorMessage(recoveryError)}`,
          );
        }
      }

      // Track total steps for step limit detection
      totalStepsExecuted += steps.length;

      if (responseMessages.length > 0) {
        // For mid-turn compaction, slice off pre-compaction messages
        const messagesToAccumulate =
          compactedMidTurn && postMidTurnCompactionStartStep !== null
            ? (() => {
                // stepNumber is 0-indexed (from AI SDK: stepNumber = steps.length).
                // We want the step just before compaction to determine how many
                // response messages to skip (they belong to pre-compaction context).
                const prevStepMessages =
                  steps[postMidTurnCompactionStartStep - 1]?.response?.messages;
                if (!prevStepMessages) {
                  logger.warn(
                    `No step data found at index ${postMidTurnCompactionStartStep - 1} for mid-turn compaction slicing; persisting all messages`,
                  );
                }
                return responseMessages.slice(prevStepMessages?.length ?? 0);
              })()
            : responseMessages;
        accumulatedAiMessages.push(...messagesToAccumulate);
        currentMessageHistory = [
          ...currentMessageHistory,
          ...messagesToAccumulate,
        ];
      }

      // Check if the model ended with text only (no tool calls in the final step).
      // set_chat_summary is metadata, so a summary-only final step should not
      // suppress the todo safety follow-up when the pass already produced text.
      // Use textAfterLastToolCall (text produced AFTER the last tool call) instead
      // of passProducedChatText (which is set on ANY text delta, including preambles
      // before tool calls). This prevents the agent from stopping when the model
      // produces a preamble then calls tools.
      const lastStep = steps.length > 0 ? steps[steps.length - 1] : null;
      const passEndedWithText =
        textAfterLastToolCall &&
        (!lastStep ||
          lastStep.toolCalls.length === 0 ||
          stepOnlyCalledTool(lastStep, setChatSummaryTool.name));
      if (
        steps.length === 0 &&
        !passProducedChatText &&
        !recoveredTextToolsExecuted &&
        !readOnly &&
        !planModeOnly &&
        todoFollowUpLoops < maxTodoFollowUpLoops
      ) {
        logger.info(
          `Empty pass detected for chat ${req.chatId}; retrying`,
        );
        todoFollowUpLoops += 1;
        continue;
      }
      // Track whether this pass actually executed tools (file reads, writes, etc.)
      const passExecutedTools =
        steps.some((s) => s.toolCalls.length > 0) ||
        recoveredTextToolsExecuted;

      if (
        !recoveredTextToolsExecuted &&
        !shouldRunTodoFollowUpPass({
          readOnly,
          planModeOnly,
          passEndedWithText,
          todos: ctx.todos,
          todoFollowUpLoops,
          maxTodoFollowUpLoops,
        })
      ) {
        // Bug fix (canonical has this bug): The model produced tool calls
        // but NO text after them. passEndedWithText = false so
        // shouldRunTodoFollowUpPass returns false. But the model was actively
        // working — it just didn't wrap up with text. Allow one more pass.
        if (
          !readOnly &&
          !planModeOnly &&
          !passEndedWithText &&
          passExecutedTools &&
          todoFollowUpLoops < maxTodoFollowUpLoops
        ) {
          logger.info(
            `Injecting silent-stop nudge for chat ${req.chatId} (tools executed but no text after last tool)`,
          );
          todoFollowUpLoops += 1;
          continue;
        }
        break;
      }

      todoFollowUpLoops += 1;
      // Do NOT inject a user-role reminder message — it confuses the model
      // because it looks like a real user message. The model already has the
      // todo list in context from the update_todos tool results. Just continue
      // the loop and let the model respond naturally to the tool results.
      logger.info(
        `Starting todo follow-up pass ${todoFollowUpLoops}/${maxTodoFollowUpLoops} for chat ${req.chatId}`,
      );
    }

    // Handle cancellation paths where stream processing exits cleanly after abort.
    if (abortController.signal.aborted) {
      await db
        .update(messages)
        .set({
          content: appendCancelledResponseNotice(fullResponse ?? ""),
        })
        .where(eq(messages.id, placeholderMessageId));
      await clearTodosOnCancel(event, appPath, chat.id, persistedTodos);
      return false; // Cancelled - don't consume quota
    }

    if (modelRefused) {
      accumulatedAiMessages.push({
        role: "assistant",
        content: [{ type: "text", text: MODEL_REFUSAL_WARNING }],
      });
    }

    // Collect XML produced by post-turn side-effects (step-limit notice,
    // Supabase deploy results) so we can persist them into aiMessagesJson.
    // parseAiMessagesJson reads from aiMessagesJson when present and ignores
    // the message's `content` column, so anything appended only to fullResponse
    // would be invisible to subsequent agent turns.
    const postTurnXmlParts: string[] = [];

    // Check if we hit the step limit and append a notice to the response
    if (totalStepsExecuted >= maxToolCallSteps) {
      hitStepLimit = true;
      logger.info(
        `Chat ${req.chatId} hit step limit of ${maxToolCallSteps} steps`,
      );
      const stepLimitXml = `<dyad-step-limit steps="${totalStepsExecuted}" limit="${maxToolCallSteps}">Automatically paused after ${totalStepsExecuted} tool calls.</dyad-step-limit>`;
      postTurnXmlParts.push(stepLimitXml);
      fullResponse += `\n\n${stepLimitXml}`;
      await updateResponseInDb(placeholderMessageId, fullResponse);
      sendChunk(fullResponse);
    }

    // In read-only and plan mode, skip the deploy step (commit follows below)
    if (!readOnly && !planModeOnly) {
      // Deploy all Supabase functions if shared modules changed
      const deployResult = await deployAllFunctionsIfNeeded({
        ...ctx,
        onXmlComplete: (finalXml) => {
          postTurnXmlParts.push(finalXml);
          ctx.onXmlComplete(finalXml);
        },
      });
      if (deployResult.warning) {
        const warningXml = `<dyad-output type="warning" message="${escapeXmlAttr("Supabase function deploy warning")}">${escapeXmlContent(deployResult.warning)}</dyad-output>`;
        postTurnXmlParts.push(warningXml);
        ctx.onXmlComplete(warningXml);
      }
      if (!deployResult.success) {
        const errorXml = `<dyad-output type="error" message="${escapeXmlAttr("Failed to deploy Supabase functions")}">${escapeXmlContent(deployResult.error ?? "Unknown deploy error")}</dyad-output>`;
        postTurnXmlParts.push(errorXml);
        ctx.onXmlComplete(errorXml);
      }
    }

    // Persist post-turn side-effects as a trailing assistant message so future
    // agent turns can see them via aiMessagesJson. Done before the
    // aiMessagesJson write below so deploy/step-limit info is captured even if
    // a later step (e.g. commit) throws.
    if (postTurnXmlParts.length > 0) {
      accumulatedAiMessages.push({
        role: "assistant",
        content: [{ type: "text", text: postTurnXmlParts.join("\n") }],
      });
    }

    if (
      !modelRefused &&
      shouldWarnIfAttachmentUnread &&
      !usedAttachmentAccessTool
    ) {
      const unreadAttachmentWarning =
        "Your model did not reference the attached file. If this was unintended, try a larger model or paste the contents inline.";
      const warningMessage = `\n\n<dyad-output type="warning" message="${escapeXmlAttr(unreadAttachmentWarning)}">${escapeXmlContent(unreadAttachmentWarning)}</dyad-output>`;
      fullResponse += warningMessage;
      await updateResponseInDb(placeholderMessageId, fullResponse);
      sendChunk(fullResponse);
      sendTelemetryEvent("sandbox.tool.unused_with_attachment", {
        chatId: req.chatId,
        appId: ctx.appId,
      });
    }

    // Save the AI SDK messages for multi-turn tool call preservation
    try {
      const aiMessagesJson = getAiMessagesJsonIfWithinLimit(
        accumulatedAiMessages,
      );
      if (aiMessagesJson) {
        await db
          .update(messages)
          .set({ aiMessagesJson })
          .where(eq(messages.id, placeholderMessageId));
      }
    } catch (err) {
      logger.warn("Failed to save AI messages JSON:", err);
    }

    // In read-only and plan mode, skip commits
    if (!readOnly && !planModeOnly) {
      // Commit all changes
      const commitResult = await commitAllChanges(ctx, ctx.chatSummary);

      if (commitResult.commitHash) {
        await db
          .update(messages)
          .set({ commitHash: commitResult.commitHash })
          .where(eq(messages.id, placeholderMessageId));
      }

      // Store Neon DB timestamp for version tracking / time-travel
      if (ctx.neonProjectId && ctx.neonActiveBranchId) {
        try {
          await storeDbTimestampAtCurrentVersion({ appId: ctx.appId });
        } catch (error) {
          logger.error(
            "Error storing Neon timestamp at current version:",
            error,
          );
        }
      }
    }

    // Mark as approved (auto-approve for local-agent)
    await db
      .update(messages)
      .set({ approvalState: "approved" })
      .where(eq(messages.id, placeholderMessageId));

    // The turn's messages have settled; index them for chat search so they
    // are normally searchable by the next turn.
    scheduleChatSearchIndexing();

    // Send telemetry for files with multiple edit tool types
    for (const [filePath, counts] of Object.entries(fileEditTracker)) {
      const toolsUsed = Object.entries(counts).filter(([, count]) => count > 0);
      if (toolsUsed.length >= 2) {
        sendTelemetryEvent("local_agent:file_edit_retry", {
          filePath,
          ...counts,
        });
      }
    }

    // Send completion
    publishQueryInvalidations(
      [{ family: "chats" }, { family: "chat", chatId: req.chatId }],
      event.sender,
    );
    safeSend(event.sender, "chat:response:end", {
      chatId: req.chatId,
      invocationRef: req.invocationRef,
      streamId: req.streamId,
      updatedFiles:
        !readOnly &&
        (!modelRefused ||
          Object.keys(fileEditTracker).length > 0 ||
          ctx.workspaceMutated === true),
      chatSummary: ctx.chatSummary,
      warningMessages:
        warningMessages.length > 0 ? [...new Set(warningMessages)] : undefined,
      pausePromptQueue: hitStepLimit || undefined,
    } satisfies ChatResponseEnd);

    return true; // Success
  } catch (error) {
    // Clean up any pending consent/questionnaire/integration requests for this chat to prevent
    // stale UI banners and orphaned promises
    clearPendingLocalAgentInputsForChat(req.chatId);
    // Only drop the app blueprint itself on explicit cancellation — a transient
    // stream error should leave the plan around so the user can retry from
    // the same approval state instead of losing their edits.
    if (abortController.signal.aborted) {
      deleteAppBlueprintForChat(req.chatId);
    }

    if (abortController.signal.aborted) {
      // Handle cancellation
      await db
        .update(messages)
        .set({
          content: appendCancelledResponseNotice(fullResponse ?? ""),
        })
        .where(eq(messages.id, placeholderMessageId));
      await clearTodosOnCancel(event, appPath, chat.id, persistedTodos);
      return false; // Cancelled - don't consume quota
    }

    logger.error("Local agent error:", error);
    safeSend(event.sender, "chat:response:error", {
      chatId: req.chatId,
      invocationRef: req.invocationRef,
      streamId: req.streamId,
      error: `Error: ${getErrorMessageWithDetails(error)}`,
      warningMessages:
        warningMessages.length > 0 ? [...new Set(warningMessages)] : undefined,
    });
    return false; // Error - don't consume quota
  } finally {
    // If an in-progress tool's XML preview was overlaid in the renderer
    // and the stream tore down before onXmlComplete could commit and
    // clear it (cancel, error, abort), explicitly clear the overlay so
    // a stale XML preview doesn't persist past stream end. Idempotent
    // when the overlay is already empty.
    if (streamingPreview.length > 0) {
      sendPreview("");
      streamingPreview = "";
      streamingPreviewToolCallId = null;
    }
  }
}

/**
 * Roll back a chat's todos to its pre-turn state when its turn is cancelled.
 *
 * Only the todos created or changed by the cancelled response should be
 * discarded — todos persisted by an earlier successful turn must survive so a
 * cancelled follow-up (or a read-only turn) doesn't silently lose outstanding
 * work. We therefore restore the `priorTodos` snapshot captured at turn start:
 * if it is empty (no todos existed before this turn) we delete the file, and
 * otherwise we rewrite it with the snapshot. Either way the renderer is sent the
 * restored list so its UI matches disk.
 */
async function clearTodosOnCancel(
  event: IpcMainInvokeEvent,
  appPath: string,
  chatId: number,
  priorTodos: Todo[],
): Promise<void> {
  if (priorTodos.length > 0) {
    await saveTodos(appPath, chatId, priorTodos);
  } else {
    await deleteTodos(appPath, chatId);
  }
  broadcastToRegisteredWindows(event.sender, "agent-tool:todos-update", {
    chatId,
    todos: priorTodos,
  });
}

function buildTerminatedRetryContinuationInstruction(): ModelMessage {
  return {
    role: "user",
    content: [{ type: "text", text: STREAM_CONTINUE_MESSAGE }],
  };
}

function unwrapStreamError(error: unknown): unknown {
  if (isObject(error) && "error" in error) {
    return error.error;
  }
  return error;
}

function getErrorMessage(error: unknown): string {
  const raw = getRawErrorMessage(error);
  return decorateModelProviderError(raw);
}

// Legacy/hyphen tool names that can appear inside compaction summaries the
// model writes (it imitates the `<dyad-...>` transcript format). Convert them
// into compact readable notation so the compaction box doesn't show raw XML.
const COMPACTION_TOOL_NAMES: Record<string, string> = {
  "read": "read_file",
  "write": "write_file",
  "list-files": "list_files",
  "search-replace": "search_replace",
  "grep": "grep",
  "execute-sql": "execute_sql",
  "read-logs": "read_logs",
  "script": "execute_sandbox_script",
  "execute-sandbox-script": "execute_sandbox_script",
  "add-dependency": "add_dependency",
  "delete": "delete_file",
  "copy": "copy_file",
  "web-search": "web_search",
  "web-fetch": "web_fetch",
  "read-chat": "read_chat",
  "write-plan": "write_plan",
  "explore-code": "explore_code",
  "git-context": "git_context",
  "code-search": "code_search",
  "read-guide": "read_guide",
  "update-todos": "update_todos",
  "exit-plan": "exit_plan",
  "restart-app": "app_lifecycle",
  "rebuild-app": "app_lifecycle",
};

// Underscore legacy names (stock Dyad format `<function=dyad_read>`) inside
// compaction summaries.
const COMPACTION_TOOL_NAMES_SNAKE: Record<string, string> = {
  dyad_read: "read_file",
  dyad_read_file: "read_file",
  dyad_write: "write_file",
  dyad_list_files: "list_files",
  dyad_search_replace: "search_replace",
  dyad_execute_sql: "execute_sql",
  dyad_script: "execute_sandbox_script",
  dyad_execute_sandbox_script: "execute_sandbox_script",
  dyad_read_logs: "read_logs",
  dyad_add_dependency: "add_dependency",
  dyad_restart_app: "app_lifecycle",
  dyad_rebuild_app: "app_lifecycle",
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
  dyad_grep: "grep",
};

function sanitizeCompactionSummary(text: string): string {
  let out = text;
  // <dyad-read path="src/x.ts" start_line="1"> → [read_file path=src/x.ts ...]
  out = out.replace(
    /<dyad-([a-z-]+)((?:\s+[a-z_]+="[^"]*")*)\s*\/?>/g,
    (match, name: string, attrs: string) => {
      const canonical = COMPACTION_TOOL_NAMES[name] ?? name;
      const args = [
        ...attrs.matchAll(/([a-z_]+)="([^"]*)"/g),
      ].map((a) => `${a[1]}=${a[2]}`);
      return `[${canonical}${args.length > 0 ? ` ${args.join(" ")}` : ""}]`;
    },
  );
  out = out.replace(/<\/dyad-[a-z-]+>/g, "");
  // Old stock-app format: <tool_call><function=dyad_read><parameter=path>X</parameter>
  out = out
    .replace(/<\/?tool_call>/gi, "")
    .replace(/<function=([a-z_]+)>/gi, (match, name: string) => {
      const canonical = COMPACTION_TOOL_NAMES_SNAKE[name] ?? name;
      return `[${canonical} `;
    }) // open → "[read_file "
    .replace(/<\/function>/gi, "]") // close → "]"
    .replace(/<parameter=([a-z_]+)>/gi, "$1=") // open → "path="
    .replace(/<\/parameter>/gi, ""); // close → removed
  return out;
}

// ============================================================================
// Text-emitted tool-tag recovery
// ============================================================================

const DYAD_TEXT_TOOL_TAG_RE =
  /<dyad-([a-z]+(?:-[a-z]+)*)((?:\s+[a-zA-Z_]+(?:-[a-zA-Z0-9_]+)*="[^"]*")*)\s*\/?>/g;

/**
 * Some gateway models occasionally emit
 * build-mode XML tags — `<dyad-read path="...">`, `<dyad-write path="...">`,
 * etc. — as plain text instead of structured tool calls. The agent pass then
 * ends with zero executed tools and the turn appears to "stop" mid-task.
 *
 * This parses those tags out of the final text step, executes them through the
 * real tool registry (respecting read-only/plan mode), and returns the results
 * so the caller can feed them back and continue the agent loop.
 */
export async function recoverTextEmittedToolCalls({
  steps,
  ctx,
  readOnly,
  planModeOnly,
}: {
  steps: Array<{
    toolCalls: Array<unknown>;
    response?: { messages?: ModelMessage[] };
  }>;
  ctx: AgentContext;
  readOnly: boolean;
  planModeOnly: boolean;
}): Promise<{ executed: number; feedbackMessage: string }> {
  if (steps.length === 0) {
    return { executed: 0, feedbackMessage: "" };
  }
  const lastStep = steps[steps.length - 1];
  // Only recover text-only steps; structured tool calls already executed.
  if (!lastStep || (lastStep.toolCalls?.length ?? 0) > 0) {
    return { executed: 0, feedbackMessage: "" };
  }
  const stepWithContent = lastStep as unknown as {
    content?: Array<{ type: string; text?: string }>;
  };
  const text = (stepWithContent.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("");
  const matches = [...text.matchAll(DYAD_TEXT_TOOL_TAG_RE)];
  if (matches.length === 0) {
    return { executed: 0, feedbackMessage: "" };
  }

  const results: string[] = [];
  let executed = 0;
  for (const match of matches) {
    const rawName = match[1];
    const attrs = match[2] ?? "";
    // Tag names are hyphenated in XML (<dyad-read-chat>) but the legacy alias
    // map uses snake_case keys with the dyad_ prefix (dyad_read_chat). Try the
    // prefixed snake_case key first, then the raw name as a fallback.
    const snakeName = rawName.replace(/-/g, "_");
    const canonical =
      COMPACTION_TOOL_NAMES[`dyad_${snakeName}`] ??
      COMPACTION_TOOL_NAMES[rawName] ??
      rawName;
    const toolDef = findToolDefinition(canonical);
    if (!toolDef) {
      logger.warn(
        `Text tool-tag recovery: <dyad-${rawName}> has no registered tool (${canonical}); skipping`,
      );
      results.push(
        `<dyad-tool-result tool="${canonical}" state="error">Unknown tool ${canonical}</dyad-tool-result>`,
      );
      continue;
    }
    if (
      (readOnly || planModeOnly) &&
      (typeof toolDef.modifiesState === "function"
        ? toolDef.modifiesState(ctx)
        : toolDef.modifiesState === true)
    ) {
      results.push(
        `<dyad-tool-result tool="${canonical}" state="error">Tool ${canonical} is not available in ${readOnly ? "read-only" : "plan"} mode</dyad-tool-result>`,
      );
      continue;
    }
    const args: Record<string, string> = {};
    for (const attr of attrs.matchAll(/([a-z_]+)="([^"]*)"/g)) {
      args[attr[1]] = attr[2];
    }
    try {
      const result = await toolDef.execute(args as any, ctx);
      executed += 1;
      results.push(
        `<dyad-tool-result tool="${canonical}" state="success">${escapeXmlContent(result)}</dyad-tool-result>`,
      );
    } catch (err) {
      results.push(
        `<dyad-tool-result tool="${canonical}" state="error">${escapeXmlContent(getErrorMessage(err))}</dyad-tool-result>`,
      );
    }
  }

  if (executed === 0) {
    return { executed: 0, feedbackMessage: "" };
  }

  const feedbackMessage =
    `<dyad-system>You emitted build-mode XML tags as text instead of using the standard tool call format. ` +
    `Dyad executed ${executed} of them for you. Results:\n${results.join(
      "\n",
    )}\n` +
    `Continue the task using the standard tool call format until it is complete.</dyad-system>`;
  return { executed, feedbackMessage };
}

function getRawErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  if (typeof error === "string") {
    return error;
  }
  if (isObject(error)) {
    if (typeof error.message === "string" && error.message.length > 0) {
      return error.message;
    }
    if ("error" in error) {
      return getRawErrorMessage(error.error);
    }
    if ("cause" in error) {
      return getRawErrorMessage(error.cause);
    }
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

// Errors whose upstream provider is unavailable (as opposed to transient
// network blips, which the normal retry loop already handles). Retrying with
// the same model is pointless; the caller switches to RECOVERY_AGENT_MODEL.
function isProviderUnavailableError(error: unknown): boolean {
  const message = getRawErrorMessage(error);
  return (
    /Error from provider[^\n]*/i.test(message) ||
    /Endpoint is unavailable/i.test(message) ||
    /Model is unavailable/i.test(message) ||
    /has been deprecat/i.test(message) ||
    /only available hosted in/i.test(message) ||
    /upstream\s+request\s+failed/i.test(message)
  );
}

// Model upstreams behind gateways (e.g. opencode's "Console Go" provider for
// grok-4.5) can be temporarily unavailable even when the rest of the catalog
// works. Turn the bare error into actionable guidance so the agent/user
// switches to a verified-working model instead of looping on the dead one.
function decorateModelProviderError(message: string): string {
  if (
    /Error from provider[^\n]*|Endpoint is unavailable|upstream\s+request\s+failed/i.test(
      message,
    )
  ) {
    return (
      `${message}\n\n` +
      `Hint: this model's upstream provider is temporarily unavailable. ` +
      `The app will retry through Zenith Free automatically; you can also switch to ` +
      `another configured model ` +
      `or retry later — the failure is on the provider side, not in the app or your key.`
    );
  }
  return message;
}

function getErrorResponseBody(error: unknown, depth = 0): string | undefined {
  if (!isObject(error) || depth > MAX_ERROR_RESPONSE_BODY_DEPTH) {
    return undefined;
  }
  if (typeof error.responseBody === "string" && error.responseBody.length > 0) {
    return error.responseBody;
  }
  if ("error" in error) {
    const nested = getErrorResponseBody(error.error, depth + 1);
    if (nested) {
      return nested;
    }
  }
  if ("cause" in error) {
    return getErrorResponseBody(error.cause, depth + 1);
  }
  return undefined;
}

// Markers that identify the engine's free-model quota error in a response
// body. We only surface raw response bodies for this case so the renderer's
// ChatErrorBox can recognize the quota error; other errors keep their normal
// (non-verbose) message.
const FREE_MODEL_QUOTA_MARKERS = [
  "dyad_free_model_quota_exceeded",
  "FREE_MODEL_QUOTA_EXCEEDED",
  "Dyad Free has reached its daily limit.",
  "Dyad Free limit",
];

function getErrorMessageWithDetails(error: unknown): string {
  const message = getErrorMessage(error);
  const responseBody = getErrorResponseBody(error);
  if (!responseBody || message.includes(responseBody)) {
    return message;
  }
  const isFreeModelQuotaBody = FREE_MODEL_QUOTA_MARKERS.some((marker) =>
    responseBody.includes(marker),
  );
  if (!isFreeModelQuotaBody) {
    return message;
  }
  return `${message}\n\nDetails: ${responseBody}`;
}

function isTerminatedStreamError(error: unknown): boolean {
  const normalized = unwrapStreamError(error);
  const message = getErrorMessage(normalized).toLowerCase();
  if (message.includes("typeerror: terminated") || message === "terminated") {
    return true;
  }
  const cause =
    isObject(normalized) && "cause" in normalized
      ? normalized.cause
      : undefined;
  if (cause) {
    return isTerminatedStreamError(cause);
  }
  return false;
}

function isRetryableProviderStreamError(error: unknown): boolean {
  const normalized = unwrapStreamError(error);
  if (!isObject(normalized)) {
    return false;
  }

  const statusCode =
    (typeof normalized.statusCode === "number" && normalized.statusCode) ||
    (typeof normalized.status === "number" && normalized.status) ||
    (isObject(normalized.response) &&
    typeof normalized.response.status === "number"
      ? normalized.response.status
      : undefined);

  if (
    typeof statusCode === "number" &&
    (statusCode >= 500 || RETRYABLE_STREAM_ERROR_STATUS_CODES.has(statusCode))
  ) {
    return true;
  }

  const errorString =
    [
      typeof normalized.message === "string" ? normalized.message : undefined,
      typeof normalized.code === "string" ? normalized.code : undefined,
      typeof normalized.type === "string" ? normalized.type : undefined,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase() || getErrorMessage(normalized).toLowerCase();

  return RETRYABLE_STREAM_ERROR_PATTERNS.some((pattern) =>
    errorString.includes(pattern),
  );
}

function shouldRetryTransientStreamError(params: {
  error: unknown;
  retryCount: number;
  aborted: boolean;
}): boolean {
  const { error, retryCount, aborted } = params;
  return (
    !aborted &&
    retryCount < MAX_TERMINATED_STREAM_RETRIES &&
    (isTerminatedStreamError(error) || isRetryableProviderStreamError(error))
  );
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function updateResponseInDb(messageId: number, content: string) {
  await db
    .update(messages)
    .set({ content })
    .where(eq(messages.id, messageId))
    .catch((err) => logger.error("Failed to update message", err));
}

function sendResponseChunk(
  event: IpcMainInvokeEvent,
  chatId: number,
  invocationRef: ChatStreamParams["invocationRef"],
  streamId: number | undefined,
  chat: any,
  fullResponse: string,
  placeholderMessageId: number,
  hiddenMessageIds: Set<number> | undefined,
  /** When true, sends the full messages array instead of an incremental update */
  sendFullMessages: boolean | undefined,
  /** Mutable ref tracking the renderer's last seen placeholder content. */
  lastSentRef: { value: string },
) {
  if (sendFullMessages) {
    const currentMessages = (chat.messages as RendererMessageRow[])
      .filter((message) => !hiddenMessageIds?.has(message.id))
      .map(toRendererMessage);
    const placeholderMsg = currentMessages.find(
      (m) => m.id === placeholderMessageId,
    );
    if (placeholderMsg) {
      placeholderMsg.content = fullResponse;
    }
    sendChatChunk(event.sender, {
      chatId,
      invocationRef,
      streamId,
      messages: currentMessages,
    });
    // Renderer's placeholder content now matches fullResponse — keep the
    // tail-diff baseline in sync so the next streaming patch is correct.
    lastSentRef.value = fullResponse;
  } else {
    const oldLen = lastSentRef.value.length;
    const patch = computeStreamingPatch(fullResponse, lastSentRef.value);
    if (!patch) {
      return;
    }
    // Streaming patches are reserved for true append-only tail growth
    // (offset === oldLen). When offset < oldLen the new content diverges
    // inside the prior tail; applying the patch on the renderer would
    // cleanly shrink visible content with no mismatch, briefly vanishing
    // the response. Escalate to a fullMessages send so the renderer
    // authoritatively replaces content.
    if (patch.offset < oldLen) {
      sendResponseChunk(
        event,
        chatId,
        invocationRef,
        streamId,
        chat,
        fullResponse,
        placeholderMessageId,
        hiddenMessageIds,
        true,
        lastSentRef,
      );
      return;
    }
    lastSentRef.value = fullResponse;
    sendChatChunk(event.sender, {
      chatId,
      invocationRef,
      streamId,
      streamingMessageId: placeholderMessageId,
      streamingPatch: patch,
    });
  }
}

function getPlanningQuestionnaireErrorFromStep(step: {
  content?: unknown;
}): string | null {
  if (!Array.isArray(step.content)) {
    return null;
  }

  for (const part of step.content) {
    if (!isObject(part) || part.toolName !== PLANNING_TOOL_NAME) {
      continue;
    }

    if (part.type === "tool-error") {
      return typeof part.error === "string" ? part.error : "Unknown tool error";
    }

    if (
      part.type === "tool-result" &&
      typeof part.output === "string" &&
      part.output.startsWith("Error:")
    ) {
      return part.output;
    }
  }

  return null;
}

function buildPlanningQuestionnaireReflectionMessage(
  errorDetail?: string,
  planModeOnly?: boolean,
): string {
  const base = "Your plan_or_execute tool call had a format error.";
  const detail = errorDetail ? ` The error was: ${errorDetail}` : "";
  if (planModeOnly) {
    return `[System]${base}${detail} Review the tool's input schema, fix the issue, and re-call plan_or_execute with correct arguments.`;
  }
  return `[System]${base}${detail} Skip the questionnaire step and proceed directly to the planning phase.`;
}

function stepOnlyCalledTool(
  step: { toolCalls: Array<unknown> },
  toolName: string,
): boolean {
  return (
    step.toolCalls.length > 0 &&
    step.toolCalls.every(
      (toolCall) => isObject(toolCall) && toolCall.toolName === toolName,
    )
  );
}

function shouldRunTodoFollowUpPass(params: {
  readOnly: boolean;
  planModeOnly: boolean;
  passEndedWithText: boolean;
  todos: AgentContext["todos"];
  todoFollowUpLoops: number;
  maxTodoFollowUpLoops: number;
}): boolean {
  const {
    readOnly,
    planModeOnly,
    passEndedWithText,
    todos,
    todoFollowUpLoops,
    maxTodoFollowUpLoops,
  } = params;
  return (
    !readOnly &&
    !planModeOnly &&
    passEndedWithText &&
    hasIncompleteTodos(todos) &&
    todoFollowUpLoops < maxTodoFollowUpLoops
  );
}

/**
 * Build a ToolSet from the user's enabled MCP servers, exposing each MCP
 * tool to the LLM as an individually-registered tool. Used only when the
 * sandbox-script experiment is OFF — when ON, MCP tools are instead
 * exposed as host functions inside `execute_sandbox_script` (see the
 * caller for the branching logic).
 *
 * Mirrors the consent flow + XML emission of the sandbox capability
 * map: every call requires user consent, emits a
 * `<dyad-mcp-tool-call>` / `<dyad-mcp-tool-result>` pair for the UI,
 * and surfaces tool errors as `<dyad-output type="error">`.
 */
async function getMcpTools(
  event: IpcMainInvokeEvent,
  ctx: AgentContext,
): Promise<ToolSet> {
  const mcpToolSet: ToolSet = {};

  try {
    const servers = await db
      .select()
      .from(mcpServers)
      .where(eq(mcpServers.enabled, true as any));

    for (const s of servers) {
      // One bad server (e.g. unconnected OAuth) must not strip tools
      // from every later enabled server in the same agent run.
      const toolSet = await (async () => {
        try {
          const client = await mcpManager.getClient(s.id);
          return await client.tools();
        } catch (e) {
          logger.warn(
            `Failed to load tools for MCP server ${s.id} (${s.name})`,
            e,
          );
          return null;
        }
      })();
      if (!toolSet) continue;

      for (const [name, mcpTool] of Object.entries(toolSet)) {
        const key = `${sanitizeMcpName(s.name || "")}__${sanitizeMcpName(name)}`;

        mcpToolSet[key] = {
          description: mcpTool.description,
          inputSchema: mcpTool.inputSchema,
          execute: async (args: unknown, execCtx: ToolExecutionOptions) => {
            const { serverName, toolName } = parseMcpToolKey(key);
            const callId = execCtx.toolCallId;
            let callEmitted = false;
            try {
              const inputPreview =
                typeof args === "string"
                  ? args
                  : Array.isArray(args)
                    ? args.join(" ")
                    : JSON.stringify(args).slice(0, 500);

              const autoApprove = buildMcpAutoApprove({
                settings: readSettings(),
                isDyadPro: ctx.isDyadPro,
                freeModelMode: ctx.freeModelMode,
                chatId: ctx.chatId,
                serverName: s.name,
                toolName: name,
                toolDescription: mcpTool.description,
                inputSchema: mcpTool.inputSchema,
                args,
              });

              const { approved, autoApprovedReason } =
                await requireMcpToolConsent(event, {
                  serverId: s.id,
                  serverName: s.name,
                  toolName: name,
                  toolDescription: mcpTool.description,
                  inputPreview,
                  chatId: ctx.chatId,
                  autoApprove,
                  abortSignal: ctx.abortSignal,
                });

              if (!approved)
                throw new DyadError(
                  `User declined running tool ${key}`,
                  DyadErrorKind.UserCancelled,
                );

              // Emit XML for UI (MCP tools don't stream, so use onXmlComplete directly)
              const content = JSON.stringify(args, null, 2);
              const autoApprovedAttr = autoApprovedReason
                ? ` auto-approved-reason="${escapeXmlAttr(autoApprovedReason)}"`
                : "";
              ctx.onXmlComplete(
                `<dyad-mcp-tool-call server="${escapeXmlAttr(serverName)}" tool="${escapeXmlAttr(toolName)}" call-id="${escapeXmlAttr(callId)}"${autoApprovedAttr}>\n${escapeXmlContent(content)}\n</dyad-mcp-tool-call>`,
              );
              callEmitted = true;

              const res = await mcpTool.execute(args, execCtx);
              const safeResult = sanitizeMcpToolResult(res);

              ctx.onXmlComplete(
                `<dyad-mcp-tool-result server="${escapeXmlAttr(serverName)}" tool="${escapeXmlAttr(toolName)}" call-id="${escapeXmlAttr(callId)}">\n${escapeXmlContent(safeResult.serialized)}\n</dyad-mcp-tool-result>`,
              );

              return safeResult.serialized;
            } catch (error) {
              const errorMessage =
                error instanceof Error ? error.message : String(error);
              const errorStack =
                error instanceof Error && error.stack ? error.stack : "";
              const safeErrorMessage =
                sanitizeMcpToolResult(errorMessage).serialized;
              const safeErrorDetails = sanitizeMcpToolResult(
                errorStack || errorMessage,
              ).serialized;
              // Terminate the merged card in an error state instead of leaving
              // it stuck on "Running" (only when its call card was emitted).
              if (callEmitted) {
                ctx.onXmlComplete(
                  `<dyad-mcp-tool-result server="${escapeXmlAttr(serverName)}" tool="${escapeXmlAttr(toolName)}" call-id="${escapeXmlAttr(callId)}" is-error="true">\n${escapeXmlContent(safeErrorMessage)}\n</dyad-mcp-tool-result>`,
                );
              }
              ctx.onXmlComplete(
                `<dyad-output type="error" message="MCP tool '${key}' failed: ${escapeXmlAttr(safeErrorMessage)}">${escapeXmlContent(safeErrorDetails)}</dyad-output>`,
              );
              throw error;
            }
          },
        };
      }
    }
  } catch (e) {
    logger.warn("Failed building MCP toolset for local-agent", e);
  }

  return mcpToolSet;
}
