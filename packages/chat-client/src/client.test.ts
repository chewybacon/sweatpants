import { EventType } from "@ag-ui/core";
import { call, resource, type Operation, type Stream } from "effection";
import { describe, expect, it } from "vitest";
import {
  ChatTransportPort,
  createChatClient,
  createChatRuntime,
  type ChatInteractionCompletion,
  type ChatInteractionRequest,
  type ChatInteractionRuntime,
  type ChatTransportRequest,
  type AGUIEvent,
  type ChatTransportContract,
} from "./index.ts";

function streamOf(events: readonly AGUIEvent[]): Stream<AGUIEvent, void> {
  return (function* () {
    let index = 0;
    return {
      next(): Operation<IteratorResult<AGUIEvent, void>> {
        return (function* () {
          if (index >= events.length) {
            return { done: true, value: undefined };
          }
          return { done: false, value: events[index++] };
        })();
      },
    };
  })();
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function gatedStream(events: readonly AGUIEvent[], gate: Promise<void>): Stream<AGUIEvent, void> {
  return resource(function* (provide) {
    let released = false;
    let index = 0;
    yield* provide({
      *next(): Operation<IteratorResult<AGUIEvent, void>> {
        if (!released) {
          released = true;
          yield* call(() => gate);
        }
        if (index >= events.length) {
          return { done: true, value: undefined };
        }
        return { done: false, value: events[index++]! };
      },
    });
  });
}

function waitForQueue(
  client: {
    getSnapshot(): { queue: readonly unknown[] };
    subscribe(listener: () => void): () => void;
  },
  length: number,
): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      if (client.getSnapshot().queue.length === length) {
        resolve();
      }
    };
    client.subscribe(check);
    check();
  });
}

function transport(events: readonly AGUIEvent[]): ChatTransportContract {
  return {
    *sendMessages() {
      return streamOf(events);
    },
    *reconnectToStream() {
      return null;
    },
    *disconnect() {
      return;
    },
  };
}

