import { call, run } from "effection";
import { describe, expect, it } from "vitest";
import { createChatSession } from "../create-session.ts";
import type { Message, Streamer } from "../../index.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("chat session command buffering", () => {
  it("does not drop a send dispatched immediately after session creation", async () => {
    const received = deferred<Message[]>();
    const streamer: Streamer = function* (messages) {
      received.resolve(messages);
      return { type: "complete", text: "" };
    };

    const messages = await run(function* () {
      const session = yield* createChatSession({ streamer });
      session.dispatch({ type: "send", content: "queued during mount" });
      return yield* call(() => received.promise);
    });

    expect(messages.at(-1)).toMatchObject({
      role: "user",
      content: "queued during mount",
    });
  });
});
