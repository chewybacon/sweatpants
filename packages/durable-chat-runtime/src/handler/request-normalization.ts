/**
 * Durable chat transport ingress.
 *
 * The public request is a Sweatpants control envelope around AG-UI's owned
 * `RunAgentInput`. This module validates that boundary once, converts AG-UI
 * messages through Chat Core's codec, and leaves no compatibility message or
 * tool-call readers behind.
 */
import { RunAgentInputSchema, type RunAgentInput } from "@ag-ui/core";
import { z } from "zod";
import { CrankError } from "@sweatpants/durable-execution";
import { safeSchemaIssues } from "@sweatpants/foundation/schema-validation";
import { assertJson } from "@sweatpants/foundation";
import { agUiMessagesToChatHistoryEntries } from "@sweatpants/chat-core/ag-ui";
import type { ResumeEntry } from "@sweatpants/chat-core";
import type { StreamOptions } from "@sweatpants/model-provider";
import type { ChatRequestBody, ElicitResponse } from "./chat-types.ts";
import type { OpenInterruptRecord } from "../interrupts/index.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reject deleted OpenAI-compatible spellings before AG-UI's permissive parser can strip them. */
function rejectLegacyMessageFields(
  value: unknown,
  path = "$.input",
  seen = new WeakSet<object>(),
): void {
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectLegacyMessageFields(item, `${path}[${index}]`, seen));
    return;
  }
  const record = value as Record<string, unknown>;
  for (const key of ["tool_calls", "tool_call_id"]) {
    if (Object.prototype.hasOwnProperty.call(record, key)) {
      throw new Error(`${path}.${key} is a removed compatibility field`);
    }
  }
  for (const [key, item] of Object.entries(record)) {
    rejectLegacyMessageFields(item, `${path}.${key}`, seen);
  }
}

const jsonValueSchema = z.json();
const resumeEntrySchema = z
  .object({
    interruptId: z.string().min(1).max(512),
    status: z.enum(["resolved", "cancelled"]),
    payload: jsonValueSchema.optional(),
  })
  .strict();
