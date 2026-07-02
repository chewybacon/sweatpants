import { call } from "effection";
import { describe, expect, it } from "./vitest-effection.ts";

import { z } from "zod";
import {
  createInMemoryBufferStore,
  createInMemoryRegistryStore,
  setupDurableStreams,
} from "../../../lib/chat/durable-streams/index.ts";
import { createDurableChatHandler } from "../handler.ts";
import type { ChatHandlerSetup } from "../types.ts";
import {
  consumeDurableResponse,
  createChatRequest,
  createMockProvider,
  createMockTool,
  setupMockModelProvider,
  setupMockTools,
} from "./test-utils.ts";

type AgUiEvent = { type: string; [key: string]: unknown };

const agUiMessageSchema = z.discriminatedUnion("role", [
  z.object({ id: z.string(), role: z.literal("developer"), content: z.string() }).passthrough(),
  z.object({ id: z.string(), role: z.literal("system"), content: z.string() }).passthrough(),
  z
    .object({
      id: z.string(),
      role: z.literal("user"),
      content: z.union([z.string(), z.array(z.any())]),
    })
    .passthrough(),
  z
    .object({
      id: z.string(),
      role: z.literal("assistant"),
      content: z.string().optional(),
      toolCalls: z
        .array(
          z.object({
            id: z.string(),
            type: z.literal("function"),
            function: z.object({ name: z.string(), arguments: z.string() }),
          }),
        )
        .optional(),
    })
    .passthrough(),
  z
    .object({
      id: z.string(),
      role: z.literal("tool"),
      content: z.string(),
      toolCallId: z.string(),
    })
    .passthrough(),
  z
    .object({
      id: z.string(),
      role: z.literal("activity"),
      activityType: z.string(),
      content: z.record(z.any()),
    })
    .passthrough(),
  z.object({ id: z.string(), role: z.literal("reasoning"), content: z.string() }).passthrough(),
]);

// Test-local mirror of the AG-UI core EventSchemas for event families emitted by
// Sweatpants public durable streams. Keep in lockstep with protocols/ag-ui
// sdks/typescript/packages/core/src/events.ts when adding new public event types.
const agUiEventSchemas = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("RUN_STARTED"),
      threadId: z.string(),
      runId: z.string(),
      input: z.any().optional(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal("RUN_FINISHED"),
      threadId: z.string(),
      runId: z.string(),
      outcome: z.any().optional(),
    })
    .passthrough(),
  z
    .object({ type: z.literal("RUN_ERROR"), message: z.string(), code: z.string().optional() })
    .passthrough(),
  z
    .object({ type: z.literal("MESSAGES_SNAPSHOT"), messages: z.array(agUiMessageSchema) })
    .passthrough(),
  z.object({ type: z.literal("STATE_SNAPSHOT"), snapshot: z.any() }).passthrough(),
  z
    .object({
      type: z.literal("TEXT_MESSAGE_START"),
      messageId: z.string(),
      role: z.string().optional(),
    })
    .passthrough(),
  z
    .object({ type: z.literal("TEXT_MESSAGE_CONTENT"), messageId: z.string(), delta: z.string() })
    .passthrough(),
  z.object({ type: z.literal("TEXT_MESSAGE_END"), messageId: z.string() }).passthrough(),
  z
    .object({
      type: z.literal("REASONING_MESSAGE_START"),
      messageId: z.string(),
      role: z.literal("reasoning"),
    })
    .passthrough(),
  z
    .object({
      type: z.literal("REASONING_MESSAGE_CONTENT"),
      messageId: z.string(),
      delta: z.string(),
    })
    .passthrough(),
  z.object({ type: z.literal("REASONING_MESSAGE_END"), messageId: z.string() }).passthrough(),
  z
    .object({
      type: z.literal("TOOL_CALL_START"),
      toolCallId: z.string(),
      toolCallName: z.string(),
    })
    .passthrough(),
  z
    .object({ type: z.literal("TOOL_CALL_ARGS"), toolCallId: z.string(), delta: z.string() })
    .passthrough(),
  z.object({ type: z.literal("TOOL_CALL_END"), toolCallId: z.string() }).passthrough(),
  z
    .object({
      type: z.literal("TOOL_CALL_RESULT"),
      messageId: z.string(),
      toolCallId: z.string(),
      content: z.string(),
      role: z.literal("tool").optional(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal("ACTIVITY_SNAPSHOT"),
      messageId: z.string(),
      activityType: z.string(),
      content: z.record(z.any()),
      replace: z.boolean().optional(),
    })
    .passthrough(),
]);

