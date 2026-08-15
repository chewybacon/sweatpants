/**
 * Durable chat transport ingress.
 *
 * The public request is the strict native Sweatpants command/reconnect
 * envelope. This module validates that boundary once, converts only the one
 * admitted send-message user value through Chat Core's codec, and leaves no
 * transcript-bearing compatibility reader behind.
 */
import { EventType } from "@ag-ui/core";
import { z } from "zod";
import { CrankError } from "@sweatpants/durable-execution";
import {
  assertJson,
  failure,
  parser,
  success,
  type ParseResult,
  type Parser,
} from "@sweatpants/foundation";
import {
  agUiMessagesToChatHistoryEntries,
  decodeAGUIEvent,
  type ConversationCommand,
  type ResumeEntry,
} from "@sweatpants/chat-core";
import type { StreamOptions } from "@sweatpants/model-provider";
import type { ChatRequestBody, ElicitResponse } from "./chat-types.ts";
import type { OpenInterruptRecord } from "../interrupts/index.ts";

const MAX_REQUEST_CONTEXT_ENTRIES = 1_024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const jsonValueSchema = z.json();
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

/** Sweatpants-owned native command request. */
const chatCommandRequestSchema = z
  .object({
    command: conversationCommandSchema,
    clientId: z.string().min(1).max(512),
    conversationId: z.string().min(1).max(512),
    knownWindowToken: z
      .string()
      .min(1)
      .max(128 * 1024)
      .optional(),
    userMessage: z.unknown().optional(),
    runId: z.string().min(1).max(512).optional(),
    parentRunId: z.string().min(1).max(512).optional(),
    state: jsonValueSchema.optional(),
    context: z
      .array(z.object({ description: z.string(), value: z.string() }).strict())
      .max(MAX_REQUEST_CONTEXT_ENTRIES)
      .optional(),
    forwardedProps: jsonValueSchema.optional(),
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
  })
  .strict();

const chatReconnectRequestSchema = z
  .object({
    clientId: z.string().min(1).max(512),
    conversationId: z.string().min(1).max(512),
    knownWindowToken: z
      .string()
      .min(1)
      .max(128 * 1024)
      .optional(),
  })
  .strict();

const chatTransportRequestSchema = z.union([chatCommandRequestSchema, chatReconnectRequestSchema]);

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

/** Result-oriented ingress parser for one complete durable Chat request. */
export const chatRequestBodyParser: Parser<ChatRequestBody> =
  chatTransportRequestStructureParser.andThen(normalizeChatRequestBody);

function normalizeChatRequestBody(
  controls: z.output<typeof chatTransportRequestSchema>,
): ParseResult<ChatRequestBody> {
  try {
    if (!("command" in controls)) {
      return success({
        clientId: controls.clientId,
        conversationId: controls.conversationId,
        threadId: controls.conversationId,
        ...(controls.knownWindowToken === undefined
          ? {}
          : { knownWindowToken: controls.knownWindowToken }),
        messages: [],
        state: {},
        tools: [],
        context: [],
        forwardedProps: {},
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
    const commandElicitResponses: ElicitResponse[] =
      command.type === "respond-to-elicit"
        ? [
            {
              sessionId: command.executionId,
              elicitId: command.interruptId,
              completion:
                command.status === "cancelled"
                  ? { action: "cancel" }
                  : mapResolvedResumePayload(command.payload),
            },
          ]
        : [];
    const messages = (() => {
      if (command.type === "send-message") {
        if (controls.userMessage === undefined) {
          throw new Error("send-message requires userMessage");
        }
        const snapshot = decodeAGUIEvent({
          type: EventType.MESSAGES_SNAPSHOT,
          messages: [controls.userMessage],
        });
        if (
          snapshot.type !== EventType.MESSAGES_SNAPSHOT ||
          snapshot.messages.length !== 1 ||
          snapshot.messages[0]?.role !== "user" ||
          snapshot.messages[0].id !== command.messageId
        ) {
          throw new Error("send-message userMessage must be the matching user message");
        }
        return agUiMessagesToChatHistoryEntries([snapshot.messages[0]]);
      }
      if (controls.userMessage !== undefined) {
        throw new Error(`${command.type} must not carry userMessage`);
      }
      return [];
    })();
    const streamOptions = decodeStreamOptions(controls.streamOptions);
    const pluginAbort =
      command.type === "interrupt-turn"
        ? { reason: command.reason, commandId: command.commandId }
        : undefined;
    return success({
      command,
      ...(controls.knownWindowToken === undefined
        ? {}
        : { knownWindowToken: controls.knownWindowToken }),
      clientId: controls.clientId,
      conversationId: controls.conversationId,
      messageId: command.commandId,
      threadId: controls.conversationId,
      ...(controls.runId === undefined ? {} : { runId: controls.runId }),
      ...(controls.parentRunId === undefined ? {} : { parentRunId: controls.parentRunId }),
      state: controls.state ?? {},
      tools: [],
      context: controls.context ?? [],
      forwardedProps: controls.forwardedProps ?? {},
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
      ...(commandElicitResponses.length === 0 ? {} : { elicitResponses: commandElicitResponses }),
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
