import { EventType } from "@ag-ui/core";
import { call, resource, type Operation, type Stream } from "effection";
import { describe, expect, it } from "vitest";
import {
  CONVERSATION_AUTHORITY_FRAME_TYPE,
  ChatTransportPort,
  createChatClient,
  createChatRuntime,
  type ChatInteractionCompletion,
  type ChatInteractionRequest,
  type ChatInteractionRuntime,
  type ChatReconnectRequest,
  type ChatTransportRequest,
  type AGUIEvent,
  type ConversationStreamEvent,
  type ChatTransportContract,
} from "./index.ts";

const authorityRevisions = new Map<string, bigint>();

function nextAuthorityRevision(conversationId: string): string {
  const next = (authorityRevisions.get(conversationId) ?? 0n) + 1n;
  authorityRevisions.set(conversationId, next);
  return next.toString(10);
}

function observeAuthorityRevision(conversationId: string, revision: string | null): void {
  if (revision === null) return;
  const value = BigInt(revision);
  if (value > (authorityRevisions.get(conversationId) ?? 0n)) {
    authorityRevisions.set(conversationId, value);
  }
}

function withAuthority(events: readonly AGUIEvent[]): readonly ConversationStreamEvent[] {
  const run = events.find(
    (event) => event.type === EventType.RUN_STARTED || event.type === EventType.RUN_FINISHED,
  );
  if (!run || !("threadId" in run)) {
    return events;
  }
  const terminalIndex = events.findIndex(
    (event) => event.type === EventType.RUN_FINISHED || event.type === EventType.RUN_ERROR,
  );
  const running: ConversationStreamEvent = {
    type: CONVERSATION_AUTHORITY_FRAME_TYPE,
    authority: {
      conversationId: run.threadId,
      revision: nextAuthorityRevision(run.threadId),
      state: "running",
      activeLogicalTurnId: run.runId,
      activeExecutionId: `execution:${run.runId}`,
      latestCompletedExecutionId: null,
    },
  };
  if (terminalIndex < 0) {
    return [running, ...events];
  }
  const terminal = events[terminalIndex]!;
  const terminalAuthority: ConversationStreamEvent = {
    type: CONVERSATION_AUTHORITY_FRAME_TYPE,
    authority:
      terminal.type === EventType.RUN_FINISHED && terminal.outcome?.type === "interrupt"
        ? {
            conversationId: run.threadId,
            revision: nextAuthorityRevision(run.threadId),
            state: "parked",
            activeLogicalTurnId: run.runId,
            activeExecutionId: `execution:${run.runId}`,
            latestCompletedExecutionId: null,
          }
        : {
            conversationId: run.threadId,
            revision: nextAuthorityRevision(run.threadId),
            state: "idle",
            activeLogicalTurnId: null,
            activeExecutionId: null,
            latestCompletedExecutionId: `execution:${run.runId}`,
          },
  };
  return [
    running,
    ...events.slice(0, terminalIndex),
    terminalAuthority,
    ...events.slice(terminalIndex),
  ];
}

function runningAuthorityFrame(
  conversationId: string,
  revision: string,
  runId: string,
): ConversationStreamEvent {
  observeAuthorityRevision(conversationId, revision);
  return {
    type: CONVERSATION_AUTHORITY_FRAME_TYPE,
    authority: {
      conversationId,
      revision,
      state: "running",
      activeLogicalTurnId: runId,
      activeExecutionId: `execution:${runId}`,
      latestCompletedExecutionId: null,
    },
  };
}

function idleAuthorityFrame(
  conversationId: string,
  revision: string | null,
): ConversationStreamEvent {
  observeAuthorityRevision(conversationId, revision);
  return {
    type: CONVERSATION_AUTHORITY_FRAME_TYPE,
    authority: {
      conversationId,
      revision,
      state: "idle",
      activeLogicalTurnId: null,
      activeExecutionId: null,
      latestCompletedExecutionId: null,
    },
  };
}

function frameStream(
  frames: readonly ConversationStreamEvent[],
): Stream<ConversationStreamEvent, void> {
  return (function* () {
    let index = 0;
    return {
      next(): Operation<IteratorResult<ConversationStreamEvent, void>> {
        return (function* () {
          if (index >= frames.length) {
            return { done: true, value: undefined };
          }
          return { done: false, value: frames[index++] };
        })();
      },
    };
  })();
}

