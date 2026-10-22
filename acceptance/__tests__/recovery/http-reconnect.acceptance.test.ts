import { EventType } from "@ag-ui/core";
import { call, spawn } from "effection";
import { useClient, waitForSnapshot } from "../../support/client.ts";
import { describe, expect, it } from "vitest";
import { withTestScenario } from "@sweatpants/test-rig";
import { createApplication } from "../../fixtures/application.ts";

describe("HTTP response-stream reconnect", () => {
  it("replays only unseen deltas and does not rerun the model request", async () => {
    await withTestScenario(
      {
        binding: "http",
        createApplication(context) {
          return createApplication(context, { basePath: "/api/chat" });
        },
      },
      function* (s) {
        // Arrange / Act: start a real HTTP response stream.
        const stream = yield* s.streams.openTurn({
          conversationId: "reconnect-acceptance",
          message: "RECONNECT_STREAM_V1",
        });
        const request = yield* s.model.request();
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

it("reconciles a public client after disconnect without duplicating text or sampling again", async () => {
  await withTestScenario({ binding: "http", createApplication }, function* (rig) {
    // Arrange: use the actual client projection as the reconnect boundary.
    const client = yield* useClient(rig, { threadId: "client-reconnect" });
    const sending = yield* spawn(() =>
      call(() =>
        client.sendMessage("Stream across disconnect").then(
          () => null,
          (error: unknown) => error,
        ),
      ),
    );
    const request = yield* rig.model.request();
    const stream = yield* request.respond.textStream(["First", "Second"]);
    yield* stream.releaseNext();
    yield* waitForSnapshot(client, (state) => JSON.stringify(state.messages).includes("First"));

    // Act: cut the HTTP consumer while the server-owned provider request remains live.
    yield* call(() => client.transport.disconnect("acceptance connection loss"));
    const reconnecting = yield* spawn(() => call(() => client.reconnect()));
    yield* stream.finish();
    yield* reconnecting;
    const sendOutcome = yield* sending;
    expect(sendOutcome).toMatchObject({ message: "halted" });
    const ready = yield* waitForSnapshot(client, (state) => state.authority?.state === "idle");

    // Assert: the UI projection contains one complete answer and the model ran once.
    const text = ready.messages
      .filter((message) => message.role === "assistant")
      .flatMap((message) => message.parts)
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
    expect(text).toBe("FirstSecond");
    expect(ready.error).toBeNull();
    expect(rig.model.requests()).toHaveLength(1);
  });
});
