import { EventType } from "@ag-ui/core";
import { describe, expect, it } from "vitest";
import { withTestScenario } from "@sweatpants/test-rig";
import {
  ACCEPTANCE_MODEL_ID,
  createDurabilityAcceptanceApplication,
} from "../lib/acceptance-app.ts";

describe("HTTP response-stream reconnect", () => {
  it("replays only unseen deltas and does not rerun the model request", async () => {
    await withTestScenario(
      {
        binding: "http",
        modelId: ACCEPTANCE_MODEL_ID,
        createApplication(context) {
          return createDurabilityAcceptanceApplication(context, undefined, {
            retainResponseStreams: true,
          });
        },
      },
      function* (s) {
        const stream = yield* s.streams.openTurn({
          conversationId: "reconnect-acceptance",
          message: "RECONNECT_STREAM_V1",
        });
        const request = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });
        const response = yield* request.respond.textStream([
          "RECONNECT_FIRST_V1",
          "RECONNECT_SECOND_V1",
        ]);

        yield* response.releaseNext();
        yield* stream.event("TEXT_MESSAGE_CONTENT", (event) => {
          if (event.type !== EventType.TEXT_MESSAGE_CONTENT) {
            throw new Error("Expected text content event");
          }
          expect(event.delta).toBe("RECONNECT_FIRST_V1");
        });
        const checkpoint = stream.checkpoint();
        expect(checkpoint.conversationId).toBe("reconnect-acceptance");
        yield* stream.disconnect();

        // Finishing the provider stream does not await durable turn publication.
        // Observe the still-live segment so completed hydration has a causal barrier.
        const live = yield* s.streams.reconnect(checkpoint);
        const started = yield* live.event("RUN_STARTED");
        expect(started.event).toEqual(
          stream.events.find((frame) => frame.event.type === EventType.RUN_STARTED)?.event,
        );
        yield* response.finish();
        const liveFrames = yield* live.complete();
        expect(liveFrames.at(-1)?.event.type).toBe(EventType.RUN_FINISHED);
        expect(s.model.requests()).toHaveLength(1);

        const resumed = yield* s.streams.reconnect(checkpoint);
        const frames = yield* resumed.complete();
        const serialized = JSON.stringify(frames.map((frame) => frame.event));
        expect(serialized).toContain("RECONNECT_FIRST_V1");
        expect(serialized).toContain("RECONNECT_SECOND_V1");
        expect(frames.some((frame) => frame.event.type === EventType.RUN_STARTED)).toBe(false);
        expect(frames.some((frame) => frame.event.type === EventType.RUN_FINISHED)).toBe(false);
        expect(s.model.requests()).toHaveLength(1);
      },
    );
  }, 30_000);
});
