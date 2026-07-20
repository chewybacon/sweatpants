// @vitest-environment node
import { resource, run, type Operation, type Stream } from "effection";
import { describe, expect, it } from "vitest";
import {
  ModelProviderContext,
  ModelProviderModelContext,
  ToolInventoryContext,
  ToolRuntimeContext,
  createToolInventory,
  type AssistantMessage,
  type Model,
  type ModelProviderDriver,
  type StreamEvent,
  type ToolRuntime,
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
  programDriverSchemaRegistry,
} from "@sweatpants/framework/server";

const model: Model = {
  id: "model-token-activity-http",
  name: "Model token activity HTTP",
  api: "test",
  provider: "test",
  reasoning: false,
  input: ["text"],
  contextWindow: 16_000,
  maxTokens: 1_000,
};

const finalMessage: AssistantMessage = {
  role: "assistant",
  content: [{ type: "text", text: "Hello" }],
  stopReason: "stop",
};

const noToolsRuntime: ToolRuntime = {
  id: "no-tools",
  *execute(): Operation<never> {
    throw new Error("No tools configured");
  },
  *resume(): Operation<never> {
    throw new Error("No tools configured");
  },
  *abort(): Operation<void> {},
};

function chunkedModel(): ModelProviderDriver {
  return {
    stream(): Stream<StreamEvent, AssistantMessage> {
      return resource(function* (provide) {
        const chunks = ["Hel", "lo"];
        let index = 0;
        yield* provide({
          *next(): Operation<IteratorResult<StreamEvent, AssistantMessage>> {
            if (index < chunks.length) {
              const delta = chunks[index++]!;
              return {
                done: false,
                value: {
                  type: "text_delta",
                  contentIndex: 0,
                  delta,
                  partial: {
                    role: "assistant",
                    content: [{ type: "text", text: chunks.slice(0, index).join("") }],
                  },
                },
              };
            }
            return { done: true, value: finalMessage };
          },
        });
      });
    },
    *sample(): Operation<never> {
      throw new Error("ProgramRuntime must consume the streaming seam");
    },
  };
}

type PublicEvent = { type: string; [key: string]: unknown };

describe("yo-chat model token activity delivery", () => {
  it("delivers each model delta in order while keeping token chunks out of the journal", async () => {
    const journalStore = createInMemoryProgramDriverJournalStore({
      keyring: createCapabilityKeyring("model-token-activity-http", [
        { keyId: "test-v1", secret: "model-token-activity-http-secret" },
      ]),
      schemaRegistry: programDriverSchemaRegistry(),
    });
    const handler = createDurableChatHandler({
      programDriverJournalStore: journalStore,
      setup: function* () {
        yield* ModelProviderContext.set(chunkedModel());
        yield* ModelProviderModelContext.set(model);
        yield* ToolInventoryContext.set(createToolInventory([]));
        yield* ToolRuntimeContext.set(noToolsRuntime);
      },
    });
    const application = createChatApplication({
      handler,
      setup: function* () {
        yield* setupDurableStreams({
          bufferStore: createInMemoryBufferStore<string>(),
          registryStore: createInMemoryRegistryStore(),
          retentionPolicy: { mode: "retain_forever" },
        });
      },
    });
    const conversationId = "model-token-activity-http";

    try {
      const response = await application.handle(
        new Request(`http://localhost/chat?conversationId=${conversationId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: [{ id: "user:delta", role: "user", content: "Stream two chunks" }],
          }),
        }),
      );
      const sessionId = response.headers.get("x-session-id");
      expect(sessionId).toBeTruthy();
      const frames = (await response.text())
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { lsn: number; event: PublicEvent });
      const events = frames.map((frame) => frame.event);
      const deltas = events
        .filter((event) => event.type === "TEXT_MESSAGE_CONTENT")
        .map((event) => event["delta"]);
      expect(deltas, JSON.stringify(events)).toEqual(["Hel", "lo"]);
      expect(events.findIndex((event) => event.type === "TEXT_MESSAGE_CONTENT")).toBeLessThan(
        events.findIndex((event) => event.type === "RUN_FINISHED"),
      );

      const firstDelta = frames.find((frame) => frame.event.type === "TEXT_MESSAGE_CONTENT")!;
      const reconnect = await application.handle(
        new Request(`http://localhost/sessions/${sessionId}?offset=${firstDelta.lsn}`, {
          headers: { Accept: "application/x-ndjson" },
        }),
      );
      const replayed = (await reconnect.text())
        .split("\n")
        .filter(Boolean)
        .map((line) => (JSON.parse(line) as { event: PublicEvent }).event)
        .filter((event) => event.type === "TEXT_MESSAGE_CONTENT")
        .map((event) => event["delta"]);
      expect(replayed).toEqual(["lo"]);

      const journal = await run(function* () {
        const opened = yield* journalStore.open(conversationId);
        return yield* opened.readJournal(conversationId);
      });
      expect(JSON.stringify(journal)).not.toContain('"eventType":"model_token"');
      expect(
        journal.filter(
          (record) =>
            record.payload.type === "DurableEmission" &&
            record.payload.descriptor.eventType === "assistant_text",
        ),
      ).toHaveLength(1);
    } finally {
      await application.close();
    }
  });
});
