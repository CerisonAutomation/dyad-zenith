import { z } from "zod";
import crypto from "node:crypto";
import log from "electron-log";
import { eq } from "drizzle-orm";
import { ToolDefinition, AgentContext, escapeXmlAttr } from "./types";
import { userInputRegistry } from "@/user_input/main";
import { escapeXmlContent } from "../../../../../../../shared/xmlEscape";
import { broadcastToRegisteredWindows } from "@/ipc/utils/window_broadcast";
import { savePlanToDisk } from "@/ipc/handlers/planPersistence";
import { rememberPlanDraft } from "@/ipc/services/plan_handoff_service";
import { safeSend } from "@/ipc/utils/safe_sender";
import { DyadError, DyadErrorKind } from "@/errors/dyad_error";
import { db } from "@/db";
import { apps } from "@/db/schema";
import { startPlanHandoffFromMain } from "@/ipc/services/plan_handoff_service";

const logger = log.scope("plan_or_execute");

// ─── Schemas ──────────────────────────────────────────────────────────────────

const QuestionSchema = z
  .object({
    id: z
      .string()
      .optional()
      .describe(
        "Unique identifier for this question (auto-generated if omitted)",
      ),
    question: z.string().describe("The question text to display to the user"),
    type: z
      .enum(["text", "radio", "checkbox"])
      .describe(
        "text for free-form input, radio for single choice, checkbox for multiple choice",
      ),
    options: z
      .array(z.string())
      .min(1)
      .max(3)
      .optional()
      .describe(
        "Options for radio/checkbox questions. Keep to max 3 — users can always provide a custom answer via the free-form text input. Omit for text questions.",
      ),
    required: z
      .boolean()
      .optional()
      .describe("Whether this question requires an answer (defaults to true)"),
    placeholder: z
      .string()
      .optional()
      .describe("Placeholder text for text inputs"),
  })
  .refine((q) => q.type === "text" || (q.options && q.options.length >= 1), {
    message: "options are required for radio and checkbox questions",
    path: ["options"],
  });

const inputSchema = z.object({
  reasoning: z
    .string()
    .describe(
      "Explain your thinking before acting: what you understand about the user's request, why you chose this action, and what you expect the outcome to be.",
    ),
  action: z
    .enum(["questionnaire", "write_plan", "exit_plan"])
    .describe(
      "The planning action to perform. Must follow the sequence: questionnaire -> write_plan -> exit_plan.",
    ),
  // ── questionnaire fields ──
  questions: z
    .array(QuestionSchema)
    .min(1)
    .max(3)
    .optional()
    .describe(
      "Required when action='questionnaire'. A non-empty array of 1-3 questions to present to the user.",
    ),
  // ── write_plan fields ──
  title: z
    .string()
    .optional()
    .describe(
      "Required when action='write_plan'. Title of the implementation plan.",
    ),
  summary: z
    .string()
    .optional()
    .describe(
      "Required when action='write_plan'. Brief summary (1-2 sentences) of what will be built.",
    ),
  plan: z
    .string()
    .optional()
    .describe(
      "Required when action='write_plan'. Full implementation plan in markdown format. Include sections for: feature overview, UI/UX design, considerations, technical approach, implementation steps, code changes, and testing strategy. Put product/UX sections first, technical sections last.",
    ),
  // ── exit_plan fields ──
  confirmation: z
    .boolean()
    .optional()
    .describe(
      "Required when action='exit_plan'. Whether the user has accepted the plan. Must be true to proceed.",
    ),
});

// ─── Description ──────────────────────────────────────────────────────────────

