import { resource, run, type Operation, type Stream } from "effection";
import type { RuntimeTool } from "@sweatpants/core";
import {
  ModelProviderContext,
  ModelProviderModelContext,
  ToolInventoryContext,
  ToolRuntimeContext,
  createToolInventory,
  createToolInventoryEntry,
  type AssistantMessage,
  type Model,
  type ModelProviderDriver,
  type ModelProviderStreamRequest,
  type StreamEvent,
  type ToolRuntime,
} from "@sweatpants/framework/chat";
import {
  createInMemoryBufferStore,
  createInMemoryRegistryStore,
  setupDurableStreams,
} from "@sweatpants/framework/chat/durable-streams";
import {
  ProgramDriverForeignEffectsContext,
  createCapabilityKeyring,
  createChatApplication,
  createDurableChatHandler,
  createInMemoryProgramDriverJournalStore,
  type ProgramDriverJournalStore,
} from "@sweatpants/framework/server";
import {
  createInMemoryToolSessionStore,
  createToolSessionForeignEffectRegistrations,
  createToolSessionRegistry,
} from "@sweatpants/tool-runtime-local";
import type { DurableSemanticRecord } from "@sweatpants/session-contract";
import { bookFlightTool } from "../../src/tools/book-flight/tool.ts";

/** Public AG-UI frame projected from one durable response line. */
export type PublicEvent = { type: string; [key: string]: unknown };

/** Resume coordinates plus the elicitation answer being submitted. */
export type ResumeInput = {
  interruptId: string;
  result: { action: string; content: unknown };
  /** Tool call the elicitation belongs to; retries allocate a new call id. */
  callId: string;
};

const model: Model = {
  id: "book-flight-foreign",
  name: "Book Flight foreign boundary",
  api: "test",
  provider: "test",
  reasoning: false,
  input: ["text"],
  contextWindow: 16_000,
  maxTokens: 1_000,
};

/**
 * Durable state for one book_flight conversation. `book_flight` is a
 * ToolSession-native tool, so it crosses the foreign adapter boundary and its
 * journal contains `foreign.tool.start` / `foreign.tool.continue` — the two
 * effects declared `unsafe`.
 *
 * Every store lives on the substrate rather than on a runtime generation,
 * exactly as a deployment shares Redis across hosts. A runtime may therefore be
 * discarded and rebuilt to model host loss without losing durable state.
 */
export interface BookFlightSubstrate {
  readonly journalStore: ProgramDriverJournalStore;
  readonly conversationId: string;
  readonly messages: Array<{ id: string; role: string; content: string }>;
  createRuntime(): BookFlightRuntime;
  close(): Promise<void>;
}

/** One replaceable application generation bound to a shared substrate. */
export interface BookFlightRuntime {
  handle(request: Request): Promise<Response>;
  close(): Promise<void>;
}

/** Opens durable state for one book_flight conversation on the local substrate. */
export async function createBookFlightSubstrate(options: {
  conversationId: string;
}): Promise<BookFlightSubstrate> {
  let sampleIndex = 0;
  const driver: ModelProviderDriver = {
    stream(request): Stream<StreamEvent, AssistantMessage> {
      sampleIndex += 1;
      return completedStream(sampleMessage(request, sampleIndex));
    },
    *sample(): Operation<AssistantMessage> {
      throw new Error("ProgramRuntime must use the streaming model seam");
    },
  };
  const keyring = createCapabilityKeyring("book-flight-foreign", [
    { keyId: "test-v1", secret: "book-flight-foreign-program-driver-key" },
  ]);
  const journalStore = createInMemoryProgramDriverJournalStore({ keyring });

  // Shared durable state: journal, stream buffers, and foreign ToolSession
  // continuations all outlive any single runtime generation.
  const bufferStore = createInMemoryBufferStore<string>();
  const registryStore = createInMemoryRegistryStore();
  const toolSessionStore = createInMemoryToolSessionStore();

  const fallbackRuntime: ToolRuntime = {
    id: "foreign-context-only",
    *execute(): Operation<never> {
      throw new Error("ToolRuntime fallback must not execute the ToolSession-native tool");
    },
    *resume(): Operation<never> {
      throw new Error("ToolRuntime fallback must not resume the ToolSession-native tool");
    },
    *abort(): Operation<void> {},
  };

  return {
    journalStore,
    conversationId: uniqueConversationId(options.conversationId),
    messages: [{ id: "user:http-book", role: "user", content: "Book NYC to LAX" }],
    createRuntime() {
      const handler = createDurableChatHandler({
        programDriverJournalStore: journalStore,
        maxToolIterations: 5,
        setup: function* () {
          yield* ModelProviderContext.set(driver);
          yield* ModelProviderModelContext.set(model);
        },
      });
      const application = createChatApplication({
        handler,
        setup: function* () {
          yield* setupDurableStreams({ bufferStore, registryStore });
          const registry = yield* createToolSessionRegistry(toolSessionStore, {});
          yield* ToolInventoryContext.set(
            createToolInventory([createToolInventoryEntry(bookFlightTool)]),
          );
          yield* ToolRuntimeContext.set(fallbackRuntime);
          yield* ProgramDriverForeignEffectsContext.set(
            createToolSessionForeignEffectRegistrations({
              registry,
              tools: new Map<string, RuntimeTool>([[bookFlightTool.name, bookFlightTool]]),
            }),
          );
        },
      });
      return {
        handle: (request: Request) => application.handle(request),
        close: () => application.close(),
      };
    },
    async close() {},
  };
}

