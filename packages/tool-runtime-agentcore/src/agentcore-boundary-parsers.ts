import { z } from "zod";

import type {
  AgentCoreToolEvent,
  AgentCoreToolRuntimeResponse,
  AgentCoreToolSessionHandle,
} from "./agentcore-types.ts";
import { AGENTCORE_TOOL_SESSION_PROTOCOL_VERSION } from "./agentcore-types.ts";

const boundedString = z.string().min(1).max(2_048);
const timestamp = z.string().datetime({ offset: true });
const statusSchema = z.enum([
  "initializing",
  "running",
  "awaiting_elicit",
  "awaiting_sample",
  "completed",
  "failed",
  "cancelled",
  "orphaned",
]);
const pendingRequestSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("elicit"), elicitId: boundedString }).strict(),
  z.object({ type: z.literal("sample"), sampleId: boundedString }).strict(),
]);

const handleSchema = z
  .object({
    kind: z.literal("agentcore-tool-session"),
    version: z.literal(1),
    protocolVersion: z.literal(AGENTCORE_TOOL_SESSION_PROTOCOL_VERSION),
    sessionId: boundedString,
    toolName: boundedString,
    callId: boundedString.optional(),
    conversationId: boundedString.optional(),
    runtimeProfile: boundedString,
    runtimeArn: boundedString,
    endpointName: boundedString,
    runtimeSessionId: boundedString,
    region: boundedString,
    status: statusSchema,
    pendingRequest: pendingRequestSchema.optional(),
    lastEventLsn: z.number().int().nonnegative().safe(),
    lastRuntimeEventSeq: z.number().int().nonnegative().safe(),
    createdAt: timestamp,
    updatedAt: timestamp,
    expiresAt: timestamp,
    stopRequestedAt: timestamp.optional(),
    stoppedAt: timestamp.optional(),
    metadata: z
      .object({
        tenantId: boundedString.optional(),
        userId: boundedString.optional(),
        toolPackageVersion: boundedString.optional(),
        imageDigest: boundedString.optional(),
        selectedModel: z.object({ provider: boundedString, id: boundedString }).strict().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const eventSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("progress"),
      message: z.string().max(16_384),
      progress: z.number().min(0).max(1).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("log"),
      level: z.enum(["debug", "info", "warn", "error"]),
      message: z.string().max(16_384),
    })
    .strict(),
  z
    .object({
      type: z.literal("elicit_request"),
      elicitId: boundedString,
      key: boundedString,
      message: z.string().max(16_384),
      schema: z.record(z.string(), z.json()),
      context: z.record(z.string(), z.json()).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("sample_request"),
      sampleId: boundedString,
      messages: z.array(z.json()).max(1_024),
      systemPrompt: z
        .string()
        .max(64 * 1_024)
        .optional(),
      maxTokens: z.number().int().positive().safe().optional(),
      modelPreferences: z.record(z.string(), z.json()).optional(),
      tools: z.array(z.json()).max(1_024).optional(),
      toolChoice: z.json().optional(),
      schema: z.record(z.string(), z.json()).optional(),
    })
    .strict(),
  z.object({ type: z.literal("sample_response_queued") }).strict(),
  z.object({ type: z.literal("result"), result: z.json() }).strict(),
  z
    .object({
      type: z.literal("error"),
      name: boundedString,
      message: z.string().max(16_384),
      stack: z
        .string()
        .max(64 * 1_024)
        .optional(),
    })
    .strict(),
  z.object({ type: z.literal("cancelled"), reason: z.string().max(16_384).optional() }).strict(),
]);

const responseSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("tool_event"),
      toolSessionId: boundedString,
      runtimeEventSeq: z.number().int().nonnegative().safe(),
      runtimeEventId: boundedString,
      event: eventSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("session_status"),
      toolSessionId: boundedString,
      status: statusSchema,
      pendingRequest: pendingRequestSchema.optional(),
      lastRuntimeEventSeq: z.number().int().nonnegative().safe(),
    })
    .strict(),
  z.object({ type: z.literal("session_not_found"), toolSessionId: boundedString }).strict(),
  z
    .object({
      type: z.literal("command_duplicate"),
      toolSessionId: boundedString,
      commandId: boundedString,
      originalStatus: z.enum(["accepted", "rejected"]),
    })
    .strict(),
  z
    .object({
      type: z.literal("command_conflict"),
      toolSessionId: boundedString,
      commandId: boundedString,
      message: z.string().max(16_384),
    })
    .strict(),
  z
    .object({
      type: z.literal("protocol_error"),
      message: z.string().max(16_384),
      details: z.json().optional(),
    })
    .strict(),
]);

const dedupRecordSchema = z
  .object({
    runtimeEventId: boundedString,
    event: eventSchema,
    lsn: z.number().int().positive().safe(),
  })
  .strict();

export function parseAgentCoreToolSessionHandle(value: unknown): AgentCoreToolSessionHandle {
  return handleSchema.parse(value) as AgentCoreToolSessionHandle;
}

export function parseAgentCoreToolEvent(value: unknown): AgentCoreToolEvent {
  return eventSchema.parse(value) as AgentCoreToolEvent;
}

export function parseAgentCoreToolRuntimeResponse(value: unknown): AgentCoreToolRuntimeResponse {
  return responseSchema.parse(value) as AgentCoreToolRuntimeResponse;
}

export function parseAgentCoreEventDedupRecord(value: unknown): {
  readonly runtimeEventId: string;
  readonly event: AgentCoreToolEvent;
  readonly lsn: number;
} {
  return dedupRecordSchema.parse(value) as {
    readonly runtimeEventId: string;
    readonly event: AgentCoreToolEvent;
    readonly lsn: number;
  };
}