const DESCRIPTION = `
A unified planning tool that replaces the separate planning_questionnaire, write_plan, and exit_plan tools.

The tool supports three actions that MUST follow the correct sequence:
1. "questionnaire" — Present structured questions to gather requirements from the user. Use when the request is vague or open-ended.
2. "write_plan" — Present an implementation plan in the preview panel after gathering requirements. The plan should be comprehensive (product/UX first, technical last).
3. "exit_plan" — Exit plan mode after the user has explicitly accepted the plan, transitioning to implementation.

The "reasoning" field is REQUIRED. Use it to explain your thinking before each action:
- What you understand about the user's request
- Why you chose this specific action
- What you expect the outcome to be

SEQUENCE VALIDATION:
- Must start with "questionnaire" (unless the request is already specific enough to go straight to write_plan)
- "write_plan" requires that questionnaire responses have been collected (or the request was concrete enough to skip)
- "exit_plan" requires that a plan has been presented and the user has explicitly accepted it
- You cannot skip steps or go backwards

INPUT FIELDS BY ACTION:

For action="questionnaire":
  - reasoning (REQUIRED): Your analysis of why questions are needed
  - questions (REQUIRED): Array of 1-3 question objects
    Each question has: question (string), type ("text"|"radio"|"checkbox"), options (array, required for radio/checkbox), required (boolean, optional), placeholder (string, optional)

For action="write_plan":
  - reasoning (REQUIRED): Your analysis of the requirements gathered
  - title (REQUIRED): Plan title
  - summary (REQUIRED): 1-2 sentence summary
  - plan (REQUIRED): Full markdown implementation plan

For action="exit_plan":
  - reasoning (REQUIRED): Confirmation that the user accepted the plan
  - confirmation (REQUIRED): Must be true

EXAMPLE — questionnaire:
{
  "reasoning": "The user asked to 'build me a todo app'. The request is vague — I need to clarify the tech stack and key features before writing a plan.",
  "action": "questionnaire",
  "questions": [
    { "type": "radio", "question": "What visual style do you prefer?", "options": ["Minimal & clean", "Colorful & playful", "Dark & modern"] },
    { "type": "checkbox", "question": "Which features do you want?", "options": ["Due dates", "Categories/tags", "Priority levels"] }
  ]
}

EXAMPLE — write_plan:
{
  "reasoning": "Based on the user's answers, they want a dark, minimal todo app with due dates and categories. I'll present a focused plan.",
  "action": "write_plan",
  "title": "Minimal Todo App with Due Dates",
  "summary": "A dark-themed todo app with due date tracking and category filtering.",
  "plan": "## Overview\\n\\nBuild a minimal todo application...\\n\\n## Implementation Steps\\n\\n1. Set up project structure..."
}

EXAMPLE — exit_plan:
{
  "reasoning": "The user reviewed the plan and said 'looks good, let's build it'. They have explicitly accepted the plan.",
  "action": "exit_plan",
  "confirmation": true
}
`;

// ─── Tool Definition ──────────────────────────────────────────────────────────

