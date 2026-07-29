import { createToolInventoryEntry } from "@sweatpants/tool-session/tool-inventory";
import { resource, run, type Operation, type Stream } from "effection";
import { createClient, type RedisClientType } from "redis";
import {
  installModelProvider,
  ModelProviderModelContext,
  ToolInventoryContext,
  createToolInventory,
  type AssistantMessage,
  type Model,
  type ModelProviderDriver,
  type ModelProviderStreamRequest,
  type StreamEvent,
} from "@sweatpants/chat-core";
import {
  createInMemoryBufferStore,
  createInMemoryRegistryStore,
  setupDurableStreams,
} from "@sweatpants/durable-chat-runtime/response-streams";
import { createChatApplication } from "@sweatpants/agent-host/server";
import { createCapabilityKeyring } from "@sweatpants/journal-authority";
import {
  createDurableChatHandler,
  createInMemoryProgramDriverJournalStore,
  programDriverSchemaRegistry,
  type ProgramDriverJournalStore,
} from "@sweatpants/durable-chat-runtime/durable-handler";
import { ProgramDriverNativeToolsContext } from "@sweatpants/durable-chat-runtime/program-driver/native-tools";
import type { DurableSemanticRecord } from "@sweatpants/journal-authority";
import type { Json } from "@sweatpants/foundation";
import { createRedisProgramDriverJournalStore } from "../../src/server/program-driver-journal.ts";
import { playTttTool } from "../../src/tools/play-ttt/tool.ts";

/** Public AG-UI frame projected from one durable response line. */
export type PublicEvent = { type: string; [key: string]: unknown };

/** Resume coordinates for one pending elicitation. */
export type ResumeInput = { interruptId: string; position: number };

const model: Model = {
  id: "play-ttt-program-driver-http",
  name: "Play TTT ProgramDriver HTTP",
  api: "test",
  provider: "test",
  reasoning: false,
  input: ["text"],
  contextWindow: 16_000,
  maxTokens: 1_000,
};

/**
 * Durable state plus the observable side-effect counter for one play_ttt
 * conversation. The substrate outlives every runtime placed over it, so a
 * runtime may be discarded and rebuilt exactly as a crashed host would be.
 */
export interface PlayTttSubstrate {
  readonly journalStore: ProgramDriverJournalStore;
  readonly conversationId: string;
  readonly messages: Array<{ id: string; role: string; content: string }>;
  /** Counts real model stream executions across every runtime generation. */
  sampleCount(): number;
  createRuntime(): PlayTttRuntime;
  close(): Promise<void>;
}

/** One replaceable application generation bound to a shared substrate. */
export interface PlayTttRuntime {
  handle(request: Request): Promise<Response>;
  close(): Promise<void>;
}

/** Opens durable state for one play_ttt conversation on the selected backend. */
export async function createPlayTttSubstrate(options: {
  conversationId: string;
}): Promise<PlayTttSubstrate> {
  let sampleCount = 0;
  const driver: ModelProviderDriver = {
    *stream(request): Operation<Stream<StreamEvent, AssistantMessage>> {
      sampleCount += 1;
      return completedStream(sampleMessage(request, sampleCount));
    },
    *sample(): Operation<AssistantMessage> {
      throw new Error("ProgramRuntime must use the streaming model seam");
    },
  };
  const keyring = createCapabilityKeyring("play-ttt-http", [
    { keyId: "test-v1", secret: "play-ttt-http-program-driver-key!!" },
  ]);
  let redisClient: RedisClientType | undefined;
  if (process.env["PROGRAM_DRIVER_ACCEPTANCE_REDIS"] === "1") {
    redisClient = createClient({ url: requiredRedisUrl() }) as RedisClientType;
    await redisClient.connect();
  }
  const journalStore = redisClient
    ? createRedisProgramDriverJournalStore(redisClient, keyring)
    : createInMemoryProgramDriverJournalStore({
        keyring,
        schemaRegistry: programDriverSchemaRegistry(playTttTool.artifacts.catalog),
      });

  // Durable stream state belongs to the substrate, not to one runtime
  // generation. A real deployment shares these stores across hosts; keeping
  // them per-runtime would make reconnect fail for harness reasons alone.
  const bufferStore = createInMemoryBufferStore<string>();
  const registryStore = createInMemoryRegistryStore();

  return {
    journalStore,
    conversationId: uniqueConversationId(options.conversationId),
    messages: [{ id: "user:http-ttt", role: "user", content: "Play tic-tac-toe" }],
    sampleCount: () => sampleCount,
    createRuntime() {
      const application = createApplication(driver, journalStore, bufferStore, registryStore);
      return {
        handle: (request: Request) => application.handle(request),
        close: () => application.close(),
      };
    },
    async close() {
      if (redisClient?.isOpen) {
        await redisClient.disconnect();
      }
    },
  };
}

