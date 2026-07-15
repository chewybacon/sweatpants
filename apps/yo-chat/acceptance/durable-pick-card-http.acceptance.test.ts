// @vitest-environment node
import { resource, run, type Operation, type Stream } from "effection";
import { describe, expect, it } from "vitest";
import {
  ModelProviderContext,
  ModelProviderModelContext,
  type AssistantMessage,
  type Model,
  type ModelProviderDriver,
  type StreamEvent,
} from "@sweatpants/framework/chat";
import {
  createInMemoryBufferStore,
  createInMemoryRegistryStore,
  setupDurableStreams,
} from "@sweatpants/framework/chat/durable-streams";
import {
  createCapabilityKeyring,
  createChatApplication,
  createDurableChatHandler,
  createInMemoryProgramDriverJournalStore,
  createPluginSessionManager,
  programDriverSchemaRegistry,
} from "@sweatpants/framework/server";
import {
  createInMemoryToolSessionStore,
  createToolSessionRegistry,
} from "@sweatpants/tool-runtime-local";

import type { Card } from "../src/tools/pick-card/cards";
import { durablePickCard, drawPickCards, pickCard } from "../src/tools/pick-card/durable";
import { installYoChatToolRuntime } from "../src/server/tool-runtime-installation";
import { yoChatToolSessionWorkerConfig } from "../src/server/tool-worker-config";

const model: Model = {
  id: "durable-pick-card-http",
  name: "Durable pick-card HTTP",
  api: "test",
  provider: "test",
  reasoning: false,
  input: ["text"],
  contextWindow: 16_000,
  maxTokens: 1_000,
};

describe("yo-chat routes pick_card to its crank-native worker program", () => {
  it("preserves CardPicker context and returns the durable child result", async () => {
    let samples = 0;
    const callId = "call-http-durable-pick-card";
    const driver: ModelProviderDriver = {
      stream(): Stream<StreamEvent, AssistantMessage> {
        samples += 1;
        return completed(
          samples === 1
            ? {
                role: "assistant",
                content: [
                  {
                    type: "toolCall",
                    id: callId,
                    name: pickCard.name,
                    arguments: { count: 3 },
                  },
                ],
                stopReason: "toolUse",
              }
            : {
                role: "assistant",
                content: [{ type: "text", text: "Your durable card was recorded." }],
                stopReason: "stop",
              },
        );
      },
      *sample(): Operation<never> {
        throw new Error("ProgramRuntime must use the streaming model seam");
      },
    };
    const journalStore = createInMemoryProgramDriverJournalStore({
      keyring: createCapabilityKeyring("durable-pick-card-http", [
        { keyId: "test-v1", secret: "durable-pick-card-http-secret-key" },
      ]),
      schemaRegistry: programDriverSchemaRegistry(pickCard.artifacts.catalog),
    });
    const handler = createDurableChatHandler({
      programDriverJournalStore: journalStore,
      maxToolIterations: 4,
      setup: function* () {
        yield* ModelProviderContext.set(driver);
        yield* ModelProviderModelContext.set(model);
      },
    });
    const application = createChatApplication({
      handler,
      setup: function* () {
        yield* setupDurableStreams({
          bufferStore: createInMemoryBufferStore<string>(),
          registryStore: createInMemoryRegistryStore(),
        });
        const samplingProvider = {
          *sample(): Operation<never> {
            throw new Error("pick_card must not sample through ToolSession");
          },
        };
        const registry = yield* createToolSessionRegistry(createInMemoryToolSessionStore(), {
          samplingProvider,
          worker: yoChatToolSessionWorkerConfig,
        });
        const pluginManager = yield* createPluginSessionManager({ registry, samplingProvider });
        yield* installYoChatToolRuntime({
          mode: "local",
          registry,
          pluginManager,
          samplingProvider,
          tools: [pickCard],
        });
      },
    });
    const conversationId = "durable-pick-card-http";
    const messages = [{ id: "user:pick", role: "user", content: "Draw three cards" }];

    try {
      const first = await post(application.handle, conversationId, messages);
      const pending = interrupt(first);
      expect(pending.toolCallId).toBe(callId);
      const cards = modelContextCards(pending.responseSchema);
      expect(cards).toHaveLength(3);
      const selected = cards[0]!;

      const second = await post(application.handle, conversationId, messages, {
        interruptId: pending.id,
        callId,
        result: { action: "accept", content: { picked: selected } },
      });
      expect(
        second.some(
          (event) =>
            event.type === "TOOL_CALL_RESULT" &&
            typeof event["content"] === "string" &&
            event["content"].includes(`${selected.rank} of ${selected.suit}`),
        ),
      ).toBe(true);
      expect(
        second.some(
          (event) =>
            event.type === "TEXT_MESSAGE_CONTENT" &&
            event["delta"] === "Your durable card was recorded.",
        ),
      ).toBe(true);

      const journal = await run(function* () {
        const opened = yield* journalStore.open(conversationId);
        return yield* opened.readJournal(conversationId);
      });
      expect(
        journal.some(
          (record) =>
            record.payload.type === "TaskOpened" &&
            record.payload.programId === durablePickCard.manifest.programId,
        ),
      ).toBe(true);
      expect(
        journal.filter(
          (record) =>
            record.payload.type === "PullRequested" &&
            record.payload.descriptor.kind === "effect" &&
            record.payload.descriptor.name === drawPickCards.name,
        ),
      ).toHaveLength(1);
      expect(
        journal.some(
          (record) =>
            record.payload.type === "PullRequested" &&
            record.payload.descriptor.kind === "effect" &&
            record.payload.descriptor.name === "foreign.tool.start",
        ),
      ).toBe(false);
      expect(JSON.stringify(journal)).not.toContain("yo-chat-durable-tools");
      expect(samples).toBe(2);
    } finally {
      await application.close();
    }
  }, 20_000);
});

