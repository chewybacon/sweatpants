import { describe, expect, it } from "vitest";
import {
  withTestScenario,
  type TestApplicationFactoryContext,
  type TestRigOptions,
} from "@sweatpants/test-rig";
import type { ProgramDriverJournalStore } from "@sweatpants/durable-chat-runtime/durable-handler";
import {
  ACCEPTANCE_DURABLE_TOOL_NAME,
  ACCEPTANCE_MODEL_ID,
  DURABLE_EFFECT_NAME,
  DURABLE_SAMPLE_PROMPT_MARKER,
  DURABLE_SAMPLE_RESPONSE_MARKER,
  createAcceptanceApplication,
} from "./lib/acceptance-app.ts";

type Binding = TestRigOptions["binding"];

function createReplacementFactory(): {
  createApplication(
    context: TestApplicationFactoryContext,
  ): ReturnType<typeof createAcceptanceApplication>;
  generations(): number;
  journalStore(): ProgramDriverJournalStore;
} {
  let journalStore: ProgramDriverJournalStore | undefined;
  let generation = 0;
  return {
    createApplication(context) {
      generation += 1;
      return createAcceptanceApplication(
        context,
        (inspection) => {
          journalStore ??= inspection.journalStore;
        },
        ...(journalStore ? [{ journalStore }] : []),
      );
    },
    generations: () => generation,
    journalStore: () => {
      if (!journalStore) {
        throw new Error("replacement journal store was not installed");
      }
      return journalStore;
    },
  };
}

async function runScenario(binding: Binding): Promise<void> {
  const factory = createReplacementFactory();
  await withTestScenario(
    {
      binding,
      modelId: ACCEPTANCE_MODEL_ID,
      scenarioTimeoutMs: 30_000,
      createApplication: factory.createApplication,
    },
    function* (s) {
      const conversation = s.conversation({
        initialToolChoice: "required",
      });
      const turn = yield* conversation.send({ text: "HOST_REPLACEMENT_DURABLE_TURN_V1" });

      const outer = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });
      yield* outer.respond.toolCalls([
        {
          id: "host-replacement-durable-call",
          name: ACCEPTANCE_DURABLE_TOOL_NAME,
          arguments: { topic: "replacement" },
        },
      ]);

      const nested = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });
      yield* nested.respond.text(`${DURABLE_SAMPLE_RESPONSE_MARKER} Resume after replacement.`);

      const choose = yield* turn.elicit("chooseOption");
      yield* s.host.replace();
      expect(factory.generations()).toBe(2);

      yield* choose.accept({ selected: "replacement-alpha" });
      const final = yield* s.model.request((request) => {
        expect(request.body.model).toBe(ACCEPTANCE_MODEL_ID);
        expect(JSON.stringify(request.body.input)).not.toContain(DURABLE_SAMPLE_PROMPT_MARKER);
      });
      yield* final.respond.text("HOST_REPLACEMENT_TERMINAL_V1");

      expect((yield* turn.settled()).text).toBe("HOST_REPLACEMENT_TERMINAL_V1");
      expect(s.model.requests()).toHaveLength(3);

      const opened = yield* factory.journalStore().open(conversation.conversationId);
      const journal = yield* opened.readJournal(conversation.conversationId);
      expect(
        journal.filter(
          (entry) =>
            entry.payload.type === "PullRequested" &&
            entry.payload.descriptor.kind === "effect" &&
            entry.payload.descriptor.name === DURABLE_EFFECT_NAME,
        ),
      ).toHaveLength(1);
      expect(
        journal.filter(
          (entry) =>
            entry.payload.type === "PullRequested" &&
            entry.payload.descriptor.kind === "record" &&
            entry.payload.descriptor.key === "acceptance-recorded-value",
        ),
      ).toHaveLength(1);
    },
  );
}

describe("durable Turn Host replacement", () => {
  // binding-conformance: replacement must swap the real HTTP application generation.
  it("resumes a parked durable child through a replacement application generation", async () => {
    await runScenario("http");
  }, 30_000);
});
