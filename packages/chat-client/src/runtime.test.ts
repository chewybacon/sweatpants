import type { Operation, Stream } from "effection";
import { describe, expect, it } from "vitest";
import {
  createChatClient,
  createChatRuntime,
  type ChatStreamEvent,
  type ChatTransportContract,
} from "./index.ts";

function stream(events: readonly ChatStreamEvent[]): Stream<ChatStreamEvent, void> {
  return (function* () {
    let index = 0;
    return {
      next(): Operation<IteratorResult<ChatStreamEvent, void>> {
        return (function* () {
          return index < events.length
            ? { done: false, value: events[index++] }
            : { done: true, value: undefined };
        })();
      },
    };
  })();
}

describe("ChatRuntime composition", () => {
  it("inherits transport and command middleware while isolating client messages", async () => {
    const trace: string[] = [];
    const driver: ChatTransportContract = {
      *sendMessages(request) {
        trace.push(`driver:${request.conversationId}`);
        return stream([
          { type: "RUN_STARTED", threadId: request.conversationId, runId: request.runId },
          { type: "RUN_FINISHED", threadId: request.conversationId, runId: request.runId },
        ]);
      },
      *reconnectToStream() {
        return null;
      },
      *disconnect() {
        return;
      },
    };
    const runtime = createChatRuntime({
      transport: { driver },
      middleware: [
        {
          *sendMessage(args, next) {
            trace.push("runtime:enter");
            const result = yield* next(...args);
            trace.push("runtime:exit");
            return result;
          },
        },
      ],
    });
    const first = runtime.createClient({ conversationId: "first" });
    const second = runtime.createClient({ conversationId: "second" });
    await Promise.all([first.initialized, second.initialized]);
    await first.sendMessage({ text: "one" });
    await second.sendMessage({ text: "two" });
    expect(trace).toEqual([
      "runtime:enter",
      "driver:first",
      "runtime:exit",
      "runtime:enter",
      "driver:second",
      "runtime:exit",
    ]);
    expect(first.getSnapshot().messages).not.toEqual(second.getSnapshot().messages);
    await runtime.close();
  });

  it("allows a child client to shadow the inherited driver", async () => {
    const calls: string[] = [];
    const make = (label: string): ChatTransportContract => ({
      *sendMessages(request) {
        calls.push(`${label}:${request.conversationId}`);
        return stream([
          { type: "RUN_STARTED", threadId: request.conversationId, runId: request.runId },
          { type: "RUN_FINISHED", threadId: request.conversationId, runId: request.runId },
        ]);
      },
      *reconnectToStream() {
        return null;
      },
      *disconnect() {
        return;
      },
    });
    const runtime = createChatRuntime({ transport: { driver: make("parent") } });
    const client = runtime.createClient({
      conversationId: "child",
      transport: { driver: make("child") },
    });
    await client.initialized;
    await client.sendMessage({ text: "hello" });
    expect(calls).toEqual(["child:child"]);
    await runtime.close();
  });

  it("keeps the first declared middleware outermost", async () => {
    const trace: string[] = [];
    const runtime = createChatRuntime({
      middleware: [
        {
          *sendMessage(args, next) {
            trace.push("a:enter");
            const result = yield* next(...args);
            trace.push("a:exit");
            return result;
          },
        },
        {
          *sendMessage(args, next) {
            trace.push("b:enter");
            const result = yield* next(...args);
            trace.push("b:exit");
            return result;
          },
        },
      ],
      transport: {
        driver: {
          *sendMessages(request) {
            trace.push("driver");
            return stream([
              { type: "RUN_STARTED", threadId: request.conversationId, runId: request.runId },
              { type: "RUN_FINISHED", threadId: request.conversationId, runId: request.runId },
            ]);
          },
          *reconnectToStream() {
            return null;
          },
          *disconnect() {
            return;
          },
        },
      },
    });
    const client = runtime.createClient({ conversationId: "middleware-order" });
    await client.initialized;
    await client.sendMessage({ text: "hello" });
    expect(trace).toEqual(["a:enter", "b:enter", "driver", "b:exit", "a:exit"]);
    await runtime.close();
  });

  it("observes immutable events through inherited Around middleware", async () => {
    const trace: string[] = [];
    const runtime = createChatRuntime({
      eventMiddleware: [
        {
          *accept(args, next) {
            trace.push(`runtime:enter:${args[0].type}`);
            yield* next(...args);
            trace.push(`runtime:exit:${args[0].type}`);
          },
        },
      ],
      transport: {
        driver: {
          *sendMessages(request) {
            return stream([
              { type: "RUN_STARTED", threadId: request.conversationId, runId: request.runId },
              { type: "RUN_FINISHED", threadId: request.conversationId, runId: request.runId },
            ]);
          },
          *reconnectToStream() {
            return null;
          },
          *disconnect() {
            return;
          },
        },
      },
    });
    const client = runtime.createClient({
      conversationId: "event-middleware",
      eventMiddleware: [
        {
          *accept(args, next) {
            trace.push(`client:enter:${args[0].type}`);
            yield* next(...args);
            trace.push(`client:exit:${args[0].type}`);
          },
        },
      ],
    });
    await client.initialized;
    await client.sendMessage({ text: "hello" });
    expect(trace).toEqual([
      "runtime:enter:RUN_STARTED",
      "client:enter:RUN_STARTED",
      "client:exit:RUN_STARTED",
      "runtime:exit:RUN_STARTED",
      "runtime:enter:RUN_FINISHED",
      "client:enter:RUN_FINISHED",
      "client:exit:RUN_FINISHED",
      "runtime:exit:RUN_FINISHED",
    ]);
    await runtime.close();
  });

  it("has no implicit global client when using the standalone factory", async () => {
    const first = createChatClient({ conversationId: "one" });
    const second = createChatClient({ conversationId: "two" });
    await Promise.all([first.initialized, second.initialized]);
    first.setMessages([]);
    expect(second.getSnapshot().messages).toHaveLength(0);
    await Promise.all([first.close(), second.close()]);
  });
});