/**
 * Scripted model behaviour.
 *
 * The one non-trivial rule: when the newest tool result reports an error, the
 * model restarts the booking rather than giving up. That is the whole point of
 * surfacing a foreign-tool failure as an ordinary result — the conversation
 * decides what to do about it.
 */
function sampleMessage(
  request: ModelProviderStreamRequest,
  sequence: number,
): AssistantMessage {
  if (lastToolResultFailed(request)) {
    return bookFlightCall(`call-retry-${sequence}`);
  }
  if (sequence === 1) {
    return bookFlightCall("call-http-book-flight");
  }
  if (sequence === 2) {
    return {
      role: "assistant",
      content: [{ type: "text", text: "Travel light and arrive early." }],
      stopReason: "stop",
    };
  }
  return {
    role: "assistant",
    content: [{ type: "text", text: "Your flight is booked." }],
    stopReason: "stop",
  };
}

function bookFlightCall(id: string): AssistantMessage {
  return {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id,
        name: bookFlightTool.name,
        arguments: { from: "NYC", destination: "LAX" },
      },
    ],
    stopReason: "toolUse",
  };
}

/** True when the most recent tool result carries an error status. */
function lastToolResultFailed(request: ModelProviderStreamRequest): boolean {
  const messages = request.context.messages;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "toolResult" && message?.role !== "tool") {
      continue;
    }
    return (message as { isError?: boolean }).isError === true;
  }
  return false;
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
              { interruptId: resume.interruptId, status: "resolved", payload: resume.result },
            ],
            elicitResponses: [
              {
                sessionId: resume.callId,
                callId: resume.callId,
                toolName: bookFlightTool.name,
                elicitId: resume.interruptId,
                result: resume.result,
              },
            ],
          }
        : {}),
    }),
  });
}

/** Posts one public chat request and projects its durable response frames. */
export async function post(
  handler: (request: Request) => Promise<Response>,
  conversationId: string,
  messages: Array<{ id: string; role: string; content: string }>,
  resume?: ResumeInput,
): Promise<PublicEvent[]> {
  const response = await handler(buildChatRequest(conversationId, messages, resume));
  return (await response.text()).split("\n").filter(Boolean).map(parsePublicFrame);
}

/** Posts a request and abandons its response stream after `frameBudget` frames. */
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
    return {
      frames: (await response.text()).split("\n").filter(Boolean).map(parsePublicFrame),
      aborted: false,
    };
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

/** Reattaches to an existing conversation without submitting new user input. */
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
  if (!isRecord(value) || !isRecord(value["event"]) || typeof value["event"]["type"] !== "string") {
    throw new Error("Invalid durable response frame");
  }
  return value["event"] as PublicEvent;
}

/** Extracts the first pending public interrupt from one response batch. */
export function publicInterrupt(
  events: PublicEvent[],
): { id: string; message: string } | undefined {
  for (const event of events) {
    if (event.type !== "RUN_FINISHED" || !isRecord(event["outcome"])) {
      continue;
    }
    const interrupts = event["outcome"]["interrupts"];
    if (!Array.isArray(interrupts) || !isRecord(interrupts[0])) {
      continue;
    }
    const id = interrupts[0]["id"];
    const message = interrupts[0]["message"];
    if (typeof id === "string" && typeof message === "string") {
      return { id, message };
    }
  }
  return undefined;
}

/** Answers one book_flight elicitation based on the prompt it asked. */
export function answerFor(message: string): { action: string; content: unknown } {
  if (message.includes("seat")) {
    return { action: "accept", content: { row: 2, seat: "A" } };
  }
  return { action: "accept", content: { flightId: "FL001" } };
}

/**
 * Newest tool call id observed in one response batch. A retry after a failed
 * foreign session allocates a fresh call id, so resume traffic must follow it
 * rather than assume the original.
 */
export function latestToolCallId(events: PublicEvent[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "TOOL_CALL_START" && typeof event["toolCallId"] === "string") {
      return event["toolCallId"];
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

function isRecord(value: unknown): value is Record<string, unknown> {
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
