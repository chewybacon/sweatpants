/**
 * Durable chat transport ingress.
 *
 * The public request is a Sweatpants control envelope around AG-UI's owned
 * `RunAgentInput`. This module validates that boundary once, converts AG-UI
 * messages through Chat Core's codec, and leaves no compatibility message or
 * tool-call readers behind.
 */
import { RunAgentInputSchema } from "@ag-ui/core";
import { z } from "zod";
import { CrankError } from "@sweatpants/durable-execution";
import {
  assertJson,
  failure,
  parser,
  success,
  type ParseIssue,
  type ParseResult,
  type Parser,
} from "@sweatpants/foundation";
import { agUiMessagesToChatHistoryEntries } from "@sweatpants/chat-core/ag-ui";
import type { ConversationCommand, ResumeEntry } from "@sweatpants/chat-core";
import type { StreamOptions } from "@sweatpants/model-provider";
import type { ChatRequestBody, ElicitResponse } from "./chat-types.ts";
import type { OpenInterruptRecord } from "../interrupts/index.ts";

const MAX_REQUEST_MESSAGES = 4_096;
const MAX_REQUEST_TOOLS = 1_024;
const MAX_REQUEST_CONTEXT_ENTRIES = 1_024;
const MAX_REQUEST_RESUME_ENTRIES = 256;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reject deleted OpenAI-compatible spellings before AG-UI's permissive parser can strip them. */
function rejectLegacyMessageFields(value: unknown, path = "$.input", seen = new WeakSet()): void {
  if (value === null || typeof value !== "object") {
    return;
  }
  if (seen.has(value)) {
    return;
  }
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
const runAgentInputParser = parser(RunAgentInputSchema.strict());
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
    temperature: z.number().min(0).max(2).optional(),
    topP: z.number().min(0).max(1).optional(),
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

const canonicalUuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const canonicalCounter = /^(0|[1-9]\d*)$/;
const durableCounterSchema = z
  .string()
  .regex(canonicalCounter)
  .refine((value) => BigInt(value) <= 18_446_744_073_709_551_615n, {
    message: "counter exceeds durable 64-bit range",
  });

const commandBaseSchema = {
  commandId: z.string().regex(canonicalUuidV4),
  issuedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive(),
  basisRevision: durableCounterSchema.nullable(),
};

const conversationCommandSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...commandBaseSchema,
      type: z.literal("send-message"),
      messageId: z.string().min(1).max(512),
    })
    .strict(),
  z
    .object({
      ...commandBaseSchema,
      type: z.literal("regenerate"),
      targetMessageId: z.string().min(1).max(512).optional(),
    })
    .strict(),
  z
    .object({
      ...commandBaseSchema,
      type: z.literal("respond-to-elicit"),
      logicalTurnId: z.string().min(1).max(512),
      executionId: z.string().min(1).max(1_024),
      interruptId: z.string().min(1).max(512),
      status: z.enum(["resolved", "cancelled"]),
      payload: jsonValueSchema.optional(),
    })
    .strict(),
  z
    .object({
      ...commandBaseSchema,
      type: z.literal("interrupt-turn"),
      logicalTurnId: z.string().min(1).max(512),
      executionId: z.string().min(1).max(1_024),
      reason: z.string().min(1).max(4_096),
    })
    .strict(),
]);

/** Sweatpants-owned command; `input` remains AG-UI presentation/model input. */
const chatTransportRequestSchema = z
  .object({
    command: conversationCommandSchema,
    input: z.unknown(),
    clientId: z.string().min(1).max(512),
    conversationId: z.string().min(1).max(512),
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
  })
  .strict();

const chatTransportRequestStructureParser = parser(chatTransportRequestSchema);

type DecodedCommand = z.infer<typeof conversationCommandSchema>;
type DecodedStreamOptions = z.infer<typeof streamOptionsSchema>;

function decodeConversationCommand(command: DecodedCommand): ConversationCommand {
  switch (command.type) {
    case "send-message":
    case "interrupt-turn":
      return command;
    case "regenerate":
      return {
        type: command.type,
        commandId: command.commandId,
        issuedAt: command.issuedAt,
        expiresAt: command.expiresAt,
        basisRevision: command.basisRevision,
        ...(command.targetMessageId === undefined
          ? {}
          : { targetMessageId: command.targetMessageId }),
      };
    case "respond-to-elicit":
      return {
        type: command.type,
        commandId: command.commandId,
        issuedAt: command.issuedAt,
        expiresAt: command.expiresAt,
        basisRevision: command.basisRevision,
        logicalTurnId: command.logicalTurnId,
        executionId: command.executionId,
        interruptId: command.interruptId,
        status: command.status,
        ...(command.payload === undefined
          ? {}
          : { payload: assertJson(command.payload, "$.command.payload") }),
      };
  }
}

