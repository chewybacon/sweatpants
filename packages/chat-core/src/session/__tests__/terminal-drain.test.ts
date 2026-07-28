import { describe, expect, it } from "vitest";
import { createChannel, each, run, sleep, spawn, type Operation } from "effection";
import type { ChatStateEvent } from "../../state/events.ts";
import { createChatSession } from "../create-session.ts";
import { useTransformPipeline } from "../transforms.ts";
import type { ChatEventTransform, Streamer } from "../options.ts";

const delayedTerminal: ChatEventTransform = function* (input, output): Operation<void> {
  for (const event of yield* each(input)) {
    if (event.type === "RUN_FINISHED") {
      yield* sleep(20);
    }
    yield* output.send(event);
    yield* each.next();
  }
};

describe("AG-UI terminal draining", () => {
  it("close waits for transforms to forward the terminal event", async () => {
    const seen: ChatStateEvent[] = [];
    await run(function* () {
      const output = createChannel<ChatStateEvent, void>();
      yield* spawn(function* () {
        for (const event of yield* each(output)) {
          seen.push(event);
          yield* each.next();
        }
      });
      const input = yield* useTransformPipeline(output, [delayedTerminal]);
      yield* input.send({ type: "RUN_STARTED", threadId: "thread", runId: "run" });
      yield* input.send({ type: "RUN_FINISHED", threadId: "thread", runId: "run" });
      yield* input.close();
      expect(seen.at(-1)?.type).toBe("RUN_FINISHED");
    });
  });

  it("reports a custom streamer that returns without a terminal event without killing the session owner", async () => {
    const noTerminal: Streamer = function* () {
      return { type: "complete", text: "" };
    };
    let requestError: unknown;
    const task = run(function* () {
      const session = yield* createChatSession({
        streamer: noTerminal,
        onRequestError(error) {
          requestError = error;
        },
      });
      yield* sleep(0);
      session.dispatch({ type: "send", content: "hello" });
      for (const state of yield* each(session.state)) {
        if (state.error) {
          return state.error;
        }
        yield* each.next();
      }
      return "state stream closed without an error";
    });

    await expect(
      Promise.race([
        task,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("custom streamer deadlocked")), 500),
        ),
      ]),
    ).resolves.toBe("Streamer returned without a terminal AG-UI event");
    expect(requestError).toBeInstanceOf(Error);
    expect((requestError as Error).message).toBe(
      "Streamer returned without a terminal AG-UI event",
    );
  });
});