/** Builds one chat application generation over shared durable state. */
function createApplication(
  driver: ModelProviderDriver,
  journalStore: ProgramDriverJournalStore,
  bufferStore: ReturnType<typeof createInMemoryBufferStore<string>>,
  registryStore: ReturnType<typeof createInMemoryRegistryStore>,
) {
  const handler = createDurableChatHandler({
    programDriverJournalStore: journalStore,
    maxToolIterations: 5,
    setup: function* () {
      yield* installModelProvider(driver);
      yield* ModelProviderModelContext.set(model);
    },
  });
  return createChatApplication({
    handler,
    setup: function* () {
      yield* setupDurableStreams({ bufferStore, registryStore });
      yield* ToolInventoryContext.set(createToolInventory([createToolInventoryEntry(playTttTool)]));
      yield* ProgramDriverNativeToolsContext.set({
        bindings: new Map([
          [
            playTttTool.name,
            {
              publicName: playTttTool.name,
              tool: playTttTool,
              route: { driverKind: "program" },
            },
          ],
        ]),
        drivers: [],
        effects: [],
      });
    },
  });
}

function sampleMessage(request: ModelProviderStreamRequest, sequence: number): AssistantMessage {
  const toolNames = request.context.tools?.map((tool) => tool.name) ?? [];
  if (toolNames.includes("play_offensive")) {
    return {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: `strategy-${sequence}`,
          name: "play_offensive",
          arguments: { reasoning: "Use the first available position" },
        },
      ],
      stopReason: "toolUse",
    };
  }
  if (request.options?.responseFormat) {
    const parsed = { cell: firstEmptyPosition(request) };
    return {
      role: "assistant",
      content: [{ type: "text", text: JSON.stringify(parsed) }],
      stopReason: "stop",
    };
  }
  const hasToolResult = request.context.messages.some((message) => message.role === "toolResult");
  if (!hasToolResult) {
    return {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call-http-play-ttt",
          name: playTttTool.name,
          arguments: {},
        },
      ],
      stopReason: "toolUse",
    };
  }
  return {
    role: "assistant",
    content: [{ type: "text", text: "Game complete." }],
    stopReason: "stop",
  };
}

function firstEmptyPosition(request: ModelProviderStreamRequest): number {
  const serialized = JSON.stringify(request.context.messages);
  const match = /Empty positions:\s*([0-8](?:,\s*[0-8])*)/.exec(serialized);
  const first = match?.[1]?.split(",")[0];
  return first === undefined ? 0 : Number(first);
}

function completedStream(message: AssistantMessage): Stream<StreamEvent, AssistantMessage> {
  return resource(function* (provide) {
    yield* provide({
      *next(): Operation<IteratorResult<StreamEvent, AssistantMessage>> {
        return { done: true, value: message };
      },
    });
  });
}

/** Posts one public chat request and projects its durable response frames. */
export async function post(
  handler: (request: Request) => Promise<Response>,
  conversationId: string,
  messages: Array<{ id: string; role: string; content: string }>,
  resume?: ResumeInput,
): Promise<PublicEvent[]> {
  const response = await handler(
    new Request(`http://localhost/chat?conversationId=${encodeURIComponent(conversationId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages,
        enabledTools: true,
        ...(resume
          ? {
              resume: [
                {
                  interruptId: resume.interruptId,
                  status: "resolved",
                  payload: { action: "accept", content: { position: resume.position } },
                },
              ],
              elicitResponses: [
                {
                  sessionId: "call-http-play-ttt",
                  callId: "call-http-play-ttt",
                  toolName: playTttTool.name,
                  elicitId: resume.interruptId,
                  result: { action: "accept", content: { position: resume.position } },
                },
              ],
            }
          : {}),
      }),
    }),
  );
  return (await response.text()).split("\n").filter(Boolean).map(parsePublicFrame);
}

/**
 * Posts one public chat request and abandons its response stream after
 * `frameBudget` frames, aborting the request signal. This is the outside-in
 * shape of a host that disappears mid-activation: the client stops reading and
 * the transport drops while durable work is still in flight.
 */
export async function postAndAbandon(
  handler: (request: Request) => Promise<Response>,
  conversationId: string,
  messages: Array<{ id: string; role: string; content: string }>,
  frameBudget: number,
  resume?: ResumeInput,
): Promise<{ frames: PublicEvent[]; aborted: boolean }> {
  const controller = new AbortController();
  const response = await handler(
    buildChatRequest(conversationId, messages, resume, controller.signal),
  );
  const body = response.body;
  if (!body) {
    const frames = (await response.text()).split("\n").filter(Boolean).map(parsePublicFrame);
    return { frames, aborted: false };
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const frames: PublicEvent[] = [];
  let buffered = "";
  let aborted = false;
  try {
    while (frames.length < frameBudget) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      buffered += decoder.decode(chunk.value, { stream: true });
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        if (line) {
          frames.push(parsePublicFrame(line));
        }
      }
    }
    if (frames.length >= frameBudget) {
      aborted = true;
      controller.abort();
      await reader.cancel().catch(() => undefined);
    }
  } catch {
    aborted = true;
  }
  return { frames, aborted };
}

function buildChatRequest(
  conversationId: string,
  messages: Array<{ id: string; role: string; content: string }>,
  resume: ResumeInput | undefined,
  signal?: AbortSignal,
): Request {
  return new Request(`http://localhost/chat?conversationId=${encodeURIComponent(conversationId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    ...(signal ? { signal } : {}),
    body: JSON.stringify({
      messages,
      enabledTools: true,
      ...(resume
        ? {
            resume: [
              {
                interruptId: resume.interruptId,
                status: "resolved",
                payload: { action: "accept", content: { position: resume.position } },
              },
            ],
            elicitResponses: [
              {
                sessionId: "call-http-play-ttt",
                callId: "call-http-play-ttt",
                toolName: playTttTool.name,
                elicitId: resume.interruptId,
                result: { action: "accept", content: { position: resume.position } },
              },
            ],
          }
        : {}),
    }),
  });
}