const elicitResponseSchema = z
  .object({
    sessionId: z.string().min(1).max(512),
    callId: z.string().min(1).max(512),
    toolName: z.string().max(512).optional(),
    elicitId: z.string().min(1).max(512),
    completion: z
      .object({
        action: z.enum(["accept", "decline", "cancel"]),
        content: jsonValueSchema.optional(),
        reason: z.string().max(2048).optional(),
      })
      .strict(),
    ref: z
      .object({
        runtimeId: z.string().min(1).max(512),
        executionId: z.string().min(1).max(512),
        callId: z.string().min(1).max(512),
        toolName: z.string().max(512),
        sessionId: z.string().max(512).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
const streamOptionsSchema = z
  .object({
    apiKey: z.string().max(4_096).nullable().optional(),
    env: z.record(z.string(), z.string()).optional(),
    sessionId: z.string().max(512).optional(),
    toolChoice: z.enum(["auto", "none", "required"]).optional(),
    maxTokens: z.number().int().positive().max(16_000).optional(),
    temperature: z.number().finite().min(0).max(2).optional(),
    topP: z.number().finite().min(0).max(1).optional(),
    topK: z.number().int().positive().max(100_000).optional(),
    thinking: z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]).optional(),
    thinkingBudgets: z
      .object({
        minimal: z.number().int().positive().max(16_000).optional(),
        low: z.number().int().positive().max(16_000).optional(),
        medium: z.number().int().positive().max(16_000).optional(),
        high: z.number().int().positive().max(16_000).optional(),
      })
      .strict()
      .optional(),
    responseFormat: z
      .object({
        type: z.literal("json_schema"),
        name: z.string().max(512).optional(),
        schema: z.record(z.string(), jsonValueSchema),
      })
      .strict()
      .optional(),
    providerOptions: z.record(z.string(), jsonValueSchema).optional(),
  })
  .strict();

/** Sweatpants-owned controls; `input` remains AG-UI's owned RunAgentInput. */
const chatTransportRequestSchema = z
  .object({
    input: z.unknown(),
    trigger: z.enum(["submit-message", "regenerate-message", "cancel-run"]).optional(),
    clientId: z.string().max(512).optional(),
    conversationId: z.string().max(512).optional(),
    messageId: z.string().max(512).optional(),
    systemPrompt: z
      .string()
      .max(64 * 1024)
      .optional(),
    persona: z.string().max(512).optional(),
    personaConfig: jsonValueSchema.optional(),
    enableOptionalTools: z.array(z.string().max(512)).max(256).optional(),
    effort: z.string().max(512).optional(),
    streamOptions: streamOptionsSchema.optional(),
    initialToolChoice: z.enum(["auto", "none", "required"]).optional(),
    model: z
      .object({ provider: z.string().min(1).max(512), id: z.string().min(1).max(512) })
      .strict()
      .optional(),
    elicitResponses: z.array(elicitResponseSchema).max(256).optional(),
    pluginAbort: z
      .object({
        sessionId: z.string().max(512).optional(),
        reason: z.string().max(4_096).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

type DecodedStreamOptions = z.infer<typeof streamOptionsSchema>;

function decodeRunAgentInput(value: unknown): RunAgentInput {
  return RunAgentInputSchema.strict().parse(value);
}

function decodeResumeEntries(value: RunAgentInput["resume"]): ResumeEntry[] | undefined {
  if (value === undefined) return undefined;
  return value.map((entry, index) => {
    const parsed = resumeEntrySchema.parse(entry);
    return {
      interruptId: parsed.interruptId,
      status: parsed.status,
      ...(parsed.payload === undefined
        ? {}
        : { payload: assertJson(parsed.payload, `$.input.resume[${index}].payload`) }),
    };
  });
}

/** Configuration remains optional; this boundary converts the validated DTO once. */
function decodeStreamOptions(value: DecodedStreamOptions | undefined): StreamOptions | undefined {
  if (value === undefined) return undefined;
  const thinkingBudgets = value.thinkingBudgets;
  const responseFormat = value.responseFormat;
  return {
    ...(value.apiKey === undefined ? {} : { apiKey: value.apiKey }),
    ...(value.env === undefined ? {} : { env: value.env }),
    ...(value.sessionId === undefined ? {} : { sessionId: value.sessionId }),
    ...(value.toolChoice === undefined ? {} : { toolChoice: value.toolChoice }),
    ...(value.maxTokens === undefined ? {} : { maxTokens: value.maxTokens }),
    ...(value.temperature === undefined ? {} : { temperature: value.temperature }),
    ...(value.topP === undefined ? {} : { topP: value.topP }),
    ...(value.topK === undefined ? {} : { topK: value.topK }),
    ...(value.thinking === undefined ? {} : { thinking: value.thinking }),
    ...(thinkingBudgets === undefined
      ? {}
      : {
          thinkingBudgets: {
            ...(thinkingBudgets.minimal === undefined ? {} : { minimal: thinkingBudgets.minimal }),
            ...(thinkingBudgets.low === undefined ? {} : { low: thinkingBudgets.low }),
            ...(thinkingBudgets.medium === undefined ? {} : { medium: thinkingBudgets.medium }),
            ...(thinkingBudgets.high === undefined ? {} : { high: thinkingBudgets.high }),
          },
        }),
    ...(responseFormat === undefined
      ? {}
      : {
          responseFormat: {
            type: responseFormat.type,
            schema: responseFormat.schema,
            ...(responseFormat.name === undefined ? {} : { name: responseFormat.name }),
          },
        }),
    ...(value.providerOptions === undefined ? {} : { providerOptions: value.providerOptions }),
  };
}

type DecodedElicitResponse = z.infer<typeof elicitResponseSchema>;

function decodeElicitResponse(value: DecodedElicitResponse, index: number): ElicitResponse {
  const completion = value.completion;
  const completionValue =
    completion.action === "accept"
      ? (() => {
          if (completion.content === undefined) {
            throw new Error(
              `$.elicitResponses[${index}].completion.content is required for accept`,
            );
          }
          return { action: "accept" as const, content: assertJson(completion.content) };
        })()
      : completion.action === "decline"
        ? {
            action: "decline" as const,
            ...(completion.reason === undefined ? {} : { reason: completion.reason }),
          }
        : {
            action: "cancel" as const,
            ...(completion.reason === undefined ? {} : { reason: completion.reason }),
          };
  return {
    sessionId: value.sessionId,
    callId: value.callId,
    ...(value.toolName === undefined ? {} : { toolName: value.toolName }),
    ...(value.ref === undefined
      ? {}
      : {
          ref: {
            runtimeId: value.ref.runtimeId,
            executionId: value.ref.executionId,
            callId: value.ref.callId,
            toolName: value.ref.toolName,
            ...(value.ref.sessionId === undefined ? {} : { sessionId: value.ref.sessionId }),
          },
        }),
    elicitId: value.elicitId,
    completion: completionValue,
  };
}

function decodePluginAbort(
  value: z.infer<typeof chatTransportRequestSchema>["pluginAbort"],
): ChatRequestBody["pluginAbort"] {
  if (value === undefined) return undefined;
  return {
    ...(value.sessionId === undefined ? {} : { sessionId: value.sessionId }),
    ...(value.reason === undefined ? {} : { reason: value.reason }),
  };
}

/**
 * Validates a `ChatTransportRequest` and converts only its AG-UI input through
 * the owner codec before any semantic acceptance, provider work, or writes.
 */
export function parseChatRequestBody(value: unknown): ChatRequestBody {
  try {
    const controls = chatTransportRequestSchema.parse(value);
    rejectLegacyMessageFields(controls.input);
    const input = decodeRunAgentInput(controls.input);
    const resume = decodeResumeEntries(input.resume);
    const messages = agUiMessagesToChatHistoryEntries(input.messages);
    const streamOptions = decodeStreamOptions(controls.streamOptions);
    const pluginAbort = decodePluginAbort(controls.pluginAbort);
    return {
      ...(controls.trigger === undefined ? {} : { trigger: controls.trigger }),
      ...(controls.clientId === undefined ? {} : { clientId: controls.clientId }),
      ...(controls.conversationId === undefined ? {} : { conversationId: controls.conversationId }),
      ...(controls.messageId === undefined ? {} : { messageId: controls.messageId }),
      threadId: input.threadId,
      runId: input.runId,
      ...(input.parentRunId === undefined ? {} : { parentRunId: input.parentRunId }),
      state: input.state,
      tools: input.tools,
      context: input.context,
      forwardedProps: input.forwardedProps,
      ...(resume === undefined ? {} : { resume }),
      messages,
      ...(controls.systemPrompt === undefined ? {} : { systemPrompt: controls.systemPrompt }),
      ...(controls.persona === undefined ? {} : { persona: controls.persona }),
      ...(controls.personaConfig === undefined ? {} : { personaConfig: controls.personaConfig }),
      ...(controls.enableOptionalTools === undefined
        ? {}
        : { enableOptionalTools: controls.enableOptionalTools }),
      ...(controls.effort === undefined ? {} : { effort: controls.effort }),
      ...(streamOptions === undefined ? {} : { streamOptions }),
      ...(controls.initialToolChoice === undefined
        ? {}
        : { initialToolChoice: controls.initialToolChoice }),
      ...(controls.model === undefined ? {} : { model: controls.model }),
      ...(controls.elicitResponses === undefined
        ? {}
        : { elicitResponses: controls.elicitResponses.map(decodeElicitResponse) }),
      ...(pluginAbort === undefined ? {} : { pluginAbort }),
    };
  } catch (error) {
    const message =
      error instanceof z.ZodError
        ? `Chat request shape is invalid: ${safeSchemaIssues(error.issues)
            .map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message))
            .join("; ")}`
        : error instanceof Error
          ? `Chat request could not be parsed: ${error.message}`
          : "Chat request could not be parsed";
    throw new CrankError("invalid_chat_request", message, undefined, { cause: error });
  }
}

function mapResolvedResumePayload(payload: unknown): ElicitResponse["completion"] {
  if (isRecord(payload) && payload["action"] === "accept") {
    return { action: "accept", content: payload["content"] };
  }
  if (isRecord(payload) && payload["action"] === "decline") {
    return { action: "decline" };
  }
  return { action: "accept", content: payload };
}

export function mapResumeEntriesToElicitResponses(
  body: ChatRequestBody,
  records: OpenInterruptRecord[],
  runtimeId: string,
): ElicitResponse[] {
  const resume = body.resume ?? [];
  if (resume.length === 0) return [];

  const recordsByInterruptId = new Map(records.map((record) => [record.interruptId, record]));
  const mapped: ElicitResponse[] = [];

  for (const entry of resume) {
    const record = recordsByInterruptId.get(entry.interruptId);
    if (!record?.toolCallId) continue;
    const completion =
      entry.status === "cancelled"
        ? { action: "cancel" as const }
        : mapResolvedResumePayload(entry.payload);
    const sessionId = record.sessionId ?? record.executionId ?? record.toolCallId;
    mapped.push({
      sessionId,
      callId: record.toolCallId,
      ...(record.toolName
        ? {
            toolName: record.toolName,
            ref: {
              runtimeId: record.runtimeId ?? runtimeId,
              executionId: record.executionId ?? sessionId,
              sessionId,
              callId: record.toolCallId,
              toolName: record.toolName,
            },
          }
        : {}),
      elicitId: entry.interruptId,
      completion,
    });
  }

  return mapped;
}
