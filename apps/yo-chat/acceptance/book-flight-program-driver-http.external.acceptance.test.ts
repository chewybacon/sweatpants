import {
  createToolInventory,
  createToolInventoryEntry,
  installToolInventory,
  installToolRuntime,
  type ToolRuntime,
} from "@sweatpants/tool-runtime";
// @vitest-environment node
import { resource, run, type Operation, type Stream } from "effection";
import { describe, expect, it } from "vitest";
import { createClient } from "redis";
import type { RuntimeTool } from "@sweatpants/agent-sdk";
import type { ChatAssistantMessage } from "@sweatpants/chat-contract";
import {
  installModelProvider,
  ModelProviderModelContext,
  type Model,
  type ModelProviderDriver,
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
import {
  createDurableChatHandler,
  createProgramDriverJournalStore,
  createProjectionTokenKeyring,
  type ProgramDriverJournalStore,
} from "@sweatpants/durable-chat-runtime/durable-handler";
import { ProgramDriverEphemeralEffectsContext } from "@sweatpants/durable-chat-runtime/program-driver/effects";
import {
  createLocalToolInvocationRuntime,
  createToolInvocationEphemeralEffectRegistrations,
} from "@sweatpants/tool-runtime-local";
import {
  setupAgentCoreProgramDriverToolRuntime,
  useAgentCoreProgramDriverAcceptance,
} from "./program-driver-agentcore-setup.ts";
import { createRedisProgramDriverJournalStore } from "../src/server/program-driver-journal.ts";
import { bookFlightTool } from "../src/tools/book-flight/tool.ts";

const model: Model = {
  id: "program-driver-http-acceptance",
  name: "ProgramDriver HTTP acceptance",
  api: "test",
  provider: "test",
  reasoning: false,
  input: ["text"],
  contextWindow: 16_000,
  maxTokens: 1_000,
};

const externalSubstrateEnabled =
  process.env["PROGRAM_DRIVER_ACCEPTANCE_REDIS"] === "1" || useAgentCoreProgramDriverAcceptance();

describe.skipIf(!externalSubstrateEnabled)(
  "unchanged book_flight through an external HTTP workflow host substrate",
  () => {
    it("journals elicits and sampling without tool.execute/tool.resume", async () => {
      let sampleIndex = 0;
      const driver: ModelProviderDriver = {
        stream(): Stream<ModelStreamEvent, ModelResponse> {
          sampleIndex += 1;
          const message =
            sampleIndex === 1
              ? modelResponse(
                  {
                    role: "assistant",
                    content: [
                      {
                        type: "tool-call",
                        toolCall: {
                          id: "call-http-book-flight",
                          name: bookFlightTool.name,
                          input: { from: "NYC", destination: "LAX" },
                          thoughtSignature: null,
                        },
                      },
                    ],
                  },
                  "toolUse",
                )
              : sampleIndex === 2
                ? modelResponse(
                    {
                      role: "assistant",
                      content: [{ type: "text", text: "Travel light and arrive early." }],
                    },
                    "stop",
                  )
                : modelResponse(
                    {
                      role: "assistant",
                      content: [{ type: "text", text: "Your flight is booked." }],
                    },
                    "stop",
                  );
          return completedStream(message);
        },
        *sample(): Operation<ModelResponse> {
          throw new Error("workflow host must use the streaming model seam");
        },
      };
      const keyring = createCapabilityKeyring("book-flight-http", [
        { keyId: "test-v1", secret: "book-flight-http-program-driver-key" },
      ]);
      const redisClient =
        process.env["PROGRAM_DRIVER_ACCEPTANCE_REDIS"] === "1"
          ? createClient({ url: requiredRedisUrl() })
          : undefined;
      if (redisClient) {
        await redisClient.connect();
      }
      const journalStore = redisClient
        ? createRedisProgramDriverJournalStore(redisClient, keyring)
        : createProgramDriverJournalStore({ keyring });
      const runtime: ToolRuntime = {
        *runtimeId() {
          return "foreign-context-only";
        },
        *execute(): Operation<never> {
          throw new Error("ToolRuntime fallback must not execute the ToolSession-native tool");
        },
        *resume(): Operation<never> {
          throw new Error("ToolRuntime fallback must not resume the ToolSession-native tool");
        },
        *abort(): Operation<void> {},
      };
      const handler = createDurableChatHandler({
        programDriverJournalStore: journalStore,
        projectionTokens: createProjectionTokenKeyring(
          "book-flight-external-window-projection-key",
        ),
        *authorizeHistoryRead() {
          return "authorized" as const;
        },
        maxToolIterations: 5,
        setup: function* () {
          yield* installModelProvider(driver);
          yield* ModelProviderModelContext.set(model);
        },
      });
      let setupFailure: unknown;
      const application = createChatApplication({
        handler,
        setup: function* () {
          try {
            yield* setupDurableStreams({
              bufferStore: createInMemoryBufferStore<string>(),
              registryStore: createInMemoryRegistryStore(),
            });
            if (useAgentCoreProgramDriverAcceptance()) {
              yield* setupAgentCoreProgramDriverToolRuntime(bookFlightTool);
              return;
            }
            yield* createLocalToolInvocationRuntime({});
            yield* installToolInventory(
              createToolInventory([createToolInventoryEntry(bookFlightTool)]),
            );
            yield* installToolRuntime(runtime);
            yield* ProgramDriverEphemeralEffectsContext.set(
              createToolInvocationEphemeralEffectRegistrations({
                tools: new Map<string, RuntimeTool>([[bookFlightTool.name, bookFlightTool]]),
              }),
            );
          } catch (error) {
            setupFailure = error;
            throw error;
          }
        },
      });
      const conversationId = "book-flight-program-driver-http";
      const messages = [{ id: "user:http-book", role: "user", content: "Book NYC to LAX" }];

      try {
        let first: PublicEvent[];
        try {
          first = await post(application.handle, conversationId, messages);
        } catch (error) {
          throw setupFailure ?? error;
        }
        const firstInterrupt = interrupt(first);
        expect(firstInterrupt.message).toContain("flight");

        const second = await post(application.handle, conversationId, messages, {
          commandId: crypto.randomUUID(),
          interruptId: firstInterrupt.id,
          result: { action: "accept", content: { flightId: "FL001" } },
          basisRevision: firstInterrupt.basisRevision,
          logicalTurnId: firstInterrupt.logicalTurnId,
          executionId: firstInterrupt.executionId,
        });
        const secondInterrupt = interrupt(second);
        expect(secondInterrupt.message).toContain("seat");

        const third = await post(application.handle, conversationId, messages, {
          commandId: crypto.randomUUID(),
          interruptId: secondInterrupt.id,
          result: { action: "accept", content: { row: 2, seat: "A" } },
          basisRevision: secondInterrupt.basisRevision,
          logicalTurnId: secondInterrupt.logicalTurnId,
          executionId: secondInterrupt.executionId,
        });
        expect(third.some((event) => event.type === "TOOL_CALL_RESULT")).toBe(true);
        expect(
          third.some(
            (event) =>
              event.type === "TEXT_MESSAGE_CONTENT" && event["delta"] === "Your flight is booked.",
          ),
        ).toBe(true);

        const journal = await readJournal(journalStore, conversationId);
        const effectNames = journal.flatMap((record) =>
          record.payload.type === "PullRequested" && record.payload.descriptor.kind === "effect"
            ? [record.payload.descriptor.name]
            : [],
        );
        expect(effectNames).toContain("foreign.tool.start");
        expect(effectNames).toContain("foreign.tool.continue");
        expect(effectNames.filter((name) => name === "model.sample")).toHaveLength(3);
        expect(effectNames).not.toContain("tool.execute");
        expect(effectNames).not.toContain("tool.resume");
        expect(journal.at(-1)?.payload.type).toBe("TaskClosed");
      } finally {
        await application.close();
        if (redisClient?.isOpen) {
          await redisClient.disconnect();
        }
      }
    }, 20_000);
  },
);

type PublicEvent = { type: string; [key: string]: unknown };
type ResumeInput = {
  commandId: string;
  interruptId: string;
  result: { action: string; content: unknown };
  basisRevision: string;
  logicalTurnId: string;
  executionId: string;
};

const commandLifetimes = new Map<string, { issuedAt: number; expiresAt: number }>();
function commandLifetime(commandId: string): { issuedAt: number; expiresAt: number } {
  const existing = commandLifetimes.get(commandId);
  if (existing) return existing;
  const issuedAt = Date.now();
  const created = { issuedAt, expiresAt: issuedAt + 60_000 };
  commandLifetimes.set(commandId, created);
  return created;
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
    let done = false;
    yield* provide({
      *next(): Operation<IteratorResult<ModelStreamEvent, ModelResponse>> {
        if (done) return { done: true, value: message };
        done = true;
        return { done: true, value: message };
      },
    });
  });
}