const legacyPublicEventTypes = new Set([
  "ag_ui_checkpoint",
  "ag_ui_state_snapshot",
  "ag_ui_messages_snapshot",
  "ag_ui_tool_call_result",
  "ag_ui_tool_call_error",
  "elicit_request",
  "conversation_state",
  "session_info",
]);

function createTestHooks(
  provider: ReturnType<typeof createMockProvider>,
  tools: Array<ReturnType<typeof createMockTool>> = [],
): ChatHandlerSetup {
  const bufferStore = createInMemoryBufferStore<string>();
  const registryStore = createInMemoryRegistryStore();

  return function* setup() {
    yield* setupDurableStreams({ bufferStore, registryStore });
    yield* setupMockModelProvider(provider);
    yield* setupMockTools(tools);
  };
}

function assertSchemaValidPublicEvents(events: AgUiEvent[]) {
  expect(events.length).toBeGreaterThan(0);
  for (const event of events) {
    expect(legacyPublicEventTypes.has(event.type)).toBe(false);
    expect(event.type.startsWith("ag_ui_")).toBe(false);
    expect(() => agUiEventSchemas.parse(event)).not.toThrow();
  }
}

function assertAgUiLifecycle(events: AgUiEvent[]) {
  expect(events[0]?.type === "RUN_STARTED" || events[0]?.type === "RUN_ERROR").toBe(true);

  const activeTextMessages = new Set<string>();
  const activeToolCalls = new Set<string>();
  let runTerminal = false;

  for (const event of events) {
    if (runTerminal && event.type !== "RUN_STARTED") {
      throw new Error(`event after terminal run event: ${event.type}`);
    }
    if (event.type === "RUN_STARTED") {
      runTerminal = false;
    }

    switch (event.type) {
      case "TEXT_MESSAGE_START": {
        const messageId = String(event.messageId);
        expect(activeTextMessages.has(messageId)).toBe(false);
        activeTextMessages.add(messageId);
        break;
      }
      case "TEXT_MESSAGE_CONTENT":
        expect(activeTextMessages.has(String(event.messageId))).toBe(true);
        break;
      case "TEXT_MESSAGE_END":
        expect(activeTextMessages.delete(String(event.messageId))).toBe(true);
        break;
      case "TOOL_CALL_START": {
        const toolCallId = String(event.toolCallId);
        expect(activeToolCalls.has(toolCallId)).toBe(false);
        activeToolCalls.add(toolCallId);
        break;
      }
      case "TOOL_CALL_ARGS":
        expect(activeToolCalls.has(String(event.toolCallId))).toBe(true);
        break;
      case "TOOL_CALL_END":
        expect(activeToolCalls.delete(String(event.toolCallId))).toBe(true);
        break;
      case "RUN_FINISHED":
      case "RUN_ERROR":
        expect([...activeTextMessages]).toEqual([]);
        expect([...activeToolCalls]).toEqual([]);
        runTerminal = true;
        break;
    }
  }
}

function assertPublicConformance(events: AgUiEvent[]) {
  assertSchemaValidPublicEvents(events);
  assertAgUiLifecycle(events);
}

function parseSseDataObjects(raw: string): AgUiEvent[] {
  return raw.split("\n\n").flatMap((frame) =>
    frame
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice("data: ".length)) as AgUiEvent),
  );
}