/** Configuration remains optional; this boundary converts the validated DTO once. */
function decodeStreamOptions(value: DecodedStreamOptions | undefined): StreamOptions | undefined {
  if (value === undefined) {
    return undefined;
  }
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

/** Result-oriented ingress parser for one complete durable Chat request. */
export const chatRequestBodyParser: Parser<ChatRequestBody> =
  chatTransportRequestStructureParser.andThen(normalizeChatRequestBody);

function normalizeChatRequestBody(
  controls: z.output<typeof chatTransportRequestSchema>,
): ParseResult<ChatRequestBody> {
  try {
    rejectLegacyMessageFields(controls.input);
    const bounds = verifyRunAgentInputBounds(controls.input);
    if (!bounds.ok) {
      return bounds;
    }
    const input = runAgentInputParser.parse(controls.input);
    if (!input.ok) {
      return prefixFailure(input.issues, ["input"]);
    }
    if (input.value.resume !== undefined) {
      return failure({
        path: ["input", "resume"],
        message: "resume belongs to the respond-to-elicit command",
        code: "invalid_chat_request",
      });
    }
    const command = decodeConversationCommand(controls.command);
    if (command.expiresAt <= command.issuedAt) {
      return failure({
        path: ["command", "expiresAt"],
        message: "command expiry must be later than issue time",
        code: "invalid_chat_request",
      });
    }
    const resume: ResumeEntry[] | undefined =
      command.type === "respond-to-elicit"
        ? [
            {
              interruptId: command.interruptId,
              status: command.status,
              ...(command.payload === undefined
                ? {}
                : { payload: assertJson(command.payload, "$.command.payload") }),
            },
          ]
        : undefined;
    const messages = agUiMessagesToChatHistoryEntries(input.value.messages);
    const streamOptions = decodeStreamOptions(controls.streamOptions);
    const pluginAbort =
      command.type === "interrupt-turn"
        ? { reason: command.reason, commandId: command.commandId }
        : undefined;
    return success({
      command,
      clientId: controls.clientId,
      conversationId: controls.conversationId,
      messageId: command.commandId,
      threadId: input.value.threadId,
      runId: input.value.runId,
      ...(input.value.parentRunId === undefined ? {} : { parentRunId: input.value.parentRunId }),
      state: input.value.state,
      tools: input.value.tools,
      context: input.value.context,
      forwardedProps: input.value.forwardedProps,
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
    });
  } catch (error) {
    return failure({
      path: [],
      message:
        error instanceof Error
          ? `Chat request could not be parsed: ${error.message}`
          : "Chat request could not be parsed",
      code: "invalid_chat_request",
    });
  }
}

/** Maps ingress parser failure to the durable Chat domain boundary. */
export function parseChatRequestBody(value: unknown): ChatRequestBody {
  const parsed = chatRequestBodyParser.parse(value);
  if (parsed.ok) {
    return parsed.value;
  }
  const issue = parsed.issues[0];
  const message = parsed.issues
    .map((candidate) =>
      candidate.path.length > 0
        ? `${candidate.path.join(".")}: ${candidate.message}`
        : candidate.message,
    )
    .join("; ");
  throw new CrankError(
    "invalid_chat_request",
    issue?.code === "invalid_chat_request"
      ? issue.message
      : `Chat request shape is invalid: ${message || "invalid request"}`,
  );
}

function verifyRunAgentInputBounds(input: unknown): ParseResult<void> {
  if (!isRecord(input)) {
    return success(undefined);
  }
  for (const [path, value, maximum] of [
    [["input", "messages"], input["messages"], MAX_REQUEST_MESSAGES],
    [["input", "tools"], input["tools"], MAX_REQUEST_TOOLS],
    [["input", "context"], input["context"], MAX_REQUEST_CONTEXT_ENTRIES],
    [["input", "resume"], input["resume"], MAX_REQUEST_RESUME_ENTRIES],
  ] as const) {
    if (Array.isArray(value) && value.length > maximum) {
      return failure({ path, message: `entry count exceeds ${maximum}`, code: "too_big" });
    }
  }
  return success(undefined);
}

function prefixFailure<T = never>(
  issues: readonly ParseIssue[],
  prefix: readonly (string | number)[],
): ParseResult<T> {
  return failure(
    issues.map((issue) => ({
      ...issue,
      path: [...prefix, ...issue.path],
    })),
  );
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
  if (resume.length === 0) {
    return [];
  }

  const recordsByInterruptId = new Map(records.map((record) => [record.interruptId, record]));
  const mapped: ElicitResponse[] = [];

  for (const entry of resume) {
    const record = recordsByInterruptId.get(entry.interruptId);
    if (!record?.toolCallId) {
      continue;
    }
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