async function post(
  handler: (request: Request) => Promise<Response>,
  conversationId: string,
  messages: Array<{ id: string; role: string; content: string }>,
  resume?: ResumeInput,
): Promise<PublicEvent[]> {
  const runId = crypto.randomUUID();
  const response = await handler(
    new Request(`http://localhost/chat?conversationId=${encodeURIComponent(conversationId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
        clientId: "external-book-flight-acceptance",
        conversationId,
        input: {
          threadId: conversationId,
          runId,
          state: {},
          messages,
          tools: [],
          context: [],
          forwardedProps: {},
        },
      }),
    }),
  );
  const text = await response.text();
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => parsePublicFrame(line));
}

function parsePublicFrame(line: string): PublicEvent {
  const value: unknown = JSON.parse(line);
  if (!isRecord(value) || !isRecord(value["event"]) || typeof value["event"]["type"] !== "string") {
    throw new Error("Invalid durable response frame");
  }
  return value["event"];
}

function interrupt(events: PublicEvent[]): {
  id: string;
  message: string;
  basisRevision: string;
  logicalTurnId: string;
  executionId: string;
} {
  const authority = events.findLast(
    (event) => event.type === "sweatpants.conversation-authority.v1",
  )?.["authority"];
  if (!isRecord(authority)) {
    throw new Error("Missing parked conversation authority");
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
    throw new Error("Invalid parked conversation authority");
  }
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
      return { id, message, basisRevision, logicalTurnId, executionId };
    }
  }
  throw new Error(`Expected a public interrupt: ${JSON.stringify(events)}`);
}

async function readJournal(store: ProgramDriverJournalStore, conversationId: string) {
  const journal = await run(() => store.open(conversationId));
  return await run(() => journal.readJournal(conversationId));
}

function requiredRedisUrl(): string {
  const value = process.env["REDIS_URL"];
  if (!value) {
    throw new Error("REDIS_URL is required for Redis workflow host acceptance");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
