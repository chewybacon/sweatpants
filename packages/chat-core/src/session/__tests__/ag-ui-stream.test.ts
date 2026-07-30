import { describe, expect, it } from "vitest";
import { createChannel, each, resource, run, spawn, type Channel, type Stream } from "effection";
import type { ChatStateEvent } from "../../state/events.ts";
import { consumeAgUiEventStream } from "../ag-ui-stream.ts";
import type { StreamEvent } from "../streaming.ts";

function frames(events: StreamEvent[]): Stream<unknown, void> {
  return resource(function* (provide) {
    let index = 0;
    yield* provide({
      *next() {
        return index < events.length
          ? { done: false as const, value: { lsn: index + 1, event: events[index++]! } }
          : { done: true as const, value: undefined };
      },
    });
  });
}

function consume(events: StreamEvent[]) {
  return run(function* () {
    const output = createChannel<ChatStateEvent, void>();
    const forwarded: ChatStateEvent[] = [];
    yield* spawn(function* () {
      for (const event of yield* each(output)) {
        forwarded.push(event);
        yield* each.next();
      }
    });
    const result = yield* consumeAgUiEventStream(frames(events), output);
    return { result, forwarded };
  });
}

const correlation = { threadId: "thread", runId: "current" };

describe("AG-UI stream driver", () => {
  it("derives text from the current run rather than snapshot history", async () => {
    const { result } = await consume([
      { type: "RUN_STARTED", ...correlation },
      {
        type: "MESSAGES_SNAPSHOT",
        messages: [{ id: "old", role: "assistant", content: "stale response" }],
      },
      { type: "TEXT_MESSAGE_START", messageId: "current", role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "current", delta: "fresh response" },
      { type: "TEXT_MESSAGE_END", messageId: "current" },
      { type: "RUN_FINISHED", ...correlation },
    ]);
    expect(result).toMatchObject({ type: "complete", text: "fresh response" });
  });

  it("does not report historical tool results as current-turn results", async () => {
    const { result } = await consume([
      { type: "RUN_STARTED", ...correlation },
      {
        type: "MESSAGES_SNAPSHOT",
        messages: [{ id: "old-tool", role: "tool", toolCallId: "old-call", content: "old" }],
      },
      { type: "TOOL_CALL_START", toolCallId: "new-call", toolCallName: "search" },
      { type: "TOOL_CALL_END", toolCallId: "new-call" },
      {
        type: "TOOL_CALL_RESULT",
        messageId: "new-tool",
        toolCallId: "new-call",
        toolCallName: "search",
        content: "new",
      },
      { type: "RUN_FINISHED", ...correlation },
    ]);
    expect(result.type).toBe("complete");
    if (result.type !== "complete") {
      throw new Error("expected complete result");
    }
    expect(result.toolResults).toEqual([
      { id: "new-call", name: "search", content: "new", isError: false },
    ]);
  });

  it("rejects a clean EOF without a terminal event", async () => {
    await expect(
      consume([
        { type: "RUN_STARTED", ...correlation },
        { type: "TEXT_MESSAGE_CONTENT", messageId: "current", delta: "truncated" },
      ]),
    ).rejects.toThrow(/before RUN_FINISHED or RUN_ERROR/);
  });

  it("forwards RUN_ERROR before rejecting the run", async () => {
    const forwarded: ChatStateEvent[] = [];
    await expect(
      run(function* () {
        const output = {
          *send(event: ChatStateEvent) {
            forwarded.push(event);
          },
          *close() {},
          *[Symbol.iterator]() {
            throw new Error("collecting output is not subscribable");
          },
        } as Channel<ChatStateEvent, void>;
        return yield* consumeAgUiEventStream(
          frames([
            { type: "RUN_STARTED", ...correlation },
            { type: "RUN_ERROR", message: "boom" },
          ]),
          output,
        );
      }),
    ).rejects.toThrow("boom");
    expect(forwarded.at(-1)).toEqual({ type: "RUN_ERROR", message: "boom" });
  });

  it("resets pre-tool text and returns only post-tool assistant text", async () => {
    const { result } = await consume([
      { type: "RUN_STARTED", ...correlation },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "host", delta: "calling tool" },
      {
        type: "TOOL_CALL_START",
        toolCallId: "call",
        toolCallName: "search",
        parentMessageId: "host",
      },
      { type: "TOOL_CALL_END", toolCallId: "call" },
      { type: "TOOL_CALL_RESULT", messageId: "tool", toolCallId: "call", content: "done" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "final", delta: "final answer" },
      { type: "TEXT_MESSAGE_END", messageId: "final" },
      { type: "RUN_FINISHED", ...correlation },
    ]);
    expect(result).toMatchObject({ type: "complete", text: "final answer" });
  });
});
