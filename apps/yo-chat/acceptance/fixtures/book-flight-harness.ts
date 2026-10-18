import {
  createToolInventory,
  createToolInventoryEntry,
  installToolInventory,
  installToolRuntime,
  type ToolRuntime,
} from "@sweatpants/tool-runtime";
import { resource, run, type Operation, type Stream } from "effection";
import type { RuntimeTool } from "@sweatpants/agent-sdk";
import {
  installModelProvider,
  ModelProviderModelContext,
  type Model,
  type ModelProviderDriver,
  type ModelProviderStreamRequest,
  type ModelResponse,
  type ModelStreamEvent,
} from "@sweatpants/model-provider";
import {
  createInMemoryBufferStore,
  createInMemoryRegistryStore,
  setupDurableStreams,
} from "@sweatpants/durable-chat-runtime/response-streams";
import { createChatApplication } from "@sweatpants/agent-host/server";
import { createCapabilityKeyring } from "@sweatpants/journal-authority";
import { createMemoryExecutionStore } from "@sweatpants/journal-authority/memory";
import { createMemoryConversationStore } from "@sweatpants/history-store/memory";
import {
  createDurableChatEndpoints,
  createProgramDriverJournalStore,
  createProjectionTokenKeyring,
  type ProgramDriverJournalStore,
} from "@sweatpants/durable-chat-runtime/durable-handler";
import { ProgramDriverEphemeralEffectsContext } from "@sweatpants/durable-chat-runtime/program-driver/effects";
import { createLocalToolInvocationRuntime } from "@sweatpants/tool-runtime-local";
import { createToolInvocationEphemeralEffectRegistrations } from "@sweatpants/tool-session/execution";
import type { DurableSemanticRecord } from "@sweatpants/journal-authority";
import type { ChatAssistantMessage } from "@sweatpants/chat-contract";
import { bookFlightTool } from "../../src/tools/book-flight/tool.ts";
import { routeNativeChatApplication } from "./native-chat-router.ts";

/** Public AG-UI frame projected from one durable response line. */
export type PublicEvent = { type: string; [key: string]: unknown };

/** Resume coordinates plus the elicitation answer being submitted. */
export type ResumeInput = {
  commandId: string;
  interruptId: string;
  result: { action: string; content?: unknown };
  /** Tool call the elicitation belongs to; retries allocate a new call id. */
  callId: string;
  parentRunId?: string;
  basisRevision: string;
  logicalTurnId: string;
  executionId: string;
};

const commandLifetimes = new Map<string, { issuedAt: number; expiresAt: number }>();
function commandLifetime(commandId: string): { issuedAt: number; expiresAt: number } {
  const existing = commandLifetimes.get(commandId);
  if (existing) {
    return existing;
  }
  const issuedAt = Date.now();
  const created = { issuedAt, expiresAt: issuedAt + 60_000 };
  commandLifetimes.set(commandId, created);
  return created;
}

const model: Model = {
  id: "book-flight-ephemeral",
  name: "Book Flight ephemeral boundary",
  api: "test",
  provider: "test",
  reasoning: false,
  input: ["text"],
  contextWindow: 16_000,
  maxTokens: 1_000,
};