describe("strict AG-UI public conformance", () => {
  it("validates normal text runs against AG-UI schemas and lifecycle rules", function* () {
    const provider = createMockProvider({ responses: "Hello schema world" });
    const handler = createDurableChatHandler({ setup: createTestHooks(provider) });

    const { request } = createChatRequest([
      { id: "user:ag-ui-normal", role: "user", content: "Say hello" },
    ]);
    const response = yield* call(() => handler(request));
    const result = yield* call(() => consumeDurableResponse(response));

    assertPublicConformance(result.events.map((entry) => entry.event as AgUiEvent));
  });

  it("validates tool runs against AG-UI schemas and lifecycle rules", function* () {
    const echoTool = createMockTool("echo", "Echoes input");
    const provider = createMockProvider({
      responses: "Calling tool",
      toolCalls: [{ id: "call-ag-ui-tool", name: "echo", arguments: { input: "hello" } }],
    });
    const handler = createDurableChatHandler({ setup: createTestHooks(provider, [echoTool]) });

    const { request } = createChatRequest(
      [{ id: "user:ag-ui-tool", role: "user", content: "Echo hello" }],
      { enabledTools: true },
    );
    const response = yield* call(() => handler(request));
    const result = yield* call(() => consumeDurableResponse(response));

    const events = result.events.map((entry) => entry.event as AgUiEvent);
    assertPublicConformance(events);
    expect(events.some((event) => event.type === "TOOL_CALL_RESULT")).toBe(true);
  });

  it("validates snapshot hydrate sequences against AG-UI schemas without run-lifecycle rules", function* () {
    // TC-002/TC-003: hydrate responses are snapshot sequences. Every event must
    // still validate against the AG-UI event schemas, but the sequence may begin
    // with MESSAGES_SNAPSHOT rather than RUN_STARTED, so the run-lifecycle
    // assertion is intentionally not applied here.
    const provider = createMockProvider({ responses: "Hydrate me" });
    const handler = createDurableChatHandler({ setup: createTestHooks(provider) });

    const conversationId = `thread-hydrate-schema-${Date.now()}`;
    const { request: postRequest } = createChatRequest(
      [{ id: "user:hydrate", role: "user", content: "Hello there" }],
      { conversationId },
    );
    const postResponse = yield* call(() => handler(postRequest));
    yield* call(() => consumeDurableResponse(postResponse));

    const { request: getRequest } = createChatRequest([], {
      method: "GET",
      conversationId,
    });
    const getResponse = yield* call(() => handler(getRequest));
    const hydrate = yield* call(() => consumeDurableResponse(getResponse));

    const events = hydrate.events.map((entry) => entry.event as AgUiEvent);
    assertSchemaValidPublicEvents(events);
    expect(events[0]?.type).toBe("MESSAGES_SNAPSHOT");
    expect(events.some((event) => event.type === "STATE_SNAPSHOT")).toBe(true);
    expect(events.some((event) => event.type === "RUN_STARTED")).toBe(false);
  });

  it("keeps replay activity out of message snapshots and emits activity snapshots separately", function* () {
    const callId = "call-replay-order";
    const provider = createMockProvider({ responses: "ok" });
    const handler = createDurableChatHandler({ setup: createTestHooks(provider) });

    const response = yield* call(() =>
      handler(
        new Request("http://localhost/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: [
              { id: "user:u1", role: "user", content: "draw cards" },
              {
                id: `assistant:tools:${callId}`,
                role: "assistant",
                content: "",
                tool_calls: [
                  {
                    id: callId,
                    type: "function",
                    function: { name: "pick_card", arguments: { count: 5 } },
                  },
                ],
              },
              {
                id: `tool:${callId}`,
                role: "tool",
                tool_call_id: callId,
                content: "The user selected the J of Hearts.",
              },
              { id: "user:u2", role: "user", content: "cool" },
            ],
            replayState: {
              toolTraces: [
                {
                  callId,
                  toolName: "pick_card",
                  trace: {
                    version: 1,
                    startedAt: 1,
                    completedAt: 2,
                    emissions: [
                      {
                        order: 0,
                        emissionId: "em-1",
                        sourceInterruptId: "interrupt-1",
                        componentKey: "CardPicker",
                        props: { cards: [{ rank: "J", suit: "Hearts", display: "J♥" }] },
                        response: { picked: { rank: "J", suit: "Hearts", display: "J♥" } },
                        timestamp: 1,
                      },
                    ],
                  },
                },
              ],
            },
          }),
        }),
      ),
    );
    const result = yield* call(() => consumeDurableResponse(response));
    const runStarted = result.events
      .map((entry) => entry.event as AgUiEvent)
      .find((event) => event.type === "RUN_STARTED") as
      | { type: "RUN_STARTED"; input?: { messages?: Array<{ id: string; role: string }> } }
      | undefined;

    expect(runStarted?.input?.messages).toBeDefined();
    expect(runStarted?.input?.messages?.map((message) => message.id)).toEqual([
      "user:u1",
      `assistant:tools:${callId}`,
      `tool:${callId}`,
      "user:u2",
    ]);

    const activitySnapshots = result.events
      .map((entry) => entry.event as AgUiEvent)
      .filter((event) => event.type === "ACTIVITY_SNAPSHOT") as Array<{
      type: "ACTIVITY_SNAPSHOT";
      messageId: string;
    }>;
    expect(activitySnapshots.map((event) => event.messageId)).toContain(
      `sweatpants:plugin-replay:${callId}`,
    );
  });

  it("does not leak server-injected system prompts into public snapshots", function* () {
    const provider = createMockProvider({ responses: "prompt safe" });
    const handler = createDurableChatHandler({ setup: createTestHooks(provider) });

    const response = yield* call(() =>
      handler(
        new Request("http://localhost/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: [{ id: "user:prompt", role: "user", content: "hello" }],
            systemPrompt: "__SECRET_DEFAULT_PROMPT_DO_NOT_LEAK__",
          }),
        }),
      ),
    );
    const result = yield* call(() => consumeDurableResponse(response));
    const snapshots = result.events
      .map((entry) => entry.event as AgUiEvent)
      .filter((event) => event.type === "MESSAGES_SNAPSHOT") as Array<{
      type: "MESSAGES_SNAPSHOT";
      messages: Array<{ role: string; content?: string }>;
    }>;

    expect(JSON.stringify(result.events)).not.toContain("__SECRET_DEFAULT_PROMPT_DO_NOT_LEAK__");
    expect(
      snapshots.flatMap((snapshot) => snapshot.messages).some((message) => message.role === "system"),
    ).toBe(false);
  });

  it("emits raw strict SSE frames whose data payloads are AG-UI events", function* () {
    const provider = createMockProvider({ responses: "sse public" });
    const handler = createDurableChatHandler({ setup: createTestHooks(provider) });

    const { request } = createChatRequest(
      [{ id: "user:raw-sse", role: "user", content: "Say hello over SSE" }],
      { live: "sse" },
    );
    const response = yield* call(() => handler(request));
    const raw = yield* call(() => response.text());
    const events = parseSseDataObjects(raw);

    expect(raw).toContain("id: ");
    expect(events.some((event) => "lsn" in event && "event" in event)).toBe(false);
    assertPublicConformance(events);
  });

  it("preserves developer and reasoning roles while excluding non-history activity", function* () {
    const provider = createMockProvider({ responses: "role safe" });
    const handler = createDurableChatHandler({ setup: createTestHooks(provider) });

    const response = yield* call(() =>
      handler(
        new Request("http://localhost/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: [
              { id: "developer:1", role: "developer", content: "developer note" },
              { id: "system:1", role: "system", content: "system note" },
              {
                id: "activity:1",
                role: "activity",
                activityType: "sweatpants:plugin-replay",
                content: { ok: true },
              },
              { id: "reasoning:1", role: "reasoning", content: "private chain" },
              { id: "user:1", role: "user", content: "hello" },
              { id: "unknown:1", role: "not-a-role", content: "must not become user" },
            ],
          }),
        }),
      ),
    );

    const result = yield* call(() => consumeDurableResponse(response));
    const snapshot = result.events
      .map((entry) => entry.event as AgUiEvent)
      .find((event) => event.type === "MESSAGES_SNAPSHOT") as
      | { type: "MESSAGES_SNAPSHOT"; messages: Array<{ id: string; role: string }> }
      | undefined;

    expect(snapshot?.messages.map((message) => [message.id, message.role])).toEqual([
      ["developer:1", "developer"],
      ["system:1", "system"],
      ["reasoning:1", "reasoning"],
      ["user:1", "user"],
    ]);
    expect(snapshot?.messages.some((message) => message.id === "unknown:1")).toBe(false);

    const activitySnapshots = result.events
      .map((entry) => entry.event as AgUiEvent)
      .filter((event) => event.type === "ACTIVITY_SNAPSHOT");
    expect(activitySnapshots).toEqual([]);
  });

  it("strips private runtime session metadata from public interrupts", function* () {
    const provider = createMockProvider({ responses: "interrupt safe" });
    const handler = createDurableChatHandler({ setup: createTestHooks(provider) });

    const response = yield* call(() =>
      handler(
        new Request("http://localhost/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: [{ id: "user:u1", role: "user", content: "resume me" }],
            elicitResponses: [
              {
                sessionId: "private-session",
                callId: "call-1",
                elicitId: "interrupt-1",
                toolName: "book_flight",
                result: { action: "accept", content: { ok: true } },
              },
            ],
          }),
        }),
      ),
    );
    const result = yield* call(() => consumeDurableResponse(response));
    expect(JSON.stringify(result.events)).not.toContain("sweatpants/sessionId");
  });

  it("rejects injected legacy public events in the conformance harness", function* () {
    expect(() =>
      assertPublicConformance([
        { type: "RUN_STARTED", threadId: "thread", runId: "run" },
        { type: "ag_ui_tool_call_result", toolCallId: "call", content: "legacy" },
      ]),
    ).toThrow();
  });
});