type PublicEvent = { type: string; [key: string]: unknown };
type Resume = {
  interruptId: string;
  callId: string;
  result: { action: "accept"; content: { picked: Card } };
};

function completed(message: AssistantMessage): Stream<StreamEvent, AssistantMessage> {
  return resource(function* (provide) {
    yield* provide({
      *next(): Operation<IteratorResult<StreamEvent, AssistantMessage>> {
        return { done: true, value: message };
      },
    });
  });
}

async function post(
  handle: (request: Request) => Promise<Response>,
  conversationId: string,
  messages: Array<{ id: string; role: string; content: string }>,
  resume?: Resume,
): Promise<PublicEvent[]> {
  const response = await handle(
    new Request(`http://localhost/chat?conversationId=${conversationId}`, {
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
                  payload: resume.result,
                },
              ],
              elicitResponses: [
                {
                  sessionId: resume.callId,
                  callId: resume.callId,
                  toolName: pickCard.name,
                  elicitId: resume.interruptId,
                  result: resume.result,
                },
              ],
            }
          : {}),
      }),
    }),
  );
  return (await response.text())
    .split("\n")
    .filter(Boolean)
    .map((line) => parseFrame(line));
}

function parseFrame(line: string): PublicEvent {
  const frame: unknown = JSON.parse(line);
  if (!isRecord(frame) || !isRecord(frame["event"]) || typeof frame["event"]["type"] !== "string") {
    throw new Error("Invalid public durable frame");
  }
  return frame["event"] as PublicEvent;
}

function interrupt(events: PublicEvent[]): {
  id: string;
  toolCallId?: string;
  responseSchema: Record<string, unknown>;
} {
  for (const event of events) {
    if (event.type !== "RUN_FINISHED" || !isRecord(event["outcome"])) {
      continue;
    }
    const values = event["outcome"]["interrupts"];
    if (!Array.isArray(values) || !isRecord(values[0])) {
      continue;
    }
    const value = values[0];
    if (typeof value["id"] !== "string" || !isRecord(value["responseSchema"])) {
      continue;
    }
    return {
      id: value["id"],
      ...(typeof value["toolCallId"] === "string" ? { toolCallId: value["toolCallId"] } : {}),
      responseSchema: value["responseSchema"],
    };
  }
  throw new Error(`Expected durable pick_card interrupt: ${JSON.stringify(events)}`);
}

function modelContextCards(schema: Record<string, unknown>): Card[] {
  const context = schema["x-elicit-context"];
  if (!isRecord(context) || !Array.isArray(context["cards"])) {
    throw new Error("CardPicker model context is missing cards");
  }
  return context["cards"] as Card[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
