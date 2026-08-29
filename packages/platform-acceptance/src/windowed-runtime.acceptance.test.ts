import { EventType } from "@ag-ui/core";
import { describe, expect, it } from "vitest";
import {
  withTestScenario,
  type TestApplicationFactoryContext,
  type TestRigOptions,
} from "@sweatpants/test-rig";
import type { ProgramDriverJournalStore } from "@sweatpants/durable-chat-runtime/durable-handler";
import {
  ACCEPTANCE_MODEL_ID,
  createDurabilityAcceptanceApplication,
} from "./lib/acceptance-app.ts";

type Binding = TestRigOptions["binding"];

async function runFiniteSegmentAndHydration(binding: Binding): Promise<void> {
  await withTestScenario(
    {
      binding,
      modelId: ACCEPTANCE_MODEL_ID,
      createApplication: createDurabilityAcceptanceApplication,
      scenarioTimeoutMs: 30_000,
    },
    function* (s) {
      const conversation = s.conversation();
      const turn = yield* conversation.send("WINDOWED_FINITE_SEGMENT_V1");
      const request = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });
      yield* request.respond.text("WINDOWED_FINITE_RESULT_V1");

      const settled = yield* turn.settled();
      expect(settled.text).toBe("WINDOWED_FINITE_RESULT_V1");
      expect(settled.events.filter((event) => event.type === EventType.RUN_STARTED)).toHaveLength(
        1,
      );
      expect(settled.events.filter((event) => event.type === EventType.RUN_FINISHED)).toHaveLength(
        1,
      );
      expect(settled.events.at(-1)?.type).toBe(EventType.RUN_FINISHED);

      const reopened = yield* conversation.reopen();
      const hydrationTranscript = reopened.transcript();
      expect(hydrationTranscript.events).toEqual([]);
      expect(JSON.stringify(reopened.snapshot().messages)).toContain("WINDOWED_FINITE_RESULT_V1");
      expect(reopened.snapshot().authority?.state).toBe("idle");
    },
  );
}

describe("windowed native lifecycle", () => {
  it.each(["in-process", "http"] as const)(
    "uses one finite command segment and run-free hydration over %s",
    async (binding) => {
      await runFiniteSegmentAndHydration(binding);
    },
    30_000,
  );

  it("uses a bounded conversation source recipe in the durable root task", async () => {
    let journalStore: ProgramDriverJournalStore | undefined;
    const createApplication = (context: TestApplicationFactoryContext) =>
      createDurabilityAcceptanceApplication(context, (inspection) => {
        journalStore ??= inspection.journalStore;
      });

    await withTestScenario(
      {
        binding: "in-process",
        modelId: ACCEPTANCE_MODEL_ID,
        createApplication,
        scenarioTimeoutMs: 30_000,
      },
      function* (s) {
        const conversation = s.conversation();
        const turn = yield* conversation.send("WINDOWED_RECIPE_TURN_V1");
        const request = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });
        yield* request.respond.text("WINDOWED_RECIPE_RESULT_V1");
        yield* turn.settled();

        if (!journalStore) {
          throw new Error("journal store was not captured");
        }
        const opened = yield* journalStore.open(conversation.conversationId);
        const records = yield* opened.readJournal(conversation.conversationId, "turn-0/root");
        const task = records.find((record) => record.payload.type === "TaskOpened");
        expect(task?.payload.type).toBe("TaskOpened");
        if (!task || task.payload.type !== "TaskOpened") {
          throw new Error("root task opening record is missing");
        }
        expect(task.payload.input).toHaveProperty("contextSource");
        expect(task.payload.input).not.toHaveProperty("messages");
        const pull = records.find((record) => record.payload.type === "PullRequested");
        expect(pull?.payload.type).toBe("PullRequested");
        if (!pull || pull.payload.type !== "PullRequested") {
          throw new Error("model pull record is missing");
        }
        expect(pull.payload.descriptor.kind).toBe("sample");
        if (pull.payload.descriptor.kind !== "sample") {
          throw new Error("model pull is not a sample");
        }
        const input = pull.payload.descriptor.input as { invocation?: { context?: unknown } };
        expect(input.invocation?.context).toMatchObject({ type: "conversation" });
        expect(records.some((record) => record.payload.type === "ModelContextPrepared")).toBe(true);
      },
    );
  }, 30_000);

  it.each(["in-process", "http"] as const)(
    "reconnects to an active same-owner segment without rerunning the model over %s",
    async (binding) => {
      await withTestScenario(
        {
          binding,
          modelId: ACCEPTANCE_MODEL_ID,
          createApplication: createDurabilityAcceptanceApplication,
          scenarioTimeoutMs: 30_000,
        },
        function* (s) {
          const conversation = s.conversation();
          const turn = yield* conversation.send("WINDOWED_ACTIVE_RECONNECT_V1");
          const initial = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });
          const activeRunId = conversation.snapshot().runId;
          expect(activeRunId).not.toBeNull();

          const reconnect = yield* s.streams.reconnect({
            conversationId: conversation.conversationId,
          });
          let startedRunId: string | undefined;
          yield* reconnect.event(EventType.RUN_STARTED, (event) => {
            if (event.type !== EventType.RUN_STARTED) {
              throw new Error("active reconnect did not emit RUN_STARTED");
            }
            startedRunId = event.runId;
          });
          expect(startedRunId).toBe(activeRunId);
          yield* reconnect.event("sweatpants.conversation-window.v1");
          yield* reconnect.event("sweatpants.conversation-authority.v1");

          yield* initial.respond.text("WINDOWED_ACTIVE_RECONNECT_RESULT_V1");
          expect((yield* turn.settled()).text).toBe("WINDOWED_ACTIVE_RECONNECT_RESULT_V1");
          const replayed = yield* reconnect.complete();
          expect(
            replayed.filter((frame) => frame.event.type === EventType.RUN_STARTED),
          ).toHaveLength(1);
          expect(s.model.requests()).toHaveLength(1);
        },
      );
    },
    30_000,
  );
});
