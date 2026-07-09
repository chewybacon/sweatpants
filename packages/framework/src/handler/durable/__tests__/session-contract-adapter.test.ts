import { resource, run, type Operation, type Stream } from "effection";
import { describe, expect, it } from "vitest";

import { createSessionContractInMemoryStore } from "@sweatpants/session-contract";

import { createSessionContractChatEngine } from "../session-contract-adapter.ts";
import type { SessionContractChatEngineParams } from "../types.ts";
import type {
  AssistantMessage,
  Model,
  Runtime,
  StreamEvent as RuntimeStreamEvent,
} from "../../../lib/chat/runtime/index.ts";
import type { StreamEvent } from "../../../lib/chat/session/streaming.ts";
import type { ToolRuntime } from "../../../lib/chat/tool-runtime.ts";

function model(): Model {
  return {
    id: "mock-model",
    name: "Mock Model",
    api: "mock",
    provider: "mock",
    reasoning: false,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 4096,
  };
}

function streamRuntimeTurn(events: RuntimeStreamEvent[], result: AssistantMessage): Stream<RuntimeStreamEvent, AssistantMessage> {
  return resource(function* (provide) {
    let index = 0;
    yield* provide({
      *next(): Operation<IteratorResult<RuntimeStreamEvent, AssistantMessage>> {
        const value = events[index++];
        return value === undefined ? { done: true, value: result } : { done: false, value };
      },
    });
  });
}

function* collect(engine: Stream<StreamEvent, void>): Operation<StreamEvent[]> {
  const subscription = yield* engine;
  const events: StreamEvent[] = [];
  let next = yield* subscription.next();
  while (!next.done) {
    events.push(next.value);
    next = yield* subscription.next();
  }
  return events;
}

function baseParams(overrides: Partial<SessionContractChatEngineParams>): SessionContractChatEngineParams {
  const runtime: Runtime = {
    stream() {
      return streamRuntimeTurn([
        {
          type: "text_delta",
          contentIndex: 0,
          delta: "hello",
          partial: { role: "assistant", content: [{ type: "text", text: "hello" }] },
        },
      ], { role: "assistant", content: [{ type: "text", text: "hello" }], stopReason: "stop" });
    },
    *generateImages() {
      return { output: [] };
    },
  };

  return {
    messages: [{ id: "user:1", role: "user", content: "hello" }],
    toolSchemas: [],
    runtime,
    model: model(),
    maxIterations: 5,
    signal: new AbortController().signal,
    conversationId: "conversation-1",
    agUiRun: { threadId: "thread-1", runId: "run-1" },
    ...overrides,
  } as SessionContractChatEngineParams;
}