/**
 * Reattaches to an existing conversation without submitting new user input.
 * This is the client's recovery path after a lost response stream: durable
 * emissions are replayed so the pending interrupt can be recovered.
 */
export async function reattach(
  handler: (request: Request) => Promise<Response>,
  conversationId: string,
): Promise<PublicEvent[]> {
  const response = await handler(
    new Request(`http://localhost/chat?conversationId=${encodeURIComponent(conversationId)}`, {
      method: "GET",
    }),
  );
  return (await response.text()).split("\n").filter(Boolean).map(parsePublicFrame);
}

function parsePublicFrame(line: string): PublicEvent {
  const value: unknown = JSON.parse(line);
  if (!isUnknownRecord(value) || !isUnknownRecord(value["event"])) {
    throw new Error("Invalid durable response frame");
  }
  const event = value["event"];
  if (typeof event["type"] !== "string") {
    throw new Error("Durable response event has no type");
  }
  return event;
}

/** Extracts the first pending public interrupt from one response batch. */
export function publicInterrupt(events: PublicEvent[]): { id: string } | undefined {
  for (const event of events) {
    if (event.type !== "RUN_FINISHED" || !isUnknownRecord(event["outcome"])) {
      continue;
    }
    const interrupts = event["outcome"]["interrupts"];
    if (!Array.isArray(interrupts) || !isUnknownRecord(interrupts[0])) {
      continue;
    }
    const id = interrupts[0]["id"];
    if (typeof id === "string") {
      return { id };
    }
  }
  return undefined;
}

/** Reads the durable semantic journal for one conversation. */
export async function readJournal(
  store: ProgramDriverJournalStore,
  conversationId: string,
): Promise<DurableSemanticRecord[]> {
  const journal = await run(() => store.open(conversationId));
  return await run(() => journal.readJournal(conversationId));
}

/** Chooses the next board position answering the newest unresolved elicitation. */
export function responsePosition(records: DurableSemanticRecord[]): number {
  const resolved = new Set(
    records.flatMap((entry) =>
      entry.payload.type === "PullResolved" ? [entry.payload.pullId] : [],
    ),
  );
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const payload = records[index]?.payload;
    if (
      payload?.type !== "PullRequested" ||
      payload.descriptor.kind !== "elicit" ||
      resolved.has(payload.pullId)
    ) {
      continue;
    }
    const context = payload.descriptor.context;
    if (containsGameOver(context)) {
      return -1;
    }
    const board = findBoard(context);
    const position = board?.findIndex((cell) => cell === null) ?? 0;
    return position >= 0 ? position : -1;
  }
  throw new Error("No pending play_ttt elicitation");
}

function containsGameOver(value: Json | undefined): boolean {
  if (Array.isArray(value)) {
    return value.some(containsGameOver);
  }
  if (isJsonRecord(value)) {
    return value["gameOver"] === true || Object.values(value).some(containsGameOver);
  }
  return false;
}

function findBoard(value: Json | undefined): Json[] | undefined {
  if (Array.isArray(value)) {
    if (
      value.length === 9 &&
      value.every((cell) => cell === null || cell === "X" || cell === "O")
    ) {
      return value;
    }
    for (const child of value) {
      const board = findBoard(child);
      if (board) {
        return board;
      }
    }
  } else if (isJsonRecord(value)) {
    for (const child of Object.values(value)) {
      const board = findBoard(child);
      if (board) {
        return board;
      }
    }
  }
  return undefined;
}

function requiredRedisUrl(): string {
  const value = process.env["REDIS_URL"];
  if (!value) {
    throw new Error("REDIS_URL is required for Redis ProgramRuntime acceptance");
  }
  return value;
}

function isJsonRecord(value: Json | undefined): value is Record<string, Json> {
  return (
    value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value)
  );
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Namespaces a conversation so repeated runs never inherit durable state.
 * In-memory stores are fresh per run; Redis is not, and a colliding id silently
 * replays a previous run's journal into the current assertions.
 */
function uniqueConversationId(base: string): string {
  return `${base}-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
