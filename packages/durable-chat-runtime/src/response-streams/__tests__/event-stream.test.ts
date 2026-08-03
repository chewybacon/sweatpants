import { EventType } from "@ag-ui/core";
import { resource, run, type Operation, type Stream } from "effection";
import { describe, expect, it } from "vitest";
import type { TokenBufferStore } from "@sweatpants/durable-streams";
import type { StreamEvent } from "../../handler/types.ts";
import { createEmptyChatEngine, createSerializedEventStream } from "../event-stream.ts";

function oneEventStream(event: StreamEvent, onNext: () => void): Stream<StreamEvent, void> {
  return resource(function* (provide) {
    let emitted = false;
    yield* provide({
      *next(): Operation<IteratorResult<StreamEvent, void>> {
        onNext();
        if (emitted) {
          return { done: true, value: undefined };
        }
        emitted = true;
        return { done: false, value: event };
      },
    });
  });
}

describe("serialized Turn event stream", () => {
  it("does not advance the engine until its consumer pulls", async () => {
    const event: StreamEvent = { type: EventType.RUN_ERROR, message: "test" };
    let advances = 0;

    await run(function* () {
      const stream = createSerializedEventStream(oneEventStream(event, () => advances++));
      const subscription = yield* stream;

      expect(advances).toBe(0);
      expect(yield* subscription.next()).toEqual({ done: false, value: event });
      expect(advances).toBe(1);
    });
  });

  it("does not fail a completed stream when checkpoint persistence fails", async () => {
    let observed: unknown;
    const failingStore: TokenBufferStore<string> = {
      *create() {
        throw new Error("planned checkpoint store failure");
      },
      *get() {
        return null;
      },
      *delete() {},
    };

    await run(function* () {
      const stream = createSerializedEventStream(
        createEmptyChatEngine(),
        [{ type: EventType.MESSAGES_SNAPSHOT, messages: [] }],
        {
          conversationId: "conversation-1",
          checkpointStore: failingStore,
          onCheckpointError: (error) => {
            observed = error;
          },
        },
      );
      const subscription = yield* stream;
      expect((yield* subscription.next()).done).toBe(false);
      expect(yield* subscription.next()).toEqual({ done: true, value: undefined });
    });

    expect(observed).toBeInstanceOf(Error);
  });
});