describe("session-contract chat engine adapter", () => {
  it("projects a plain fold turn into a bounded AG-UI StreamEvent sequence", async () => {
    await run(function* () {
      const engine = createSessionContractChatEngine(baseParams({}));
      const events = yield* collect(engine);

      expect(events).toEqual([
        { type: "TEXT_MESSAGE_START", messageId: "assistant:final:run-1", role: "assistant" },
        { type: "TEXT_MESSAGE_CONTENT", messageId: "assistant:final:run-1", delta: "hello" },
        { type: "TEXT_MESSAGE_END", messageId: "assistant:final:run-1" },
        { type: "RUN_FINISHED", threadId: "thread-1", runId: "run-1", outcome: { type: "success" } },
      ]);
    });
  });

  it("projects canonical tool calls, tool results, follow-up text, and stream completion", async () => {
    await run(function* () {
      let sampleCount = 0;
      const runtime: Runtime = {
        stream() {
          sampleCount += 1;
          if (sampleCount === 1) {
            const toolCall = { type: "toolCall" as const, id: "calc-1", name: "calculator", arguments: { expression: "2+2" } };
            return streamRuntimeTurn([
              {
                type: "toolcall_end",
                contentIndex: 0,
                toolCall,
                partial: { role: "assistant", content: [toolCall] },
              },
            ], { role: "assistant", content: [toolCall], stopReason: "toolUse" });
          }
          return streamRuntimeTurn([
            {
              type: "text_delta",
              contentIndex: 0,
              delta: "The answer is 4.",
              partial: { role: "assistant", content: [{ type: "text", text: "The answer is 4." }] },
            },
          ], { role: "assistant", content: [{ type: "text", text: "The answer is 4." }], stopReason: "stop" });
        },
        *generateImages() {
          return { output: [] };
        },
      };

      const toolRuntime: ToolRuntime = {
        id: "test-runtime",
        *execute(request) {
          return {
            kind: "completed",
            ref: {
              runtimeId: "test-runtime",
              executionId: request.call.id,
              callId: request.call.id,
              toolName: request.call.function.name,
            },
            result: "4",
          };
        },
        *resume(request) {
          return { kind: "failed", ref: request.ref, error: { code: "missing", message: "missing" } };
        },
        *abort() {},
      };

      const engine = createSessionContractChatEngine(baseParams({
        runtime,
        toolSchemas: [{ name: "calculator", description: "calculate", parameters: { type: "object" } }],
        toolInventoryEntries: [{
          definition: { name: "calculator", description: "calculate", parameters: { type: "object" } },
        }],
        toolRuntime,
        toolRuntimeId: toolRuntime.id,
      }));
      const events = yield* collect(engine);

      expect(events).toContainEqual({
        type: "TOOL_CALL_START",
        toolCallId: "calc-1",
        toolCallName: "calculator",
        parentMessageId: "assistant:tools:calc-1",
      });
      expect(events).toContainEqual({
        type: "TOOL_CALL_ARGS",
        toolCallId: "calc-1",
        delta: JSON.stringify({ expression: "2+2" }),
      });
      expect(events).toContainEqual({ type: "TOOL_CALL_END", toolCallId: "calc-1" });
      expect(events).toContainEqual({
        type: "TOOL_CALL_RESULT",
        messageId: "tool:calc-1",
        toolCallId: "calc-1",
        toolCallName: "calculator",
        content: "4",
        role: "tool",
      });
      expect(events).toContainEqual({
        type: "TEXT_MESSAGE_CONTENT",
        messageId: "assistant:final:run-1",
        delta: "The answer is 4.",
      });
      expect(events.at(-1)).toEqual({
        type: "RUN_FINISHED",
        threadId: "thread-1",
        runId: "run-1",
        outcome: { type: "success" },
      });
      expect(sampleCount).toBe(2);
    });
  });

  it("resumes a final tool result by calling the model again, not by synthesizing text", async () => {
    await run(function* () {
      let sampleCount = 0;
      const runtime: Runtime = {
        stream() {
          sampleCount += 1;
          return streamRuntimeTurn(
            [
              {
                type: "text_delta",
                contentIndex: 0,
                delta: "Your flight is booked, ticket TKT-42.",
                partial: { role: "assistant", content: [{ type: "text", text: "Your flight is booked, ticket TKT-42." }] },
              },
            ],
            { role: "assistant", content: [{ type: "text", text: "Your flight is booked, ticket TKT-42." }], stopReason: "stop" },
          );
        },
        *generateImages() {
          return { output: [] };
        },
      };

      let resumed = false;
      const toolRuntime: ToolRuntime = {
        id: "test-runtime",
        *execute(request) {
          return { kind: "failed", ref: { runtimeId: "test-runtime", executionId: request.call.id, callId: request.call.id, toolName: request.call.function.name }, error: { code: "unused", message: "unused" } };
        },
        *resume(request) {
          resumed = true;
          return {
            kind: "completed",
            ref: request.ref,
            result: { ticketNumber: "TKT-42", message: "Booked" },
          };
        },
        *abort() {},
      };

      const engine = createSessionContractChatEngine(baseParams({
        messages: [
          { id: "user:1", role: "user", content: "book a flight" },
          {
            id: "assistant:1",
            role: "assistant",
            content: "",
            tool_calls: [{ id: "call-1", type: "function", function: { name: "book_flight", arguments: {} } }],
          },
        ],
        runtime,
        toolSchemas: [{ name: "book_flight", description: "book", parameters: { type: "object" } }],
        toolInventoryEntries: [{ definition: { name: "book_flight", description: "book", parameters: { type: "object" } } }],
        toolRuntime,
        toolRuntimeId: toolRuntime.id,
        elicitResponses: [{
          sessionId: "call-1",
          callId: "call-1",
          toolName: "book_flight",
          elicitId: "interrupt-1",
          result: { action: "accept", content: { seat: "3A" } },
          ref: { runtimeId: "test-runtime", executionId: "call-1", sessionId: "call-1", callId: "call-1", toolName: "book_flight" },
        }],
      }));
      const events = yield* collect(engine);

      // The tool runtime was resumed with the elicit response.
      expect(resumed).toBe(true);
      // The final tool result is projected.
      expect(events).toContainEqual({
        type: "TOOL_CALL_RESULT",
        messageId: "tool:call-1",
        toolCallId: "call-1",
        toolCallName: "book_flight",
        content: JSON.stringify({ ticketNumber: "TKT-42", message: "Booked" }),
        role: "tool",
      });
      // The assistant text comes from a real model sample, not synthesized from
      // the tool result.
      expect(sampleCount).toBe(1);
      expect(events).toContainEqual({
        type: "TEXT_MESSAGE_CONTENT",
        messageId: "assistant:final:run-1",
        delta: "Your flight is booked, ticket TKT-42.",
      });
      expect(events.at(-1)).toEqual({
        type: "RUN_FINISHED",
        threadId: "thread-1",
        runId: "run-1",
        outcome: { type: "success" },
      });
    });
  });

  it("resumes into another elicit by emitting a bounded RUN_FINISHED interrupt without calling the model", async () => {
    await run(function* () {
      let sampleCount = 0;
      const runtime: Runtime = {
        stream() {
          sampleCount += 1;
          return streamRuntimeTurn([], { role: "assistant", content: [{ type: "text", text: "" }], stopReason: "stop" });
        },
        *generateImages() {
          return { output: [] };
        },
      };

      const toolRuntime: ToolRuntime = {
        id: "test-runtime",
        *execute(request) {
          return { kind: "failed", ref: { runtimeId: "test-runtime", executionId: request.call.id, callId: request.call.id, toolName: request.call.function.name }, error: { code: "unused", message: "unused" } };
        },
        *resume(request) {
          return {
            kind: "awaiting_elicit",
            ref: request.ref,
            request: { elicitId: "interrupt-2", key: "seat", message: "Pick a seat", schema: { type: "object" } },
          };
        },
        *abort() {},
      };

      const engine = createSessionContractChatEngine(baseParams({
        messages: [{ id: "user:1", role: "user", content: "book a flight" }],
        runtime,
        toolSchemas: [{ name: "book_flight", description: "book", parameters: { type: "object" } }],
        toolInventoryEntries: [{ definition: { name: "book_flight", description: "book", parameters: { type: "object" } } }],
        toolRuntime,
        toolRuntimeId: toolRuntime.id,
        elicitResponses: [{
          sessionId: "call-1",
          callId: "call-1",
          toolName: "book_flight",
          elicitId: "interrupt-1",
          result: { action: "accept", content: { flight: "NYC-LAX" } },
          ref: { runtimeId: "test-runtime", executionId: "call-1", sessionId: "call-1", callId: "call-1", toolName: "book_flight" },
        }],
      }));
      const events = yield* collect(engine);

      // The model is not called when the resume yields another elicit.
      expect(sampleCount).toBe(0);
      const last = events.at(-1) as Extract<StreamEvent, { type: "RUN_FINISHED" }>;
      expect(last.type).toBe("RUN_FINISHED");
      expect(last.outcome.type).toBe("interrupt");
      expect(last.outcome.type === "interrupt" && last.outcome.interrupts[0]?.id).toBe("interrupt-2");
    });
  });

  it("keys the fold session by conversationId, not AG-UI runId", async () => {
    await run(function* () {
      const store = createSessionContractInMemoryStore();
      const conversationId = "conversation-shared";

      let sampleCount = 0;
      const runtime: Runtime = {
        stream() {
          sampleCount += 1;
          if (sampleCount === 1) {
            const toolCall = {
              type: "toolCall" as const,
              id: "call-1",
              name: "book_flight",
              arguments: {},
            };
            return streamRuntimeTurn(
              [
                {
                  type: "toolcall_end",
                  contentIndex: 0,
                  toolCall,
                  partial: { role: "assistant", content: [toolCall] },
                },
              ],
              { role: "assistant", content: [toolCall], stopReason: "toolUse" },
            );
          }
          return streamRuntimeTurn(
            [
              {
                type: "text_delta",
                contentIndex: 0,
                delta: "Booked TKT-99",
                partial: {
                  role: "assistant",
                  content: [{ type: "text", text: "Booked TKT-99" }],
                },
              },
            ],
            {
              role: "assistant",
              content: [{ type: "text", text: "Booked TKT-99" }],
              stopReason: "stop",
            },
          );
        },
        *generateImages() {
          return { output: [] };
        },
      };

      const toolRuntime: ToolRuntime = {
        id: "test-runtime",
        *execute(request) {
          return {
            kind: "awaiting_elicit",
            ref: {
              runtimeId: "test-runtime",
              executionId: request.call.id,
              callId: request.call.id,
              toolName: request.call.function.name,
            },
            request: {
              elicitId: "interrupt-1",
              key: "seat",
              message: "Pick a seat",
              schema: { type: "object" },
            },
          };
        },
        *resume(request) {
          return {
            kind: "completed",
            ref: request.ref,
            result: { ticketNumber: "TKT-99" },
          };
        },
        *abort() {},
      };

      const first = createSessionContractChatEngine(
        baseParams({
          conversationId,
          foldSessionBufferStore: store,
          agUiRun: { threadId: conversationId, runId: "run-1" },
          runtime,
          toolSchemas: [
            { name: "book_flight", description: "book", parameters: { type: "object" } },
          ],
          toolInventoryEntries: [
            {
              definition: {
                name: "book_flight",
                description: "book",
                parameters: { type: "object" },
              },
            },
          ],
          toolRuntime,
          toolRuntimeId: toolRuntime.id,
        }),
      );
      const firstEvents = yield* collect(first);
      const firstFinished = firstEvents.at(-1) as Extract<StreamEvent, { type: "RUN_FINISHED" }>;
      expect(firstFinished.outcome.type).toBe("interrupt");

      // Same conversationId, different AG-UI runId: must reopen the same fold log.
      // Messages intentionally omit the assistant tool call so bootstrapResumeSession
      // would fail if the adapter invented a fresh log instead of reopening.
      const second = createSessionContractChatEngine(
        baseParams({
          conversationId,
          foldSessionBufferStore: store,
          agUiRun: { threadId: conversationId, runId: "run-2" },
          messages: [{ id: "user:1", role: "user", content: "book a flight" }],
          runtime,
          toolSchemas: [
            { name: "book_flight", description: "book", parameters: { type: "object" } },
          ],
          toolInventoryEntries: [
            {
              definition: {
                name: "book_flight",
                description: "book",
                parameters: { type: "object" },
              },
            },
          ],
          toolRuntime,
          toolRuntimeId: toolRuntime.id,
          elicitResponses: [
            {
              sessionId: "call-1",
              callId: "call-1",
              toolName: "book_flight",
              elicitId: "interrupt-1",
              result: { action: "accept", content: { seat: "3A" } },
              ref: {
                runtimeId: "test-runtime",
                executionId: "call-1",
                sessionId: "call-1",
                callId: "call-1",
                toolName: "book_flight",
              },
            },
          ],
        }),
      );
      const secondEvents = yield* collect(second);

      expect(secondEvents).toContainEqual({
        type: "TOOL_CALL_RESULT",
        messageId: "tool:call-1",
        toolCallId: "call-1",
        toolCallName: "book_flight",
        content: JSON.stringify({ ticketNumber: "TKT-99" }),
        role: "tool",
      });
      expect(secondEvents).toContainEqual({
        type: "TEXT_MESSAGE_CONTENT",
        messageId: "assistant:final:run-2",
        delta: "Booked TKT-99",
      });
      expect(sampleCount).toBe(2);
    });
  });

  it("carries prior tool results into the next free-form turn from the fold log", async () => {
    await run(function* () {
      const store = createSessionContractInMemoryStore();
      const conversationId = "conversation-history";
      const providerMessageSnapshots: unknown[][] = [];

      let sampleCount = 0;
      const runtime: Runtime = {
        stream(_model, context) {
          sampleCount += 1;
          providerMessageSnapshots.push(context.messages as unknown[]);
          if (sampleCount === 1) {
            const toolCall = {
              type: "toolCall" as const,
              id: "calc-1",
              name: "calculator",
              arguments: { expression: "2+2" },
            };
            return streamRuntimeTurn(
              [
                {
                  type: "toolcall_end",
                  contentIndex: 0,
                  toolCall,
                  partial: { role: "assistant", content: [toolCall] },
                },
              ],
              { role: "assistant", content: [toolCall], stopReason: "toolUse" },
            );
          }
          if (sampleCount === 2) {
            return streamRuntimeTurn(
              [
                {
                  type: "text_delta",
                  contentIndex: 0,
                  delta: "4",
                  partial: { role: "assistant", content: [{ type: "text", text: "4" }] },
                },
              ],
              { role: "assistant", content: [{ type: "text", text: "4" }], stopReason: "stop" },
            );
          }
          return streamRuntimeTurn(
            [
              {
                type: "text_delta",
                contentIndex: 0,
                delta: "previously 4",
                partial: {
                  role: "assistant",
                  content: [{ type: "text", text: "previously 4" }],
                },
              },
            ],
            {
              role: "assistant",
              content: [{ type: "text", text: "previously 4" }],
              stopReason: "stop",
            },
          );
        },
        *generateImages() {
          return { output: [] };
        },
      };

      const toolRuntime: ToolRuntime = {
        id: "test-runtime",
        *execute(request) {
          return {
            kind: "completed",
            ref: {
              runtimeId: "test-runtime",
              executionId: request.call.id,
              callId: request.call.id,
              toolName: request.call.function.name,
            },
            result: "4",
          };
        },
        *resume(request) {
          return {
            kind: "failed",
            ref: request.ref,
            error: { code: "missing", message: "missing" },
          };
        },
        *abort() {},
      };

      const first = createSessionContractChatEngine(
        baseParams({
          conversationId,
          foldSessionBufferStore: store,
          agUiRun: { threadId: conversationId, runId: "run-1" },
          messages: [{ id: "user:1", role: "user", content: "compute 2+2" }],
          runtime,
          toolSchemas: [
            { name: "calculator", description: "calculate", parameters: { type: "object" } },
          ],
          toolInventoryEntries: [
            {
              definition: {
                name: "calculator",
                description: "calculate",
                parameters: { type: "object" },
              },
            },
          ],
          toolRuntime,
          toolRuntimeId: toolRuntime.id,
        }),
      );
      yield* collect(first);

      // Client only sends the new free-form user message. History must come from
      // the persisted fold log, not from client-side message reconstruction.
      const second = createSessionContractChatEngine(
        baseParams({
          conversationId,
          foldSessionBufferStore: store,
          agUiRun: { threadId: conversationId, runId: "run-2" },
          messages: [{ id: "user:2", role: "user", content: "what was the previous result?" }],
          runtime,
          toolSchemas: [
            { name: "calculator", description: "calculate", parameters: { type: "object" } },
          ],
          toolInventoryEntries: [
            {
              definition: {
                name: "calculator",
                description: "calculate",
                parameters: { type: "object" },
              },
            },
          ],
          toolRuntime,
          toolRuntimeId: toolRuntime.id,
        }),
      );
      const secondEvents = yield* collect(second);

      const followupRequest = providerMessageSnapshots[2] as Array<Record<string, unknown>>;
      expect(followupRequest).toBeDefined();

      // Runtime projection uses role "toolResult" (not the fold transcript's "tool").
      const toolResults = followupRequest.filter((message) => message.role === "toolResult");
      expect(toolResults.length).toBeGreaterThan(0);
      expect(
        toolResults.some((message) => {
          const content = message.content;
          if (typeof content === "string") return content.includes("4");
          if (!Array.isArray(content)) return false;
          return content.some(
            (part) =>
              part &&
              typeof part === "object" &&
              typeof (part as { text?: unknown }).text === "string" &&
              (part as { text: string }).text.includes("4"),
          );
        }),
      ).toBe(true);
      expect(secondEvents).toContainEqual({
        type: "TEXT_MESSAGE_CONTENT",
        messageId: "assistant:final:run-2",
        delta: "previously 4",
      });
    });
  });
});
