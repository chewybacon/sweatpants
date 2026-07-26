import { describe, expect, it } from "vitest";
import {
  withTestScenario,
  type TestApplicationFactoryContext,
  type TestRigOptions,
} from "@sweatpants/test-rig";
import type { ProgramDriverJournalStore } from "@sweatpants/framework/server";
import {
  ACCEPTANCE_DURABLE_TOOL_NAME,
  ACCEPTANCE_MODEL_ID,
  DURABLE_SAMPLE_RESPONSE_MARKER,
  acceptanceDurableTool,
  createAcceptanceApplication,
} from "./lib/acceptance-app.ts";

type Binding = TestRigOptions["binding"];

function createReplacementFactory(): {
  createApplication(
    context: TestApplicationFactoryContext,
  ): ReturnType<typeof createAcceptanceApplication>;
  generations(): number;
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
        tools: [acceptanceDurableTool],
        enabledTools: true,
        initialToolChoice: "required",
      });
      const turn = yield* conversation.send("HOST_REPLACEMENT_DURABLE_TURN_V1");

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
      const final = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });
      yield* final.respond.text("HOST_REPLACEMENT_TERMINAL_V1");

      expect((yield* turn.settled()).text).toBe("HOST_REPLACEMENT_TERMINAL_V1");
    },
  );
}

describe.each<Binding>(["in-process", "http"])(
  "durable Turn Host replacement through the %s binding",
  (binding) => {
    it("resumes a parked durable child through a replacement application generation", async () => {
      await runScenario(binding);
    }, 30_000);
  },
);
