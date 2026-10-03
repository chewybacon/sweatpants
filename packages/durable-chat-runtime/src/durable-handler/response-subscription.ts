import { EventType } from "@ag-ui/core";
import {
  ConversationSegmentValidator,
  type ConversationStreamEvent as StreamEvent,
} from "@sweatpants/chat-core";
import { createPullStream } from "@sweatpants/durable-streams";
import { stableTupleHash } from "@sweatpants/foundation";
import { ensure, resource, type Operation, type Stream, type Subscription } from "effection";
import type { SessionHandle, SessionRegistry } from "../response-streams/index.ts";

let responseWriterEpoch = 1;

export function* directChatSubscription(
  registry: SessionRegistry<StreamEvent>,
  session: SessionHandle<StreamEvent>,
  prefix: readonly StreamEvent[] = [],
  startLSN = 0,
): Operation<Subscription<string, void>> {
  const validator = new ConversationSegmentValidator();
  let prefixIndex = 0;
  let finished = false;
  const stream: Stream<string, void> = resource(function* (provide) {
    // The response subscription owns the registry reference. This is the
    // stream-scoped equivalent of Cordis Fiber.effect(): acquire happens
    // before this resource is returned, and release is guaranteed when the
    // response scope is destroyed, including client cancellation and setup
    // failure after acquisition.
    yield* ensure(() => registry.release(session.id));
    const subscription = yield* createPullStream(session.buffer, startLSN);
    yield* provide({
      *next(): Operation<IteratorResult<string, void>> {
        const next =
          prefixIndex < prefix.length
            ? { done: false as const, value: { token: prefix[prefixIndex++]!, lsn: 0 } }
            : yield* subscription.next();
        if (next.done) {
          if (!finished) {
            validator.finish();
          }
          return { done: true, value: undefined };
        }
        const event = next.value.token;
        validator.push(event);
        if (event.type === EventType.RUN_FINISHED || event.type === EventType.RUN_ERROR) {
          validator.finish();
          finished = true;
        }
        return { done: false, value: JSON.stringify(event) };
      },
    });
  });
  return yield* stream;
}

export function nextResponseWriterFence(sessionId: string): {
  ownerId: string;
  activationEpoch: number;
} {
  // Millisecond clock space leaves room for process-local activations while
  // remaining below Number.MAX_SAFE_INTEGER. The buffer itself rejects stale
  // competing claims.
  responseWriterEpoch = Math.max(responseWriterEpoch + 1, Date.now() * 1_000);
  return {
    ownerId: stableTupleHash(["response-writer", process.pid, sessionId, responseWriterEpoch]),
    activationEpoch: responseWriterEpoch,
  };
}
