import { describe, expect, it } from "vitest";
import { action, resource, run, type Operation, type Stream } from "effection";
import {
  installModelProvider,
  ModelProviderModelContext,
  ToolInventoryContext,
  installToolRuntime,
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
  FOREIGN_TOOL_CONTINUE_EFFECT,
  FOREIGN_TOOL_START_EFFECT,
  createDurableEffectRegistration,
  type DurableSemanticRecord,
} from "@sweatpants/session-contract";
import { bookFlightTool } from "../src/tools/book-flight/tool.ts";

const model: Model = {
  id: "indeterminate",
  name: "indeterminate",
  api: "test",
  provider: "test",
  reasoning: false,
  input: ["text"],
  contextWindow: 16_000,
  maxTokens: 1_000,
};

const conversationId = `indeterminate-effect-${process.pid}-${Date.now().toString(36)}`;

/**
 * Drives a turn whose foreign effect never resolves, then replaces the host
 * underneath it.
 *
 * A second host resuming the session calls `replaceAttachment`, which detaches
 * every in-flight attempt. For an `unsafe` effect that settles the pull as
 * `effect_outcome_indeterminate`: the call may or may not have landed, and no
 * resolver survives to say which. The conversation must be told, not killed.
 */
describe("an indeterminate unsafe effect reaches the model", () => {
  it("surfaces effect_outcome_indeterminate as a tool result instead of a run error", async () => {
    let sampleIndex = 0;
    let sawIndeterminate = false;

    const driver: ModelProviderDriver = {
      *stream(
        request: ModelProviderStreamRequest,
      ): Operation<Stream<StreamEvent, AssistantMessage>> {
        sampleIndex += 1;
        const serialized = JSON.stringify(request.context.messages);
        if (serialized.includes("effect_outcome_indeterminate")) {
          sawIndeterminate = true;
          return completed({
            role: "assistant",
            content: [{ type: "text", text: "I could not confirm the booking." }],
            stopReason: "stop",
          });
        }
        if (sampleIndex === 1) {
          return completed({
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "call-indeterminate",
                name: bookFlightTool.name,
                arguments: { from: "NYC", destination: "LAX" },
              },
            ],
            stopReason: "toolUse",
          });
        }
        return completed({
          role: "assistant",
          content: [{ type: "text", text: "Done." }],
          stopReason: "stop",
        });
      },
      *sample(): Operation<AssistantMessage> {
        throw new Error("stream seam only");
      },
    };

    const keyring = createCapabilityKeyring("indeterminate", [
      { keyId: "k", secret: "indeterminate-acceptance-key-32b!!" },
    ]);
    const journalStore = createInMemoryProgramDriverJournalStore({ keyring });
    const bufferStore = createInMemoryBufferStore<string>();
    const registryStore = createInMemoryRegistryStore();
    const fallback: ToolRuntime = {
      *runtimeId() {
        return "unused";
      },
      *execute(): Operation<never> {
        throw new Error("unused");
      },
      *resume(): Operation<never> {
        throw new Error("unused");
      },
      *abort(): Operation<void> {},
    };

    // A foreign start handler that never resolves, giving the attempt a window
    // wide enough for a competing host to detach it.
    let startEntered = false;
    let signalStarted: (() => void) | undefined;
    const startedSignal = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const blockingStart = createDurableEffectRegistration(
      FOREIGN_TOOL_START_EFFECT,
      { mode: "unsafe" },
      function* () {
        startEntered = true;
        signalStarted?.();
        yield* action<never>(() => () => undefined);
      },
    );
    const unusedContinue = createDurableEffectRegistration(
      FOREIGN_TOOL_CONTINUE_EFFECT,
      { mode: "unsafe" },
      function* () {
        yield* action<never>(() => () => undefined);
      },
    );

    const createRuntime = () =>
      createChatApplication({
        handler: createDurableChatHandler({
          programDriverJournalStore: journalStore,
          maxToolIterations: 4,
          setup: function* () {
            yield* installModelProvider(driver);
            yield* ModelProviderModelContext.set(model);
          },
        }),
        setup: function* () {
          yield* setupDurableStreams({ bufferStore, registryStore });
          yield* ToolInventoryContext.set(
            createToolInventory([createToolInventoryEntry(bookFlightTool)]),
          );
          yield* installToolRuntime(fallback);
          yield* ProgramDriverForeignEffectsContext.set([blockingStart, unusedContinue]);
        },
      });

    const first = createRuntime();
    const stalled = first.handle(chatRequest()).then(
      async (response) => {
        try {
          await response.text();
        } catch {
          /* the stalled turn is abandoned on purpose */
        }
      },
      () => undefined,
    );
    await startedSignal;

    // Replace the host while the unsafe attempt is still in flight.
    await first.close({ mode: "catastrophic" });
    void stalled;

    const second = createRuntime();
    try {
      const frames = await readFrames(second.handle(chatRequest()));
      const journal = await readJournal(journalStore);
      const types = journal.map((entry) => entry.payload.type);

      expect(types, "detaching an in-flight unsafe attempt must journal it").toContain(
        "AttemptDetached",
      );
      expect(types, "an unsafe detached attempt is indeterminate").toContain("PullIndeterminate");
      expect(sawIndeterminate, "the model must be told the effect outcome is indeterminate").toBe(
        true,
      );
      expect(
        frames.some((frame) => frame.type === "RUN_ERROR"),
        "an indeterminate effect must not destroy the turn",
      ).toBe(false);
      expect(journal.at(-1)?.payload.type, "the turn must close cleanly").toBe("TaskClosed");
    } finally {
      await second.close();
    }
  }, 30_000);
});

function completed(message: AssistantMessage): Stream<StreamEvent, AssistantMessage> {
  return resource(function* (provide) {
    yield* provide({
      *next(): Operation<IteratorResult<StreamEvent, AssistantMessage>> {
        return { done: true, value: message };
      },
    });
  });
}

function chatRequest(): Request {
  return new Request(`http://localhost/chat?conversationId=${conversationId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [{ id: "u1", role: "user", content: "Book NYC to LAX" }],
      enabledTools: true,
    }),
  });
}

async function readFrames(pending: Promise<Response>): Promise<Array<{ type: string }>> {
  const response = await pending;
  const text = await response.text();
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line).event as { type: string });
}

async function readJournal(store: ProgramDriverJournalStore): Promise<DurableSemanticRecord[]> {
  const journal = await run(() => store.open(conversationId));
  return await run(() => journal.readJournal(conversationId));
}
