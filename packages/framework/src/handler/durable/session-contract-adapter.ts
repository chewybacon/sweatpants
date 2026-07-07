import type { Operation, Stream } from "effection";

import {
  createInMemorySession,
  type CreateInMemorySessionOptions,
  type InMemorySession,
  type MessageInput,
  type ResolutionMeta,
  type RespondAck,
  type SendAck,
  type Session,
  type WaitKind,
} from "@sweatpants/session-contract";

import type { StreamEvent } from "../../lib/chat/session/streaming.ts";

export interface DurableChatEngineSessionAdapterOptions {
  sessionId: string;
  bufferStore?: CreateInMemorySessionOptions["bufferStore"];
  createEngine(input: MessageInput, context: { sessionId: string }): Operation<Stream<StreamEvent, void>>;
}

/**
 * Phase-1 session-contract adapter for the durable chat engine projection.
 *
 * IMPORTANT: This is a projection sketch, not a full-profile conforming
 * adapter. It records the kernel log beside an engine stream but does NOT
 * integrate with the durable chat engine's interrupt/resume path — `respond()`
 * appends an overlay answer and re-parks without relaying the answer into the
 * engine or continuing the interrupted turn. See REQ-051 (scaffolded).
 *
 * The adapter keeps the public chat/useChat API untouched: callers provide the
 * same durable chat engine stream factory used by the handler, and this layer
 * records the kernel log beside it. Chat events project to inert emissions;
 * AG-UI interrupts project to elicit waits (one wait per interrupt); turn
 * boundaries project to fold checkpoints followed by message waits.
 */
export function* createDurableChatEngineSessionAdapter(
  options: DurableChatEngineSessionAdapterOptions,
): Operation<Session> {
  const session = yield* createInMemorySession({
    sessionId: options.sessionId,
    mode: "fold",
    ...(options.bufferStore !== undefined ? { bufferStore: options.bufferStore } : {}),
  });
  const existing = yield* session.records();
  if (existing.length === 0) {
    yield* session.checkpoint("fold");
    yield* session.emitWait("message", {});
  }
  return wrapDurableChatEngineSession(session, options);
}

function wrapDurableChatEngineSession(
  session: InMemorySession,
  options: DurableChatEngineSessionAdapterOptions,
): Session {
  return {
    id: session.id,
    events: session.events,
    *send(message: MessageInput, opts?: { idempotencyKey?: string }): Operation<SendAck> {
      const ack = yield* session.send(message, opts);
      const engine = yield* options.createEngine(message, { sessionId: session.id });
      const subscription = yield* engine;
      let next = yield* subscription.next();
      while (!next.done) {
        const event = next.value;
        yield* session.emitEmission({ protocol: "ag-ui", event });
        if (event.type === "RUN_ERROR") {
          yield* session.terminal("error", { code: event.code ?? "session_lost", message: event.message });
          return ack;
        }
        if (event.type === "RUN_FINISHED") {
          if (event.outcome?.type === "interrupt" && event.outcome.interrupts.length > 0) {
            for (const interrupt of event.outcome.interrupts) {
              yield* session.emitWait(
                "elicit",
                {
                  key: interrupt.id,
                  message: interrupt.message ?? interrupt.reason,
                  responseSchema: interrupt.responseSchema ?? {},
                  ...(interrupt.metadata !== undefined ? { context: sanitizeMetadata(interrupt.metadata) } : {}),
                },
                interrupt.expiresAt !== undefined ? { expiresAt: interrupt.expiresAt } : undefined,
              );
            }
            return ack;
          }
          yield* session.checkpoint("fold");
          yield* session.emitWait("message", {});
          return ack;
        }
        next = yield* subscription.next();
      }
      yield* session.checkpoint("fold");
      yield* session.emitWait("message", {});
      return ack;
    },
    *respond(waitToken: string, payload: unknown, opts?: { idempotencyKey?: string; wait?: WaitKind; resolution?: ResolutionMeta }): Operation<RespondAck> {
      const ack = yield* session.respond(waitToken, payload, opts);
      // Record a neutral projection emission for the resume overlay. The
      // previous implementation emitted a synthetic AG-UI `RESUME_ACCEPTED`
      // event that does not exist in the protocol; this neutral emission
      // records the resume without impersonating a protocol event.
      yield* session.emitEmission({ protocol: "session-contract", event: { type: "resume_projected", waitToken, payload } });
      yield* session.checkpoint("fold");
      yield* session.emitWait("message", {});
      return ack;
    },
    cancel: session.cancel,
    status: session.status,
  };
}

/**
 * Strip keys that the contract validator recursively rejects as topology
 * fields (sessionId, url, endpoint, …) from adapter-forwarded metadata so
 * that projected elicit waits pass `validateLog`.
 */
const FORBIDDEN_TOPOLOGY_KEYS = new Set([
  "endpoint",
  "url",
  "transport",
  "handle",
  "factory",
  "childSessionId",
  "childWaitSeq",
  "sessionId",
]);

function sanitizeMetadata(value: unknown): unknown {
  if (value == null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeMetadata);
  }
  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_TOPOLOGY_KEYS.has(key)) {
      continue;
    }
    result[key] = sanitizeMetadata(nested);
  }
  return result;
}