export const planOrExecuteTool: ToolDefinition<z.infer<typeof inputSchema>> = {
  name: "plan_or_execute",
  description: DESCRIPTION,
  inputSchema,
  defaultConsent: "always",
  modifiesState: true,

  getConsentPreview: (args) => {
    switch (args.action) {
      case "questionnaire":
        return `Questionnaire (${args.questions?.length ?? 0} questions)`;
      case "write_plan":
        return `Plan: ${args.title}`;
      case "exit_plan":
        return "Exit plan mode and start implementation";
    }
  },

  buildXml: (args, isComplete) => {
    switch (args.action) {
      case "write_plan": {
        if (!args.title) return undefined;
        const title = escapeXmlAttr(args.title);
        const summary = args.summary ? escapeXmlAttr(args.summary) : "";
        return `<dyad-write-plan title="${title}" summary="${summary}" complete="${isComplete}"></dyad-write-plan>`;
      }
      case "exit_plan": {
        if (!args.confirmation) return undefined;
        return `<dyad-exit-plan></dyad-exit-plan>`;
      }
      default:
        return undefined;
    }
  },

  execute: async (args, ctx: AgentContext) => {
    logger.log(
      `[${args.action}] reasoning: ${args.reasoning.slice(0, 120)}...`,
    );

    switch (args.action) {
      // ────────────────────────────────────────────────────────────────────
      // QUESTIONNAIRE
      // ────────────────────────────────────────────────────────────────────
      case "questionnaire": {
        if (!args.questions || args.questions.length === 0) {
          throw new DyadError(
            "The 'questions' array is required and must not be empty for the questionnaire action.",
            DyadErrorKind.Precondition,
          );
        }

        const questions = args.questions.map((q) => ({
          ...q,
          id: q.id || `q_${crypto.randomUUID().slice(0, 8)}`,
        }));

        const requestId = userInputRegistry.request({
          kind: "questionnaire",
          chatId: ctx.chatId,
          questions,
          classifier: "none",
        });

        logger.log(
          `Presenting questionnaire (${questions.length} questions), requestId: ${requestId}`,
        );

        const result = await userInputRegistry.park(requestId, ctx.abortSignal);
        const answers =
          result?.kind === "questionnaire" ? result.answers : null;

        if (!answers) {
          return "The user dismissed the questionnaire without answering. Ask them how they'd like to proceed, or try asking questions in regular chat text.";
        }

        const formattedAnswers = questions
          .map((q) => {
            const answer = answers[q.id] || "(no answer)";
            return `**${q.question}**\n${answer}`;
          })
          .join("\n\n");

        const qaEntries = questions
          .map((q) => {
            const answer = answers[q.id] || "(no answer)";
            return `<qa question="${escapeXmlAttr(q.question)}" type="${escapeXmlAttr(q.type)}">${escapeXmlContent(answer)}</qa>`;
          })
          .join("\n");

        ctx.onXmlComplete(
          `<dyad-questionnaire count="${questions.length}">\n${qaEntries}\n</dyad-questionnaire>`,
        );

        return `User responses:\n\n${formattedAnswers}`;
      }

      // ────────────────────────────────────────────────────────────────────
      // WRITE PLAN
      // ────────────────────────────────────────────────────────────────────
      case "write_plan": {
        if (!args.title || !args.summary || !args.plan) {
          throw new DyadError(
            "The 'title', 'summary', and 'plan' fields are all required for the write_plan action.",
            DyadErrorKind.Precondition,
          );
        }

        logger.log(`Writing plan: ${args.title}`);
        rememberPlanDraft(ctx.chatId, {
          title: args.title,
          summary: args.summary,
          content: args.plan,
        });

        broadcastToRegisteredWindows(ctx.event.sender, "plan:update", {
          chatId: ctx.chatId,
          title: args.title,
          summary: args.summary,
          plan: args.plan,
        });

        try {
          await savePlanToDisk({
            appPath: ctx.appPath,
            chatId: ctx.chatId,
            title: args.title,
            summary: args.summary,
            content: args.plan,
            status: "draft",
          });
        } catch (error) {
          logger.warn("Failed to persist plan draft", error);
        }

        return `Implementation plan "${args.title}" has been presented to the user. They can review it in the preview panel and either accept it or request changes.`;
      }

      // ────────────────────────────────────────────────────────────────────
      // EXIT PLAN
      // ────────────────────────────────────────────────────────────────────
      case "exit_plan": {
        if (!args.confirmation) {
          throw new DyadError(
            "User must confirm the plan (confirmation: true) before exiting plan mode.",
            DyadErrorKind.Precondition,
          );
        }

        logger.log("Exiting plan mode, transitioning to implementation");

        try {
          await db
            .update(apps)
            .set({ needsAppBlueprint: false })
            .where(eq(apps.id, ctx.appId));
        } catch (error) {
          logger.warn(
            `Failed to clear needsAppBlueprint for app ${ctx.appId} on plan exit`,
            error,
          );
        }

        await startPlanHandoffFromMain({
          sourceChatId: ctx.chatId,
          appId: ctx.appId,
          appPath: ctx.appPath,
          acceptInNewChat: ctx.planAcceptInNewChat ?? false,
          senderWebContentsId: ctx.event.sender.id,
        });

        safeSend(ctx.event.sender, "plan:exit", {
          chatId: ctx.chatId,
          appId: ctx.appId,
        });

        return "Plan accepted. Switching to Agent mode to begin implementation. The agreed plan will guide the implementation process.";
      }
    }
  },
};
