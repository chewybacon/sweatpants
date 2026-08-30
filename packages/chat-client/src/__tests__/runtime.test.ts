import { EventType } from "@ag-ui/core";
import type { Operation, Stream } from "effection";
import { describe, expect, it } from "vitest";
import {
  CONVERSATION_AUTHORITY_FRAME_TYPE,
  CONVERSATION_WINDOW_FRAME_TYPE,
  createChatClient,
  createChatRuntime,
  type AGUIEvent,
  type ConversationStreamEvent,
  type ChatTransportContract,
} from "../index.ts";

function window(conversationId: string, basisRevision: string): ConversationStreamEvent {
  return {
    type: CONVERSATION_WINDOW_FRAME_TYPE,
    conversationId,
    lineageId: `lineage:${conversationId}`,
    basisRevision,
    windowToken: `window:${conversationId}:${basisRevision}`,
    windowMode: "reset",
    archiveFrontierOrdinal: "0",
    nextPublicPosition: "0",
    hotRoots: [],
    sealedCatchupRoots: [],
    applicationState: {},
    olderHistoryCursor: null,
  };
}

function stream(events: readonly AGUIEvent[]): Stream<ConversationStreamEvent, void> {
  const started = events.find((event) => event.type === EventType.RUN_STARTED);
  const frames: readonly ConversationStreamEvent[] = started
    ? [
        events[0]!,
        window(started.threadId, "1"),
        {
          type: CONVERSATION_AUTHORITY_FRAME_TYPE,
          authority: {
            conversationId: started.threadId,
            revision: "1",
            state: "running",
            activeLogicalTurnId: started.runId,
            activeExecutionId: `execution:${started.runId}`,
            latestCompletedExecutionId: null,
          },
        },
        ...events.slice(1, -1),
        {
          type: CONVERSATION_AUTHORITY_FRAME_TYPE,
          authority: {
            conversationId: started.threadId,
            revision: "2",
            state: "idle",
            activeLogicalTurnId: null,
            activeExecutionId: null,
            latestCompletedExecutionId: `execution:${started.runId}`,
          },
        },
        ...events.slice(-1),
      ]
    : events;
  return (function* () {
    let index = 0;
    return {
      next(): Operation<IteratorResult<ConversationStreamEvent, void>> {
        return (function* () {
          return index < frames.length
            ? { done: false, value: frames[index++] }
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
        const runId = request.runId ?? request.command.commandId;
        return stream([
          { type: "RUN_STARTED", threadId: request.conversationId, runId },
          { type: "RUN_FINISHED", threadId: request.conversationId, runId },
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
    const first = runtime.createClient({ threadId: "first" });
    const second = runtime.createClient({ threadId: "second" });
    await Promise.all([first.initialized, second.initialized]);
    await first.sendMessage("one");
    await second.sendMessage("two");
    expect(trace).toEqual([
      "runtime:enter",
      "driver:first",
      "runtime:exit",
      "runtime:enter",
      "driver:second",
      "runtime:exit",
    ]);
    expect(first.getSnapshot().authority?.conversationId).toBe("first");
    expect(second.getSnapshot().authority?.conversationId).toBe("second");
    await runtime.close();
  });

  it("allows a child client to shadow the inherited driver", async () => {
    const calls: string[] = [];
    const make = (label: string): ChatTransportContract => ({
      *sendMessages(request) {
        calls.push(`${label}:${request.conversationId}`);
        const runId = request.runId ?? request.command.commandId;
        return stream([
          { type: "RUN_STARTED", threadId: request.conversationId, runId },
          { type: "RUN_FINISHED", threadId: request.conversationId, runId },
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
      threadId: "child",
      transport: { driver: make("child") },
    });
    await client.initialized;
    await client.sendMessage("hello");
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
            const runId = request.runId ?? request.command.commandId;
            return stream([
              { type: "RUN_STARTED", threadId: request.conversationId, runId },
              {
                type: "RUN_FINISHED",
                threadId: request.conversationId,
                runId,
              },
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
    const client = runtime.createClient({ threadId: "middleware-order" });
    await client.initialized;
    await client.sendMessage("hello");
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
            const runId = request.runId ?? request.command.commandId;
            return stream([
              { type: "RUN_STARTED", threadId: request.conversationId, runId },
              {
                type: "RUN_FINISHED",
                threadId: request.conversationId,
                runId,
              },
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
      threadId: "event-middleware",
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
    await client.sendMessage("hello");
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
    const connection: ChatTransportContract = {
      *sendMessages() {
        return stream([]);
      },
      *reconnectToStream() {
        return null;
      },
      *disconnect() {
        return;
      },
    };
    const first = createChatClient({ threadId: "one", connection });
    const second = createChatClient({ threadId: "two", connection });
    await Promise.all([first.initialized, second.initialized]);
    first.setMessages([]);
    expect(second.getSnapshot().messages).toHaveLength(0);
    await Promise.all([first.close(), second.close()]);
  });
});
