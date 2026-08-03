/**
 * Durable chat request normalization.
 *
 * Converts loosely-shaped incoming JSON into the canonical `ChatRequestBody`
 * message forms, and maps public AG-UI resume entries onto internal elicit
 * responses. Pure functions; no I/O, no contexts.
 */
import { z } from "zod";
import { CrankError } from "@sweatpants/durable-execution";
import { safeSchemaIssues } from "@sweatpants/foundation/schema-validation";
import type { ChatRequestBody, ElicitResponse } from "./chat-types.ts";
import type { Json } from "@sweatpants/foundation";
import type { OpenInterruptRecord } from "../interrupts/index.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Clients may replay tool arguments either decoded or as the provider's JSON
 * string. Decoding the string is this ingress's job; judging the decoded shape
 * belongs to the authored tool at `execute`, so undecodable text survives.
 */
function parseToolArguments(value: Json | string): Json {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value) as Json;
  } catch {
    return value;
  }
}

function normalizeIncomingMessages(
  messages: readonly z.infer<typeof rawMessageSchema>[],
): ChatRequestBody["messages"] {
  const normalized: ChatRequestBody["messages"] = [];
  const toolNames = new Map<string, string>();
  for (const message of messages) {
    for (const toolCall of message.tool_calls ?? message.toolCalls ?? []) {
      toolNames.set(toolCall.id, toolCall.function.name);
    }
  }

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;
    const role = message.role;
    const id = message.id && message.id.length > 0 ? message.id : `${role}:${index}`;
    const content =
      typeof message.content === "string"
        ? message.content
        : message.content === undefined
          ? ""
          : JSON.stringify(message.content);

    if (role === "assistant") {
      const toolCalls = message.tool_calls ?? message.toolCalls ?? [];
      normalized.push({
        id,
        role: "assistant" as const,
        content,
        ...(toolCalls.length > 0
          ? {
              tool_calls: toolCalls.map((toolCall) => ({
                id: toolCall.id,
                type: "function" as const,
                function: {
                  name: toolCall.function.name,
                  arguments: parseToolArguments(toolCall.function.arguments),
                },
              })),
            }
          : {}),
      });
      continue;
    }

    if (role === "tool") {
      const toolCallId = message["tool_call_id"] ?? message["toolCallId"];
      const toolName = message["name"] ?? (toolCallId ? toolNames.get(toolCallId) : undefined);
      const isError = message["isError"] ?? message["error"] !== undefined;
      if (!toolCallId || !toolName) {
        throw new Error("Parsed tool message is missing settled result facts");
      }
      normalized.push({
        id,
        role: "tool" as const,
        content,
        tool_call_id: toolCallId,
        name: toolName,
        isError,
      });
      continue;
    }

    if (role === "activity") {
      const activityType =
        typeof message["activityType"] === "string"
          ? message["activityType"]
          : "sweatpants:activity";
      normalized.push({ id, role: "activity" as const, activityType, content });
      continue;
    }

    if (role === "developer") {
      normalized.push({ id, role: "developer" as const, content });
    } else if (role === "system") {
      normalized.push({ id, role: "system" as const, content });
    } else if (role === "reasoning") {
      normalized.push({ id, role: "reasoning" as const, content });
    } else if (role === "user") {
      normalized.push({ id, role: "user" as const, content });
    }
  }

  return normalized;
}

const jsonValueSchema = z.json();
const rawToolCallSchema = z
  .object({
    id: z.string().min(1).max(512),
    type: z.literal("function"),
    function: z
      .object({
        name: z.string().min(1).max(512),
        arguments: z.union([
          z.record(z.string(), jsonValueSchema),
          z
            .string()
            .max(256 * 1024)
            .refine((text) => {
              try {
                const parsed: unknown = JSON.parse(text);
                return isRecord(parsed);
              } catch {
                return false;
              }
            }),
        ]),
      })
      .strict(),
  })
  .strict();
const rawMessageSchema = z
  .object({
    id: z.string().max(512).optional(),
    role: z.enum(["assistant", "tool", "activity", "developer", "system", "reasoning", "user"]),
    content: jsonValueSchema.optional(),
    partial: z.boolean().optional(),
    tool_calls: z.array(rawToolCallSchema).max(128).optional(),
    toolCalls: z.array(rawToolCallSchema).max(128).optional(),
    tool_call_id: z.string().max(512).optional(),
    toolCallId: z.string().max(512).optional(),
    name: z.string().max(512).optional(),
    isError: z.boolean().optional(),
    error: z.string().max(16_384).optional(),
    activityType: z.string().max(512).optional(),
  })
  .strict()
  .superRefine((message, context) => {
    if (
      message.role === "tool" &&
      !(
        (typeof message.tool_call_id === "string" && message.tool_call_id.length > 0) ||
        (typeof message.toolCallId === "string" && message.toolCallId.length > 0)
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["tool_call_id"],
        message: "tool messages require a non-empty tool call id",
      });
    }
    if (message.role === "tool" && !(typeof message.name === "string" && message.name.length > 0)) {
      context.addIssue({
        code: "custom",
        path: ["name"],
        message: "tool messages require a settled tool name",
      });
    }
    if (message.role === "tool" && message.isError === undefined) {
      context.addIssue({
        code: "custom",
        path: ["isError"],
        message: "tool messages require explicit failure state",
      });
    }
    if (
      message.role === "activity" &&
      !(typeof message.activityType === "string" && message.activityType.length > 0)
    ) {
      context.addIssue({
        code: "custom",
        path: ["activityType"],
        message: "activity messages require an activity type",
      });
    }
  });
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
    env: z.record(z.string(), z.string().nullable()).optional(),
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
const chatRequestBodySchema = z
  .object({
    trigger: z.enum(["submit-message", "regenerate-message", "cancel-run"]).optional(),
    clientId: z.string().max(512).optional(),
    messageId: z.string().max(512).optional(),
    conversationId: z.string().max(512).optional(),
    threadId: z.string().max(512).optional(),
    runId: z.string().max(512).optional(),
    parentRunId: z.string().max(512).optional(),
    state: jsonValueSchema.optional(),
    tools: z.array(jsonValueSchema).max(256).optional(),
    context: z
      .array(
        z.object({ description: z.string().max(16_384), value: z.string().max(16_384) }).strict(),
      )
      .max(256)
      .optional(),
    forwardedProps: jsonValueSchema.optional(),
    resume: z.array(resumeEntrySchema).max(256).optional(),
    messages: z.array(rawMessageSchema).max(256),
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
    enabledTools: z.union([z.boolean(), z.array(z.string().max(512)).max(256)]).optional(),
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

export function parseChatRequestBody(value: unknown): ChatRequestBody {
  try {
    const parsed = chatRequestBodySchema.parse(value);
    // SAFETY: Zod has already proved every field and nested value. The cast only
    // removes Zod's `undefined` markers from optional properties under
    // `exactOptionalPropertyTypes`; no external value crosses this boundary.
    return {
      ...parsed,
      messages: normalizeIncomingMessages(parsed.messages),
    } as unknown as ChatRequestBody;
  } catch (error) {
    const message =
      error instanceof z.ZodError
        ? `Chat request shape is invalid: ${safeSchemaIssues(error.issues)
            .map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message))
            .join("; ")}`
        : "Chat request could not be parsed";
    throw new CrankError("invalid_chat_request", message);
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
    const response: ElicitResponse = {
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
    };
    mapped.push(response);
  }

  return mapped;
}