describe("headless ChatClient", () => {
  it("keeps local render parts out of the server snapshot during status churn", async () => {
    type RenderPart = { readonly type: "render"; readonly id: string; readonly node: () => null };
    const client = createChatClient<RenderPart>({
      threadId: "server-snapshot-render",
      connection: transport([]),
    });
    await client.initialized;
    client.setMessages([
      {
        id: "assistant-1",
        role: "assistant",
        parts: [{ type: "render", id: "render-1", node: () => null }],
      },
    ]);
    expect(client.getSnapshot().messages[0]?.parts[0]?.type).toBe("render");

    client.clearError();

    expect(() => JSON.stringify(client.getServerSnapshot())).not.toThrow();
    expect(JSON.stringify(client.getServerSnapshot())).not.toContain('"type":"render"');
    await client.close();
  });

  it("completes a turn with the active assistant in messages", async () => {
    const client = createChatClient({
      threadId: "conversation-1",
      connection: transport([
        { type: EventType.RUN_STARTED, threadId: "conversation-1", runId: "run-1" },
        { type: EventType.TEXT_MESSAGE_START, messageId: "assistant-1", role: "assistant" },
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: "assistant-1",
          delta: "Hello **world**",
        },
        { type: EventType.TEXT_MESSAGE_END, messageId: "assistant-1" },
        { type: EventType.RUN_FINISHED, threadId: "conversation-1", runId: "run-1" },
      ]),
    });
    await client.initialized;
    await client.sendMessage("Hi");
    const snapshot = client.getSnapshot();
    expect(snapshot.runId).toBeNull();
    expect(snapshot.status).toBe("ready");
    expect(snapshot.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(snapshot.messages[1]?.parts[0]).toMatchObject({
      type: "text",
      text: "Hello **world**",
      state: "done",
    });
    expect(
      snapshot.messages[1]?.parts[0]?.type === "text" && snapshot.messages[1]?.parts[0]?.rendered,
    ).toContain("<strong>world</strong>");
    const authoritative = client.getServerSnapshot();
    client.setMessages([]);
    expect(client.getSnapshot().messages).toHaveLength(0);
    expect(client.getServerSnapshot().messages).toEqual(authoritative.messages);
    await client.close();
  });

  it("uses the fetcher convenience and forwards request context", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const client = createChatClient({
      threadId: "fetcher-thread",
      state: { draft: "local-state" },
      context: [{ description: "tenant", value: "test" }],
      forwardedProps: { mode: "preview" },
      fetcher: async (_input, init) => {
        if (typeof init?.body !== "string") {
          throw new Error("expected JSON request body");
        }
        requestBody = JSON.parse(init.body) as Record<string, unknown>;
        const events = [
          { type: EventType.RUN_STARTED, threadId: "fetcher-thread", runId: "run-fetcher" },
          { type: EventType.RUN_FINISHED, threadId: "fetcher-thread", runId: "run-fetcher" },
        ];
        return new Response(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`, {
          headers: { "content-type": "application/x-ndjson" },
        });
      },
    });
    await client.initialized;
    await client.sendMessage("hello");
    expect(requestBody).toMatchObject({
      conversationId: "fetcher-thread",
      input: {
        threadId: "fetcher-thread",
        state: { draft: "local-state" },
        context: [{ description: "tenant", value: "test" }],
        forwardedProps: { mode: "preview" },
        tools: [],
      },
    });
    expect(client.threadId).toBe("fetcher-thread");
    await client.close();
  });

  it("classifies transport failures separately from malformed events", async () => {
    const failedTransport = createChatClient({
      threadId: "transport-failure",
      fetcher: async () => new Response("upstream unavailable", { status: 500 }),
    });
    await failedTransport.initialized;
    await expect(failedTransport.sendMessage("fail")).rejects.toMatchObject({
      code: "chat_transport_failed",
    });
    await failedTransport.close();

    const malformedTransport = createChatClient({
      threadId: "malformed-event",
      fetcher: async () =>
        new Response('{"type":"TEXT_MESSAGE_CONTENT"}\n', {
          headers: { "content-type": "application/x-ndjson" },
        }),
    });
    await malformedTransport.initialized;
    await expect(malformedTransport.sendMessage("malformed")).rejects.toMatchObject({
      code: "chat_event_invalid",
    });
    await malformedTransport.close();
  });

  it("does not misclassify unrelated initialization errors as driver duplicates", async () => {
    const client = createChatClient({
      threadId: "initialization-failure",
      setup: function* () {
        throw new Error("unrelated setup failure");
      },
      connection: transport([]),
    });
    await expect(client.initialized).rejects.toMatchObject({
      code: "chat_client_initialization_failed",
    });
    await client.close();
  });

  it("keeps runtime-level HTTP reconnect cursors isolated by thread", async () => {
    const requests: Array<{ readonly url: string; readonly method: string }> = [];
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = init?.method ?? "GET";
      requests.push({ url, method });
      if (method === "POST") {
        if (typeof init?.body !== "string") {
          throw new Error("expected a JSON request body");
        }
        const body = JSON.parse(init.body) as { input: { threadId: string } };
        const start = body.input.threadId === "thread-a" ? 10 : 20;
        const events = [
          {
            lsn: start,
            event: {
              type: EventType.RUN_STARTED,
              threadId: body.input.threadId,
              runId: `run-${start}`,
            },
          },
          {
            lsn: start + 1,
            event: {
              type: EventType.RUN_FINISHED,
              threadId: body.input.threadId,
              runId: `run-${start}`,
              outcome: { type: "success" },
            },
          },
        ];
        return new Response(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`, {
          headers: { "content-type": "application/x-ndjson" },
        });
      }
      const threadId = new URL(url).searchParams.get("conversationId") ?? "unknown";
      const start = threadId === "thread-a" ? 12 : 22;
      const events = [
        {
          lsn: start,
          event: { type: EventType.RUN_STARTED, threadId, runId: `reconnect-${start}` },
        },
        {
          lsn: start + 1,
          event: {
            type: EventType.RUN_FINISHED,
            threadId,
            runId: `reconnect-${start}`,
            outcome: { type: "success" },
          },
        },
      ];
      return new Response(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`, {
        headers: { "content-type": "application/x-ndjson" },
      });
    };
    const runtime = createChatRuntime({ api: "http://localhost/chat", fetcher });
    const first = runtime.createClient({ threadId: "thread-a" });
    const second = runtime.createClient({ threadId: "thread-b" });
    await Promise.all([runtime.initialized, first.initialized, second.initialized]);

    await first.sendMessage("first");
    await second.sendMessage("second");
    await first.reconnect();
    await second.reconnect();

    const reconnects = requests.filter((request) => request.method === "GET");
    expect(reconnects.map((request) => new URL(request.url).searchParams.get("offset"))).toEqual([
      "11",
      "21",
    ]);
    await first.close();
    await second.close();
    await runtime.close();
  });

  it("exposes the active run and bounds/cancels queued sends", async () => {
    const started = deferred<string>();
    const release = deferred<void>();
    let first = true;
    const driver: ChatTransportContract = {
      *sendMessages(request) {
        if (!first) {
          return streamOf([
            {
              type: EventType.RUN_STARTED,
              threadId: request.input.threadId,
              runId: request.input.runId,
            },
            {
              type: EventType.RUN_FINISHED,
              threadId: request.input.threadId,
              runId: request.input.runId,
            },
          ]);
        }
        first = false;
        started.resolve(request.input.runId);
        return gatedStream(
          [
            {
              type: EventType.RUN_STARTED,
              threadId: request.input.threadId,
              runId: request.input.runId,
            },
            {
              type: EventType.RUN_FINISHED,
              threadId: request.input.threadId,
              runId: request.input.runId,
            },
          ],
          release.promise,
        );
      },
      *reconnectToStream() {
        return null;
      },
      *disconnect() {
        return;
      },
    };
    const client = createChatClient({
      threadId: "queue-thread",
      queue: { maxSize: 1, onOverflow: "reject" },
      transport: { driver },
    });
    await client.initialized;

    const firstTurn = client.sendMessage("first");
    const activeRunId = await started.promise;
    expect(client.getSnapshot().runId).toBe(activeRunId);

    const queuedTurn = client.sendMessage("second");
    await waitForQueue(client, 1);
    const queuedId = client.getSnapshot().queue[0].id;
    await expect(client.sendMessage("third")).rejects.toMatchObject({
      code: "chat_queue_full",
    });

    await client.cancelQueued(queuedId);
    await queuedTurn;
    expect(client.getSnapshot().queue).toHaveLength(0);

    release.resolve();
    await firstTurn;
    expect(client.getSnapshot().runId).toBeNull();
    await client.close();
  });

  it("reports the message dropped by drop-oldest overflow", async () => {
    const started = deferred<void>();
    const release = deferred<void>();
    let first = true;
    const driver: ChatTransportContract = {
      *sendMessages(request) {
        if (!first) {
          return streamOf([
            {
              type: EventType.RUN_STARTED,
              threadId: request.input.threadId,
              runId: request.input.runId,
            },
            {
              type: EventType.RUN_FINISHED,
              threadId: request.input.threadId,
              runId: request.input.runId,
            },
          ]);
        }
        first = false;
        started.resolve(undefined);
        return gatedStream(
          [
            {
              type: EventType.RUN_STARTED,
              threadId: request.input.threadId,
              runId: request.input.runId,
            },
            {
              type: EventType.RUN_FINISHED,
              threadId: request.input.threadId,
              runId: request.input.runId,
            },
          ],
          release.promise,
        );
      },
      *reconnectToStream() {
        return null;
      },
      *disconnect() {
        return;
      },
    };
    const client = createChatClient({
      threadId: "drop-oldest-thread",
      queue: { maxSize: 1, onOverflow: "drop-oldest" },
      connection: driver,
    });
    await client.initialized;

    const firstTurn = client.sendMessage("first");
    await started.promise;
    const droppedTurn = client.sendMessage("second");
    await waitForQueue(client, 1);
    const replacementTurn = client.sendMessage("third");

    await expect(droppedTurn).rejects.toMatchObject({ code: "chat_queue_dropped" });
    release.resolve();
    await firstTurn;
    await replacementTurn;
    await client.close();
  });

  it("drains queued sends after a resume elicitation settles", async () => {
    const resumeStarted = deferred<void>();
    const releaseResume = deferred<void>();
    const thirdStarted = deferred<void>();
    let completionHandler:
      | ((request: ChatInteractionRequest, completion: ChatInteractionCompletion) => void)
      | undefined;
    let requestCount = 0;
    const driver: ChatTransportContract = {
      *sendMessages(request) {
        requestCount += 1;
        if (requestCount === 1) {
          return streamOf([
            {
              type: EventType.RUN_STARTED,
              threadId: request.input.threadId,
              runId: request.input.runId,
            },
            {
              type: EventType.RUN_FINISHED,
              threadId: request.input.threadId,
              runId: request.input.runId,
              outcome: { type: "interrupt" },
            },
          ]);
        }
        if (requestCount === 2) {
          resumeStarted.resolve(undefined);
          return gatedStream(
            [
              {
                type: EventType.RUN_STARTED,
                threadId: request.input.threadId,
                runId: request.input.runId,
              },
              {
                type: EventType.RUN_FINISHED,
                threadId: request.input.threadId,
                runId: request.input.runId,
                outcome: { type: "success" },
              },
            ],
            releaseResume.promise,
          );
        }
        thirdStarted.resolve(undefined);
        return streamOf([
          {
            type: EventType.RUN_STARTED,
            threadId: request.input.threadId,
            runId: request.input.runId,
          },
          {
            type: EventType.RUN_FINISHED,
            threadId: request.input.threadId,
            runId: request.input.runId,
            outcome: { type: "success" },
          },
        ]);
      },
      *reconnectToStream() {
        return null;
      },
      *disconnect() {
        return;
      },
    };
    const interaction: ChatInteractionRuntime = {
      observe() {},
      settled() {},
      cancel() {},
      localParts: () => new Map(),
      onChange: () => () => undefined,
      setOnCompletion(handler) {
        completionHandler = handler;
      },
      dispose() {},
    };
    const client = createChatClient({
      threadId: "resume-queue-thread",
      interaction,
      connection: driver,
    });
    await client.initialized;
    await client.sendMessage("initial");
    expect(completionHandler).toBeDefined();

    completionHandler!({} as ChatInteractionRequest, { action: "accept", content: {} });
    await resumeStarted.promise;
    const queued = client.sendMessage("queued during resume");
    await waitForQueue(client, 1);
    releaseResume.resolve();
    await thirdStarted.promise;
    await queued;
    await client.close();
  });

  it("rejects invalid queue policies at client construction", () => {
    expect(() =>
      createChatClient({
        threadId: "invalid-when-busy",
        queue: { whenBusy: "later" as never },
      }),
    ).toThrow(/chat_queue_invalid/);
    expect(() =>
      createChatClient({
        threadId: "invalid-overflow",
        queue: { onOverflow: "drop-newest" as never },
      }),
    ).toThrow(/chat_queue_invalid/);
  });

  it("carries settled tool history into the next provider request", async () => {
    const requests: ChatTransportRequest[] = [];
    const driver: ChatTransportContract = {
      *sendMessages(request) {
        requests.push(request);
        return streamOf(
          requests.length === 1
            ? [
                { type: EventType.RUN_STARTED, threadId: "history", runId: "run-1" },
                {
                  type: EventType.TOOL_CALL_START,
                  toolCallId: "call-1",
                  toolCallName: "lookup",
                  parentMessageId: "assistant-1",
                },
                { type: EventType.TOOL_CALL_ARGS, toolCallId: "call-1", delta: '{"id":1}' },
                { type: EventType.TOOL_CALL_END, toolCallId: "call-1" },
                {
                  type: EventType.TOOL_CALL_RESULT,
                  messageId: "tool-1",
                  toolCallId: "call-1",
                  content: '{"value":"found"}',
                  role: "tool",
                },
                { type: EventType.RUN_FINISHED, threadId: "history", runId: "run-1" },
              ]
            : [
                { type: EventType.RUN_STARTED, threadId: "history", runId: "run-2" },
                { type: EventType.RUN_FINISHED, threadId: "history", runId: "run-2" },
              ],
        );
      },
      *reconnectToStream() {
        return null;
      },
      *disconnect() {
        return;
      },
    };
    const client = createChatClient({
      threadId: "history",
      transport: { driver },
    });
    await client.initialized;
    await client.sendMessage("lookup");
    await client.sendMessage("again");

    expect(requests[1]?.input.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "tool",
          toolCallId: "call-1",
          name: "lookup",
          isError: false,
        }),
      ]),
    );
    await client.close();
  });

  it("keeps subscription observation separate from transport", async () => {
    let calls = 0;
    const client = createChatClient({
      threadId: "conversation-3",
      transport: {
        driver: {
          *sendMessages() {
            calls += 1;
            return streamOf([
              { type: EventType.RUN_STARTED, threadId: "c", runId: "r" },
              { type: EventType.RUN_FINISHED, threadId: "c", runId: "r" },
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
    const unsubscribe = client.subscribe(() => undefined);
    await client.initialized;
    expect(calls).toBe(0);
    unsubscribe();
    await client.close();
  });

  it("seals required drivers before initialize", async () => {
    const client = createChatClient({
      threadId: "sealed",
      initialize: function* () {
        yield* ChatTransportPort.installDriver(transport([]));
      },
    });
    await expect(client.initialized).rejects.toMatchObject({
      code: "chat_client_configuration_sealed",
    });
    await client.close();
  });
});