/**
 * Durable state for one book_flight conversation. `book_flight` is a
 * ToolSession-native tool, so it crosses the ephemeral adapter boundary and its
 * journal contains `ephemeral.tool.start` / `ephemeral.tool.continue` — the two
 * effects declared `unsafe`.
 *
 * Every store lives on the substrate rather than on a runtime generation,
 * exactly as a deployment shares Redis across hosts. A runtime may therefore be
 * gracefully replaced without losing durable state.
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
    *stream(request): Operation<Stream<ModelStreamEvent, ModelResponse>> {
      sampleIndex += 1;
      return completedStream(sampleMessage(request, sampleIndex));
    },
    *sample(): Operation<ModelResponse> {
      throw new Error("workflow host must use the streaming model seam");
    },
  };
  const keyring = createCapabilityKeyring("book-flight-ephemeral", [
    { keyId: "test-v1", secret: "book-flight-ephemeral-program-driver-key" },
  ]);
  const executionStore = createMemoryExecutionStore();
  const conversationStore = createMemoryConversationStore();
  const journalStore = createProgramDriverJournalStore({ keyring, executionStore });

  // Shared durable state: journal and response buffers outlive each runtime.
  // Foreign local invocation handles are process-local and may be lost.
  const bufferStore = createInMemoryBufferStore<string>();
  const registryStore = createInMemoryRegistryStore();

  const fallbackRuntime: ToolRuntime = {
    *runtimeId() {
      return "ephemeral-context-only";
    },
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
      const endpoints = createDurableChatEndpoints({
        storage: { kind: "custom", executionStore, conversationStore },
        createProgramDriverJournalStore: () => journalStore,
        projectionTokens: createProjectionTokenKeyring("book-flight-harness-window-projection-key"),
        maxToolIterations: 5,
        setup: function* () {
          yield* installModelProvider(driver);
          yield* ModelProviderModelContext.set(model);
        },
      });
      const application = createChatApplication({
        handler: endpoints.postChat,
        setup: function* () {
          yield* setupDurableStreams({ bufferStore, registryStore });
          yield* createLocalToolInvocationRuntime({});
          yield* installToolInventory(
            createToolInventory([createToolInventoryEntry(bookFlightTool)]),
          );
          yield* installToolRuntime(fallbackRuntime);
          yield* ProgramDriverEphemeralEffectsContext.set(
            createToolInvocationEphemeralEffectRegistrations({
              tools: new Map<string, RuntimeTool>([[bookFlightTool.name, bookFlightTool]]),
            }),
          );
        },
      });
      return routeNativeChatApplication(application, endpoints);
    },
    async close() {},
  };
}

/**
 * Scripted model behaviour.
 *
 * The one non-trivial rule: when the newest tool result reports an error, the
 * model restarts the booking rather than giving up. That is the whole point of
 * surfacing a ephemeral-tool failure as an ordinary result — the conversation
 * decides what to do about it.
 */
function sampleMessage(request: ModelProviderStreamRequest, sequence: number): ModelResponse {
  if (lastToolResultFailed(request)) {
    return bookFlightCall(`call-retry-${sequence}`);
  }
  if (sequence === 1) {
    return bookFlightCall("call-http-book-flight");
  }
  if (sequence === 2) {
    return modelResponse(
      { role: "assistant", content: [{ type: "text", text: "Travel light and arrive early." }] },
      "stop",
    );
  }
  return modelResponse(
    { role: "assistant", content: [{ type: "text", text: "Your flight is booked." }] },
    "stop",
  );
}

function bookFlightCall(id: string): ModelResponse {
  return modelResponse(
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCall: {
            id,
            name: bookFlightTool.name,
            input: { from: "NYC", destination: "LAX" },
            thoughtSignature: null,
          },
        },
      ],
    },
    "toolUse",
  );
}

/** True when the most recent tool result carries an error status. */
function lastToolResultFailed(request: ModelProviderStreamRequest): boolean {
  const messages = request.context.messages;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "tool") {
      continue;
    }
    return message.isError;
  }
  return false;
}

function modelResponse(message: ChatAssistantMessage, stopReason: string): ModelResponse {
  return {
    message,
    source: null,
    usage: null,
    stopReason,
    responseId: null,
    errorMessage: null,
  };
}

