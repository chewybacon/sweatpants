import { describe, expect, it } from "vitest";
import { withTestRig } from "@sweatpants/test-rig";
import { ACCEPTANCE_MODEL_ID, createAcceptanceApplication } from "./lib/acceptance-app.ts";

describe("HTTP response-stream reconnect", () => {
  it("replays only unseen deltas and does not rerun the model request", async () => {
    await withTestRig(
      {
        binding: "http",
        modelId: ACCEPTANCE_MODEL_ID,
        createApplication(context) {
          return createAcceptanceApplication(context, undefined, { retainResponseStreams: true });
        },
      },
      async (rig) => {
        const requestPromise = rig.model.expectRequest({ model: ACCEPTANCE_MODEL_ID });
        const streamPromise = rig.streams.openTurn({
          conversationId: "reconnect-acceptance",
          message: "RECONNECT_STREAM_V1",
        });
        const request = await requestPromise;
        const stream = await streamPromise;
        const response = await request.respond.text({
          chunks: ["RECONNECT_FIRST_V1", "RECONNECT_SECOND_V1"],
          release: "manual",
        });

        await response.releaseNext();
        const first = await stream.expectEvent("TEXT_MESSAGE_CONTENT", (event) => {
          expect(event["delta"]).toBe("RECONNECT_FIRST_V1");
        });
        const checkpoint = stream.checkpoint();
        expect(checkpoint.offset).toBe(first.lsn);
        await stream.disconnect();

        await response.finish();
        const resumed = await rig.streams.reconnect(checkpoint);
        const frames = await resumed.complete();
        const deltas = frames
          .filter((frame) => frame.event.type === "TEXT_MESSAGE_CONTENT")
          .map((frame) => frame.event["delta"]);
        expect(deltas).toEqual(["RECONNECT_SECOND_V1"]);
        expect(frames.at(-1)?.event.type).toBe("RUN_FINISHED");
        expect(rig.model.requests()).toHaveLength(1);
      },
    );
  }, 30_000);
});
