import { describe, expect, it } from "vitest";
import { run } from "effection";
import { decodeAGUIEvent, parseChatResponseStream } from "./index.ts";

function readable(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
      } else {
        controller.enqueue(encoder.encode(chunks[index++]));
      }
    },
  });
}

describe("headless transport ingress", () => {
  it("parses split direct NDJSON values and validates activity content", async () => {
    const body = readable([
      '{"type":"RUN_STARTED","threadId":"t","runId":"r"}\n{"type":"ACTIVITY_SNAPSHOT","messageId":"a","activityType":"sweatpants:public-execution","content":{"version":1,"node":{"nodeId":"n","parentNodeId":null,"sequence":0,"kind":"activity","state":"running","presentation":"opaque","publicData":{"kind":"activity","activityType":"opaque-execution"}}}}',
      "\n",
    ]);
    const events = await run(function* () {
      const subscription = yield* parseChatResponseStream(body, new AbortController().signal);
      const values: unknown[] = [];
      let next = yield* subscription.next();
      while (!next.done) {
        values.push(next.value);
        next = yield* subscription.next();
      }
      return values;
    });
    expect(events.map((event) => (event as { type: string }).type)).toEqual([
      "RUN_STARTED",
      "ACTIVITY_SNAPSHOT",
    ]);
  });

  it("rejects custom host-tree events and forbidden patch paths", () => {
    expect(() => decodeAGUIEvent({ type: "HOST_TREE_DELTA", delta: {} })).toThrow(
      /chat_event_invalid/,
    );
    expect(() =>
      decodeAGUIEvent({
        type: "ACTIVITY_DELTA",
        messageId: "a",
        activityType: "sweatpants:public-execution",
        patch: [{ op: "replace", path: "/node/parentNodeId", value: null }],
      }),
    ).toThrow(/chat_activity_patch_invalid/);
  });

  it("fails on an unterminated NDJSON frame", async () => {
    await expect(
      run(function* () {
        const subscription = yield* parseChatResponseStream(
          readable(['{"type":"RUN_STARTED","threadId":"t","runId":"r"}']),
          new AbortController().signal,
        );
        yield* subscription.next();
      }),
    ).rejects.toThrow(/chat_transport_truncated/);
  });
});