function completedStream(message: ModelResponse): Stream<ModelStreamEvent, ModelResponse> {
  return resource(function* (provide) {
    yield* provide({
      *next(): Operation<IteratorResult<ModelStreamEvent, ModelResponse>> {
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
  const runId = crypto.randomUUID();
  return new Request(`http://localhost/chat?conversationId=${encodeURIComponent(conversationId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({
      command: resume
        ? {
            type: "respond-to-elicit",
            commandId: resume.commandId,
            ...commandLifetime(resume.commandId),
            basisRevision: resume.basisRevision,
            logicalTurnId: resume.logicalTurnId,
            executionId: resume.executionId,
            interruptId: resume.interruptId,
            status: resume.result.action === "cancel" ? "cancelled" : "resolved",
            payload: resume.result,
          }
        : {
            type: "send-message",
            commandId: runId,
            ...commandLifetime(runId),
            basisRevision: null,
            messageId: messages.at(-1)?.id ?? runId,
          },
      clientId: "book-flight-acceptance",
      conversationId,
      runId,
      /* CONDITIONAL-SPREAD: Omit absent userMessage from chat requests and authored tool results; explicit undefined is not a portable JSON value. */
      ...(!resume && messages.at(-1) ? { userMessage: messages.at(-1) } : {}),
      state: {},
      context: [],
      forwardedProps: {},
      /* CONDITIONAL-SPREAD: Omit absent parentRunId from chat requests and authored tool results; explicit undefined is not a portable JSON value. */
      ...(resume?.parentRunId ? { parentRunId: resume.parentRunId } : {}),
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

/** Posts a request and disconnects its response stream after `frameBudget` frames. */
export async function postAndDisconnect(
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
    new Request(`http://localhost/api/chat/${encodeURIComponent(conversationId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId: "book-flight-acceptance", conversationId }),
    }),
  );
  return (await response.text()).split("\n").filter(Boolean).map(parsePublicFrame);
}

function parsePublicFrame(line: string): PublicEvent {
  const value: unknown = JSON.parse(line);
  if (!isRecord(value) || typeof value["type"] !== "string") {
    throw new Error("Invalid durable response frame");
  }
  return value as PublicEvent;
}

/** Extracts the first pending public interrupt from one response batch. */
export function publicInterrupt(events: PublicEvent[]):
  | {
      id: string;
      message: string;
      parentRunId?: string;
      basisRevision: string;
      logicalTurnId: string;
      executionId: string;
    }
  | undefined {
  const authority = events.findLast(
    (event) => event.type === "sweatpants.conversation-authority.v1",
  )?.["authority"];
  if (!isRecord(authority)) {
    return undefined;
  }
  const basisRevision = authority["revision"];
  const logicalTurnId = authority["activeLogicalTurnId"];
  const executionId = authority["activeExecutionId"];
  if (
    authority["state"] !== "parked" ||
    typeof basisRevision !== "string" ||
    typeof logicalTurnId !== "string" ||
    typeof executionId !== "string"
  ) {
    return undefined;
  }
  const latestWindow = events.findLast(
    (event) => event.type === "sweatpants.conversation-window.v1",
  );
  for (const event of events) {
    if (
      event === latestWindow &&
      event.type === "sweatpants.conversation-window.v1" &&
      Array.isArray(event["hotRoots"])
    ) {
      for (const root of [...event["hotRoots"]].reverse()) {
        if (
          !isRecord(root) ||
          root["kind"] !== "activity-subtree" ||
          !Array.isArray(root["nodes"])
        ) {
          continue;
        }
        for (const snapshot of [...root["nodes"]].reverse()) {
          const activity = isRecord(snapshot) ? snapshot["event"] : undefined;
          const content = isRecord(activity) ? activity["content"] : undefined;
          const node = isRecord(content) ? content["node"] : undefined;
          const data = isRecord(node) ? node["publicData"] : undefined;
          if (
            isRecord(node) &&
            node["kind"] === "elicit" &&
            node["state"] === "pending" &&
            isRecord(data) &&
            typeof data["elicitId"] === "string" &&
            typeof data["message"] === "string"
          ) {
            return {
              id: data["elicitId"],
              message: data["message"],
              basisRevision,
              logicalTurnId,
              executionId,
            };
          }
        }
      }
    }
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
      const runId = event["runId"];
      return {
        id,
        message,
        basisRevision,
        logicalTurnId,
        executionId,
        /* CONDITIONAL-SPREAD: Omit absent parentRunId from chat requests and authored tool results; explicit undefined is not a portable JSON value. */
        ...(typeof runId === "string" ? { parentRunId: runId } : {}),
      };
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
 * ephemeral session allocates a fresh call id, so resume traffic must follow it
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
  return await run(function* () {
    return yield* store.withJournal(conversationId, (journal) =>
      journal.readJournal(conversationId),
    );
  });
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