function streamOf(events: readonly AGUIEvent[]): Stream<ConversationStreamEvent, void> {
  return frameStream(withAuthority(events));
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

function gatedStream(
  events: readonly AGUIEvent[],
  gate: Promise<void>,
): Stream<ConversationStreamEvent, void> {
  const frames = withAuthority(events);
  return resource(function* (provide) {
    let released = false;
    let index = 0;
    yield* provide({
      *next(): Operation<IteratorResult<ConversationStreamEvent, void>> {
        if (!released) {
          released = true;
          yield* call(() => gate);
        }
        if (index >= frames.length) {
          return { done: true, value: undefined };
        }
        return { done: false, value: frames[index++]! };
      },
    });
  });
}

function gatedFrames(
  frames: readonly ConversationStreamEvent[],
  gate: Promise<void>,
): Stream<ConversationStreamEvent, void> {
  return resource(function* (provide) {
    let released = false;
    let index = 0;
    yield* provide({
      *next(): Operation<IteratorResult<ConversationStreamEvent, void>> {
        if (!released) {
          released = true;
          yield* call(() => gate);
        }
        if (index >= frames.length) {
          return { done: true, value: undefined };
        }
        return { done: false, value: frames[index++]! };
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
  it("does not hydrate a conversation explicitly declared new", async () => {
    let reconnects = 0;
    const driver: ChatTransportContract = {
      *sendMessages(request) {
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
      },
      *reconnectToStream() {
        reconnects += 1;
        return null;
      },
      *disconnect() {
        return;
      },
    };
    const client = createChatClient({
      threadId: "explicit-new-conversation",
      initialConversation: "new",
      connection: driver,
    });
    await client.initialized;
    expect(reconnects).toBe(0);
    expect(client.getSnapshot()).toMatchObject({
      canSendMessage: true,
      authority: { state: "idle", revision: null },
    });
    await client.sendMessage("first command");
    await client.close();
  });

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
        if ((init?.method ?? "GET") === "GET") {
          return new Response(null, { status: 404 });
        }
        if (typeof init?.body !== "string") {
          throw new Error("expected JSON request body");
        }
        requestBody = JSON.parse(init.body) as Record<string, unknown>;
        const events = withAuthority([
          { type: EventType.RUN_STARTED, threadId: "fetcher-thread", runId: "run-fetcher" },
          { type: EventType.RUN_FINISHED, threadId: "fetcher-thread", runId: "run-fetcher" },
        ]);
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
      fetcher: async (_input, init) =>
        (init?.method ?? "GET") === "GET"
          ? new Response(null, { status: 404 })
          : new Response("upstream unavailable", { status: 500 }),
    });
    await failedTransport.initialized;
    await expect(failedTransport.sendMessage("fail")).rejects.toMatchObject({
      code: "chat_transport_failed",
    });
    await failedTransport.close();

    const malformedTransport = createChatClient({
      threadId: "malformed-event",
      fetcher: async (_input, init) =>
        (init?.method ?? "GET") === "GET"
          ? new Response(null, { status: 404 })
          : new Response('{"type":"TEXT_MESSAGE_CONTENT"}\n', {
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
            event: idleAuthorityFrame(body.input.threadId, String(start + 1)),
          },
          {
            lsn: start + 2,
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
      const parsedUrl = new URL(url);
      const threadId = parsedUrl.searchParams.get("conversationId") ?? "unknown";
      if (!parsedUrl.searchParams.has("offset")) {
        return new Response(null, { status: 404 });
      }
      const start = threadId === "thread-a" ? 13 : 23;
      const events = [
        {
          lsn: start,
          event: { type: EventType.RUN_STARTED, threadId, runId: `reconnect-${start}` },
        },
        {
          lsn: start + 1,
          event: idleAuthorityFrame(threadId, String(start + 1)),
        },
        {
          lsn: start + 2,
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
      null,
      null,
      "12",
      "22",
    ]);
    await first.close();
    await second.close();
    await runtime.close();
  });

  it("accepts terminal-free HTTP hydration only when it carries authority", async () => {
    const requests: Array<{ readonly url: string; readonly method: string }> = [];
    let reconnectCount = 0;
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = init?.method ?? "GET";
      requests.push({ url, method });
      if (method === "POST") {
        return new Response(
          [
            JSON.stringify({
              lsn: 10,
              event: { type: EventType.RUN_STARTED, threadId: "restart", runId: "initial" },
            }),
            JSON.stringify({
              lsn: 11,
              event: idleAuthorityFrame("restart", "11"),
            }),
            JSON.stringify({
              lsn: 12,
              event: {
                type: EventType.RUN_FINISHED,
                threadId: "restart",
                runId: "initial",
                outcome: { type: "success" },
              },
            }),
          ].join("\n") + "\n",
          { headers: { "content-type": "application/x-ndjson" } },
        );
      }
      if (!new URL(url).searchParams.has("offset")) {
        return new Response(null, { status: 404 });
      }
      reconnectCount += 1;
      const events = [
        { lsn: 13, event: { type: EventType.STATE_SNAPSHOT, snapshot: {} } },
        { lsn: 14, event: idleAuthorityFrame("restart", "14") },
      ];
      return new Response(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`, {
        headers: { "content-type": "application/x-ndjson" },
      });
    };
    const runtime = createChatRuntime({ api: "http://localhost/chat", fetcher });
    const client = runtime.createClient({ threadId: "restart" });
    await Promise.all([runtime.initialized, client.initialized]);
    await client.sendMessage("seed cursor");
    await client.reconnect();

    const reconnects = requests.filter((request) => request.method === "GET");
    expect(reconnectCount).toBe(1);
    expect(reconnects).toHaveLength(2);
    expect(new URL(reconnects[0]!.url).searchParams.has("offset")).toBe(false);
    expect(new URL(reconnects[1]!.url).searchParams.get("offset")).toBe("12");
    await client.close();
    await runtime.close();
  });

  it("accepts terminal-free replay when durable authority is explicit", async () => {
    const reconnects: ChatReconnectRequest[] = [];
    const driver: ChatTransportContract = {
      *sendMessages() {
        return streamOf([]);
      },
      *reconnectToStream(request) {
        reconnects.push(request);
        return frameStream([
          { type: EventType.MESSAGES_SNAPSHOT, messages: [] },
          { type: EventType.STATE_SNAPSHOT, snapshot: {} },
          idleAuthorityFrame(request.threadId, "1"),
        ]);
      },
      *disconnect() {
        return;
      },
    };
    const client = createChatClient({
      threadId: "terminal-free-reconnect",
      connection: driver,
    });
    await client.initialized;
    await client.reconnect();

    expect(reconnects).toHaveLength(2);
    expect(client.getSnapshot()).toMatchObject({
      status: "ready",
      connectionStatus: "disconnected",
    });
    await client.close();
  });

  it("applies typed admission conflict authority without exposing ready", async () => {
    const driver: ChatTransportContract = {
      *sendMessages(request) {
        return frameStream([
          runningAuthorityFrame(request.input.threadId, "2", "winning-run"),
          {
            type: EventType.RUN_ERROR,
            code: "conversation_state_changed",
            message: "Another participant admitted a Turn",
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
    const client = createChatClient({ threadId: "admission-conflict", connection: driver });
    await client.initialized;
    await client.sendMessage("losing command");

    expect(client.getSnapshot()).toMatchObject({
      status: "error",
      canSendMessage: false,
      authority: { state: "running", revision: "2" },
      error: { code: "conversation_state_changed" },
    });
    await client.close();
  });

  it("retains its monotonic authority baseline while a request is synchronizing", async () => {
    const conversationId = "monotonic-authority-baseline";
    const driver: ChatTransportContract = {
      *sendMessages() {
        return frameStream([
          runningAuthorityFrame(conversationId, "4", "stale-run"),
          {
            type: EventType.RUN_ERROR,
            code: "conversation_state_changed",
            message: "stale command",
          },
        ]);
      },
      *reconnectToStream() {
        return frameStream([idleAuthorityFrame(conversationId, "5")]);
      },
      *disconnect() {
        return;
      },
    };
    const client = createChatClient({ threadId: conversationId, connection: driver });
    await client.initialized;
    await client.sendMessage("must not regress");
    expect(client.getSnapshot()).toMatchObject({
      authority: { revision: "5", state: "idle" },
      canSendMessage: true,
      status: "error",
    });
    await client.close();
  });

  it("rejects RUN_FINISHED when durable authority remains active", async () => {
    const driver: ChatTransportContract = {
      *sendMessages(request) {
        return frameStream([
          runningAuthorityFrame(request.input.threadId, "1", request.input.runId),
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
    const client = createChatClient({
      threadId: "terminal-authority-mismatch",
      connection: driver,
    });
    await client.initialized;

    await expect(client.sendMessage("must stay blocked")).rejects.toMatchObject({
      code: "chat_authority_terminal_mismatch",
    });
    expect(client.getSnapshot().canSendMessage).toBe(false);
    expect(client.getSnapshot().authority?.state).toBe("running");
    await client.close();
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

  it("keeps a parked queue client-local and may discard it on close", async () => {
    const requests: ChatTransportRequest[] = [];
    const driver: ChatTransportContract = {
      *sendMessages(request) {
        requests.push(request);
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
      },
      *reconnectToStream() {
        return null;
      },
      *disconnect() {
        return;
      },
    };
    const client = createChatClient({
      threadId: "parked-local-queue-thread",
      queue: "queue",
      connection: driver,
    });
    await client.initialized;
    await client.sendMessage("park");

    const queued = client.sendMessage("local successor");
    await waitForQueue(client, 1);
    expect(requests).toHaveLength(1);
    expect(client.getServerSnapshot().queue).toHaveLength(0);

    await client.close();
    await expect(queued).rejects.toMatchObject({ code: "chat_client_closed" });
    expect(requests).toHaveLength(1);
  });

  it("keeps an interrupt replacement local until terminal cancellation", async () => {
    const activeStarted = deferred<void>();
    const terminalCancellation = deferred<void>();
    const replacementStarted = deferred<void>();
    const requests: ChatTransportRequest[] = [];
    const driver: ChatTransportContract = {
      *sendMessages(request) {
        requests.push(request);
        if (request.command.type === "interrupt-turn") {
          return gatedFrames(
            [
              idleAuthorityFrame(request.input.threadId, "3"),
              {
                type: EventType.RUN_ERROR,
                code: "PROGRAM_CANCELLED",
                message: "Program was cancelled",
              },
            ],
            terminalCancellation.promise,
          );
        }
        if (
          requests.filter((candidate) => candidate.command.type === "send-message").length === 1
        ) {
          return resource(function* (provide) {
            let index = 0;
            yield* provide({
              *next(): Operation<IteratorResult<ConversationStreamEvent, void>> {
                index += 1;
                if (index === 1) {
                  activeStarted.resolve(undefined);
                  return {
                    done: false,
                    value: runningAuthorityFrame(request.input.threadId, "1", request.input.runId),
                  };
                }
                if (index === 2) {
                  yield* call(() => terminalCancellation.promise);
                  return {
                    done: false,
                    value: idleAuthorityFrame(request.input.threadId, "2"),
                  };
                }
                if (index === 3) {
                  return {
                    done: false,
                    value: {
                      type: EventType.RUN_ERROR,
                      code: "PROGRAM_CANCELLED",
                      message: "Program was cancelled",
                    },
                  };
                }
                return { done: true, value: undefined };
              },
            });
          });
        }
        replacementStarted.resolve(undefined);
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
      },
      *reconnectToStream() {
        return null;
      },
      *disconnect() {
        return;
      },
    };
    const client = createChatClient({
      threadId: "interrupt-terminal-thread",
      queue: "interrupt",
      connection: driver,
    });
    await client.initialized;

    const active = client.sendMessage("active");
    await activeStarted.promise;
    await Promise.resolve();
    const replacement = client.sendMessage("replacement");
    await Promise.resolve();
    await Promise.resolve();

    expect(requests).toHaveLength(2);
    const original = requests[0]!;
    const cancellation = requests[1]!;
    expect(cancellation.command.type).toBe("interrupt-turn");
    expect(cancellation.input.runId).not.toBe(original.input.runId);
    expect(cancellation.command.commandId).toBe(cancellation.input.runId);
    expect(
      requests.some((request) =>
        request.input.messages.some(
          (message) => message.role === "user" && message.content === "replacement",
        ),
      ),
    ).toBe(false);

    terminalCancellation.resolve(undefined);
    await replacementStarted.promise;
    await Promise.all([active, replacement]);
    expect(requests).toHaveLength(3);
    expect(requests[2]?.command.type).toBe("send-message");
    await client.close();
  });

  it("rejects rather than drains queued sends after a run error", async () => {
    const release = deferred<void>();
    const driver: ChatTransportContract = {
      *sendMessages(request) {
        return gatedFrames(
          [
            runningAuthorityFrame(request.input.threadId, "1", request.input.runId),
            idleAuthorityFrame(request.input.threadId, "2"),
            {
              type: EventType.RUN_ERROR,
              code: "provider_failed",
              message: "provider failed",
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
      threadId: "queue-run-error",
      initialConversation: "new",
      connection: driver,
    });
    await client.initialized;
    const active = client.sendMessage("active");
    await Promise.resolve();
    const queued = client.sendMessage("must not run");
    release.resolve(undefined);
    await active;
    await expect(queued).rejects.toMatchObject({ code: "provider_failed" });
    expect(client.getSnapshot().queue).toEqual([]);
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
