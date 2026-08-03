import type { Operation } from "effection";
import type { TokenBufferStore } from "@sweatpants/durable-streams";
import { assertJson } from "@sweatpants/foundation";
import {
  parsePortableSchemaDescriptor,
  type PortableSchemaDescriptor,
} from "@sweatpants/foundation/schema";
import { z } from "zod";

import type { OpenInterruptRecord } from "./registry.ts";

const interruptRecordSchema = z
  .strictObject({
    threadId: z.string().min(1).max(512),
    scopeId: z.string().min(1).max(1_024),
    interruptedRunId: z.string().min(1).max(512),
    interruptId: z.string().min(1).max(512),
    reason: z.string().min(1).max(4_096),
    message: z
      .string()
      .max(64 * 1024)
      .optional(),
    toolCallId: z.string().max(512).optional(),
    toolName: z.string().max(512).optional(),
    sessionId: z.string().max(512).optional(),
    runtimeId: z.string().max(512).optional(),
    executionId: z.string().max(512).optional(),
    continuationRef: z.json().optional(),
    responseSchema: z.record(z.string(), z.json()).optional(),
    bindingId: z.string().max(512).optional(),
    context: z.json().optional(),
    responseContract: z.json().optional(),
    contextContract: z.json().optional(),
    placement: z
      .strictObject({
        nodeId: z.string().max(512),
        parentNodeId: z.string().max(512).nullable(),
        sequence: z.number().int().nonnegative(),
      })
      .optional(),
    publicMetadata: z.record(z.string(), z.json()).optional(),
    createdAt: z.string().min(1).max(128),
    expiresAt: z.string().min(1).max(128).optional(),
    status: z.enum(["open", "resolved", "cancelled", "expired"]),
    resolvedByRunId: z.string().max(512).optional(),
    resolutionHash: z.string().max(4_096).optional(),
  })
  .transform((value): OpenInterruptRecord => {
    const context = value.context === undefined ? undefined : assertJson(value.context);
    const responseContract = optionalPortableDescriptor(value.responseContract);
    const contextContract = optionalPortableDescriptor(value.contextContract);
    return {
      threadId: value.threadId,
      scopeId: value.scopeId,
      interruptedRunId: value.interruptedRunId,
      interruptId: value.interruptId,
      reason: value.reason,
      ...(value.message !== undefined ? { message: value.message } : {}),
      ...(value.toolCallId !== undefined ? { toolCallId: value.toolCallId } : {}),
      ...(value.toolName !== undefined ? { toolName: value.toolName } : {}),
      ...(value.sessionId !== undefined ? { sessionId: value.sessionId } : {}),
      ...(value.runtimeId !== undefined ? { runtimeId: value.runtimeId } : {}),
      ...(value.executionId !== undefined ? { executionId: value.executionId } : {}),
      ...(value.continuationRef !== undefined ? { continuationRef: value.continuationRef } : {}),
      ...(value.responseSchema !== undefined ? { responseSchema: value.responseSchema } : {}),
      ...(value.bindingId !== undefined ? { bindingId: value.bindingId } : {}),
      ...(context !== undefined ? { context } : {}),
      ...(responseContract ? { responseContract } : {}),
      ...(contextContract ? { contextContract } : {}),
      ...(value.placement !== undefined ? { placement: value.placement } : {}),
      ...(value.publicMetadata !== undefined ? { publicMetadata: value.publicMetadata } : {}),
      createdAt: value.createdAt,
      ...(value.expiresAt !== undefined ? { expiresAt: value.expiresAt } : {}),
      status: value.status,
      ...(value.resolvedByRunId !== undefined ? { resolvedByRunId: value.resolvedByRunId } : {}),
      ...(value.resolutionHash !== undefined ? { resolutionHash: value.resolutionHash } : {}),
    };
  });
function optionalPortableDescriptor(value: unknown): PortableSchemaDescriptor | undefined {
  if (value === undefined) {
    return undefined;
  }
  try {
    return parsePortableSchemaDescriptor(value);
  } catch {
    return undefined;
  }
}

const interruptStateSchema = z.array(interruptRecordSchema).max(16_384);

const THREAD_INTERRUPT_PREFIX = "__thread_interrupts__:";

function threadInterruptStoreId(threadId: string): string {
  return `${THREAD_INTERRUPT_PREFIX}${threadId}`;
}

export function* recordThreadInterruptState(
  bufferStore: TokenBufferStore<string>,
  threadId: string,
  records: OpenInterruptRecord[],
): Operation<void> {
  const storeId = threadInterruptStoreId(threadId);
  const existing = yield* bufferStore.get(storeId);
  if (existing) {
    yield* bufferStore.delete(storeId);
  }

  const buffer = yield* bufferStore.create(storeId);
  const writer = yield* buffer.claimWriter({
    ownerId: `thread-interrupts:${threadId}`,
    activationEpoch: 1,
  });
  yield* writer.append([JSON.stringify(records)]);
  yield* writer.complete();
}

export function* readLatestThreadInterruptState(
  bufferStore: TokenBufferStore<string>,
  threadId: string,
): Operation<OpenInterruptRecord[] | null> {
  const storeId = threadInterruptStoreId(threadId);
  const buffer = yield* bufferStore.get(storeId);
  if (!buffer) {
    return null;
  }

  const { tokens } = yield* buffer.read(0);
  const latest = tokens[tokens.length - 1];
  if (!latest) {
    return null;
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(latest);
  } catch {
    throw new Error("Persisted interrupt state is not valid JSON");
  }
  const parsed = interruptStateSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new Error("Persisted interrupt state has invalid structure");
  }
  return parsed.data;
}
