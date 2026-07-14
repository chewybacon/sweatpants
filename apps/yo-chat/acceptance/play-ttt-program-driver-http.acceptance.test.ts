import { resource, run, type Operation, type Stream } from "effection";
import { describe, expect, it } from "vitest";
import { createClient } from "redis";
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
import type { DurableSemanticRecord, Json } from "@sweatpants/session-contract";
import {
  createInMemoryToolSessionStore,
  createToolSessionForeignEffectRegistrations,
  createToolSessionRegistry,
} from "@sweatpants/tool-runtime-local";

import {
  setupAgentCoreProgramDriverToolRuntime,
  useAgentCoreProgramDriverAcceptance,
} from "./program-driver-agentcore-setup.ts";
import { createRedisProgramDriverJournalStore } from "../src/server/program-driver-journal.ts";
import { playTttTool } from "../src/tools/play-ttt/tool.ts";

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

describe("unchanged play_ttt through the HTTP ProgramRuntime", () => {
  it("journals tool-calling and structured samples through game completion", async () => {
    let sampleCount = 0;
    const driver: ModelProviderDriver = {
      stream(request): Stream<StreamEvent, AssistantMessage> {
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
    const redisClient =
      process.env["PROGRAM_DRIVER_ACCEPTANCE_REDIS"] === "1"
        ? createClient({ url: requiredRedisUrl() })
        : undefined;
    if (redisClient) {
      await redisClient.connect();
    }
    const journalStore = redisClient
      ? createRedisProgramDriverJournalStore(redisClient, keyring)
      : createInMemoryProgramDriverJournalStore({ keyring });
    const application = createApplication(driver, journalStore);
    const conversationId = "play-ttt-program-driver-http";
    const messages = [{ id: "user:http-ttt", role: "user", content: "Play tic-tac-toe" }];

    try {
      let events = await post(application.handle, conversationId, messages);
      for (let round = 0; round < 12; round += 1) {
        const pending = publicInterrupt(events);
        if (!pending) {
          break;
        }
        const journal = await readJournal(journalStore, conversationId);
        const position = responsePosition(journal);
        events = await post(application.handle, conversationId, messages, {
          interruptId: pending.id,
          position,
        });
      }

      expect(events.some((event) => event.type === "TOOL_CALL_RESULT")).toBe(true);
      expect(
        events.some(
          (event) => event.type === "TEXT_MESSAGE_CONTENT" && event["delta"] === "Game complete.",
        ),
      ).toBe(true);

      const journal = await readJournal(journalStore, conversationId);
      const effectNames = journal.flatMap((entry) =>
        entry.payload.type === "PullRequested" && entry.payload.descriptor.kind === "effect"
          ? [entry.payload.descriptor.name]
          : [],
      );
      expect(effectNames).toContain("foreign.tool.start");
      expect(effectNames).toContain("foreign.tool.continue");
      expect(effectNames.filter((name) => name === "model.sample").length).toBeGreaterThan(2);
      expect(effectNames).not.toContain("tool.execute");
      expect(effectNames).not.toContain("tool.resume");
      expect(journal.at(-1)?.payload.type).toBe("TaskClosed");
      expect(sampleCount).toBeGreaterThan(2);
    } finally {
      await application.close();
      if (redisClient?.isOpen) {
        await redisClient.disconnect();
      }
    }
  }, 20_000);
});

function createApplication(driver: ModelProviderDriver, journalStore: ProgramDriverJournalStore) {
  const runtime: ToolRuntime = {
    id: "foreign-context-only",
    *execute(): Operation<never> {
      throw new Error("ToolRuntime fallback must not execute play_ttt");
    },
    *resume(): Operation<never> {
      throw new Error("ToolRuntime fallback must not resume play_ttt");
    },
    *abort(): Operation<void> {},
  };
  const handler = createDurableChatHandler({
    programDriverJournalStore: journalStore,
    maxToolIterations: 5,
    setup: function* () {
      yield* ModelProviderContext.set(driver);
      yield* ModelProviderModelContext.set(model);
    },
  });
  return createChatApplication({
    handler,
    setup: function* () {
      yield* setupDurableStreams({
        bufferStore: createInMemoryBufferStore<string>(),
        registryStore: createInMemoryRegistryStore(),
      });
      if (useAgentCoreProgramDriverAcceptance()) {
        yield* setupAgentCoreProgramDriverToolRuntime(playTttTool);
        return;
      }
      const registry = yield* createToolSessionRegistry(createInMemoryToolSessionStore(), {
        samplingProvider: {
          *sample(): Operation<never> {
            throw new Error("ToolSession sampling must be lifted into ProgramRuntime");
          },
        },
      });
      yield* ToolInventoryContext.set(createToolInventory([createToolInventoryEntry(playTttTool)]));
      yield* ToolRuntimeContext.set(runtime);
      yield* ProgramDriverForeignEffectsContext.set(
        createToolSessionForeignEffectRegistrations({
          registry,
          tools: new Map<string, RuntimeTool>([[playTttTool.name, playTttTool]]),
        }),
      );
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

type PublicEvent = { type: string; [key: string]: unknown };
type ResumeInput = { interruptId: string; position: number };

function completedStream(message: AssistantMessage): Stream<StreamEvent, AssistantMessage> {
  return resource(function* (provide) {
    yield* provide({
      *next(): Operation<IteratorResult<StreamEvent, AssistantMessage>> {
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

function publicInterrupt(events: PublicEvent[]): { id: string } | undefined {
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

async function readJournal(store: ProgramDriverJournalStore, conversationId: string) {
  const journal = await run(() => store.open(conversationId));
  return await run(() => journal.readJournal(conversationId));
}

function responsePosition(records: DurableSemanticRecord[]): number {
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
