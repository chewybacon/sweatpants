import { resource, run, type Operation, type Stream } from "effection";
import { describe, expect, it } from "vitest";
import type { StreamEvent } from "../../handler/types.ts";
import { createSerializedEventStream } from "../event-stream.ts";

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
    const event: StreamEvent = { type: "RUN_ERROR", message: "test" };
    let advances = 0;

    await run(function* () {
      const stream = createSerializedEventStream(oneEventStream(event, () => advances++));
      const subscription = yield* stream;

      expect(advances).toBe(0);
      expect(yield* subscription.next()).toEqual({ done: false, value: event });
      expect(advances).toBe(1);
    });
  });
});
