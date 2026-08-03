import { EventType } from "@ag-ui/core";
import { describe, expect, it } from "vitest";
import { withTestScenario } from "@sweatpants/test-rig";
import { ACCEPTANCE_MODEL_ID, createAcceptanceApplication } from "./lib/acceptance-app.ts";

describe("HTTP response-stream reconnect", () => {
  it("replays only unseen deltas and does not rerun the model request", async () => {
    await withTestScenario(
      {
        binding: "http",
        modelId: ACCEPTANCE_MODEL_ID,
        createApplication(context) {
          return createAcceptanceApplication(context, undefined, { retainResponseStreams: true });
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
        const first = yield* stream.event("TEXT_MESSAGE_CONTENT", (event) => {
          expect(event["delta"]).toBe("RECONNECT_FIRST_V1");
        });
        const checkpoint = stream.checkpoint();
        expect(checkpoint.offset).toBe(first.lsn);
        yield* stream.disconnect();

        yield* response.finish();
        const resumed = yield* s.streams.reconnect(checkpoint);
        const frames = yield* resumed.complete();
        const deltas = frames
          .filter((frame) => frame.event.type === EventType.TEXT_MESSAGE_CONTENT)
          .map((frame) => frame.event["delta"]);
        expect(deltas).toEqual(["RECONNECT_SECOND_V1"]);
        expect(frames.at(-1)?.event.type).toBe(EventType.RUN_FINISHED);
        expect(s.model.requests()).toHaveLength(1);
      },
    );
  }, 30_000);
});
