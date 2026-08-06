import { race } from "effection";
import { describe, expect, it } from "vitest";
import {
  normalizeResponsesHistory,
  withTestScenario,
  type TestRigOptions,
} from "@sweatpants/test-rig";
import {
  ACCEPTANCE_DURABLE_TOOL_NAME,
  ACCEPTANCE_MODEL_ID,
  DURABLE_EFFECT_NAME,
  DURABLE_SAMPLE_PROMPT_MARKER,
  DURABLE_RECORDED_MARKER,
  DURABLE_SAMPLE_RESPONSE_MARKER,
  DURABLE_TOOL_RESULT_MARKER,
  acceptanceDurableTool,
  createAcceptanceApplication,
  type AcceptanceApplicationInspection,
} from "./lib/acceptance-app.ts";

const DURABLE_CALL_ID = "call_durable_acceptance_1";
const DURABLE_TERMINAL_TEXT = "DURABLE_OUTER_TERMINAL_V1";
type Binding = TestRigOptions["binding"];

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          typeof item === "object" && item !== null && !Array.isArray(item),
      )
    : [];
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

async function runDurableToolScenario(binding: Binding): Promise<void> {
  let inspection: AcceptanceApplicationInspection | undefined;
  await withTestScenario(
    {
      binding,
      modelId: ACCEPTANCE_MODEL_ID,
      scenarioTimeoutMs: 30_000,
      createApplication(context) {
        return createAcceptanceApplication(context, (created) => {
          inspection = created;
        });
      },
    },
    function* (s) {
      const conversation = s.conversation({
        initialToolChoice: "required",
      });
      const turn = yield* conversation.send({ text: "Run the durable selection tool for trains." });
      const outerRequest = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });
      yield* outerRequest.respond.toolCalls([
        {
          id: DURABLE_CALL_ID,
          name: ACCEPTANCE_DURABLE_TOOL_NAME,
          arguments: { topic: "trains" },
        },
      ]);

      const nestedSample = yield* race([
        s.model.request((request) => {
          expect(JSON.stringify(request.body.input)).toContain(DURABLE_SAMPLE_PROMPT_MARKER);
        }),
        (function* () {
          const failure = yield* turn.failure();
          throw new Error(`durable tool failed before nested sampling: ${failure.message}`);
        })(),
      ]);
      expect(nestedSample.pullId).not.toBe(outerRequest.pullId);
      yield* nestedSample.respond.text(`${DURABLE_SAMPLE_RESPONSE_MARKER} Prefer the express.`);

      const choose = yield* turn.elicit("chooseOption");
      const elicitContext = record(choose.context, "durable elicit context");
      expect(elicitContext["options"]).toEqual(["trains-alpha", "trains-beta"]);
      if (!inspection) {
        throw new Error("acceptance application inspection was not installed");
      }
      expect(inspection.durableWorker).toEqual({
        activeAttachments: 0,
        attachmentCount: 1,
        shutdownCount: 1,
      });
      yield* choose.accept({ selected: "trains-beta" });

      const finalRequest = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });
      const finalInput = records(finalRequest.body.input);
      const outputRecord = finalInput.find(
        (item) => item["type"] === "function_call_output" && item["call_id"] === DURABLE_CALL_ID,
      );
      expect(outputRecord).toBeDefined();
      const rawOutput = outputRecord?.["output"];
      const durableResult = record(
        typeof rawOutput === "string" ? JSON.parse(rawOutput) : rawOutput,
        "durable tool output",
      );
      expect(durableResult).toMatchObject({
        marker: DURABLE_TOOL_RESULT_MARKER,
        recorded: `${DURABLE_RECORDED_MARKER}:trains`,
        selected: "trains-beta",
        sampleText: `${DURABLE_SAMPLE_RESPONSE_MARKER} Prefer the express.`,
      });
      expect(inspection.durableWorker).toEqual({
        activeAttachments: 0,
        attachmentCount: 2,
        shutdownCount: 2,
      });

      yield* finalRequest.respond.text(DURABLE_TERMINAL_TEXT);
      const transcript = yield* turn.settled();
      expect(transcript.outcome).toBe("success");
      expect(transcript.text).toBe(DURABLE_TERMINAL_TEXT);

      const opened = yield* inspection.journalStore.open(conversation.conversationId);
      const journal = yield* opened.readJournal(conversation.conversationId);
      expect(
        journal.some(
          (entry) =>
            entry.payload.type === "TaskOpened" &&
            entry.payload.programId === acceptanceDurableTool.manifest.programId,
        ),
      ).toBe(true);
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
      expect(JSON.stringify(journal)).not.toContain("function* ()");
      expect(JSON.stringify(journal)).not.toContain("foreign.tool.start");

      const followUpTurn = yield* conversation.send({
        text: "DURABLE_FOLLOW_UP_V1 What did I select?",
      });
      const followUpRequest = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });
      const history = normalizeResponsesHistory(followUpRequest.body.input);
      expect(
        history.filter(
          (entry) => entry.type === "assistant_tool_call" && entry.callId === DURABLE_CALL_ID,
        ),
      ).toHaveLength(1);
      expect(
        history.filter((entry) => entry.type === "tool_result" && entry.callId === DURABLE_CALL_ID),
      ).toHaveLength(1);
      const outerHistory = JSON.stringify(
        history.filter((entry) => entry.type === "user_text" || entry.type === "assistant_text"),
      );
      expect(outerHistory).not.toContain(DURABLE_SAMPLE_PROMPT_MARKER);
      expect(outerHistory).not.toContain(DURABLE_SAMPLE_RESPONSE_MARKER);
      yield* followUpRequest.respond.text("You selected trains-beta.");
      expect((yield* followUpTurn.settled()).text).toBe("You selected trains-beta.");
    },
  );
}

async function runDurableElicitOutcome(
  binding: Binding,
  action: "decline" | "cancel",
): Promise<void> {
  let inspection: AcceptanceApplicationInspection | undefined;
  await withTestScenario(
    {
      binding,
      modelId: ACCEPTANCE_MODEL_ID,
      createApplication(context) {
        return createAcceptanceApplication(context, (created) => {
          inspection = created;
        });
      },
    },
    function* (s) {
      const conversation = s.conversation();
      const turn = yield* conversation.send({ text: `DURABLE_${action.toUpperCase()}_V1` });
      const outer = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });
      yield* outer.respond.toolCalls([
        {
          id: `durable-${action}-call`,
          name: ACCEPTANCE_DURABLE_TOOL_NAME,
          arguments: { topic: action },
        },
      ]);
      const nested = yield* s.model.request((request) => {
        expect(JSON.stringify(request.body.input)).toContain(DURABLE_SAMPLE_PROMPT_MARKER);
      });
      yield* nested.respond.text(`${action} nested sample`);
      const elicit = yield* turn.elicit("chooseOption");
      yield* elicit[action]();

      const finalRequest = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });
      const output = records(finalRequest.body.input).find(
        (item) => item["type"] === "function_call_output",
      );
      expect(
        record(
          typeof output?.["output"] === "string"
            ? JSON.parse(output["output"] as string)
            : output?.["output"],
          "durable outcome output",
        ),
      ).toMatchObject({ selected: "none" });
      yield* finalRequest.respond.text(`DURABLE_${action.toUpperCase()}_TERMINAL_V1`);
      expect((yield* turn.settled()).text).toBe(`DURABLE_${action.toUpperCase()}_TERMINAL_V1`);
      expect(inspection?.durableWorker).toEqual({
        activeAttachments: 0,
        attachmentCount: 2,
        shutdownCount: 2,
      });
    },
  );
}

async function runDurableEffectFailure(binding: Binding): Promise<void> {
  await withTestScenario(
    { binding, modelId: ACCEPTANCE_MODEL_ID, createApplication: createAcceptanceApplication },
    function* (s) {
      const conversation = s.conversation();
      const turn = yield* conversation.send({ text: "DURABLE_EFFECT_FAILURE_V1" });
      const outer = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });
      yield* outer.respond.toolCalls([
        {
          id: "durable-effect-failure-call",
          name: ACCEPTANCE_DURABLE_TOOL_NAME,
          arguments: { topic: "effect-failure" },
        },
      ]);
      yield* turn.failure();

      const recovery = yield* conversation.send({ text: "DURABLE_EFFECT_RECOVERY_V1" });
      const recoveryRequest = yield* race([
        s.model.request((request) => {
          const input = JSON.stringify(request.body.input);
          expect(input).toContain("DURABLE_EFFECT_RECOVERY_V1");
          expect(input).toContain("durable-effect-failure-call");
          expect(input).toMatch(/error|fail/i);
        }),
        (function* () {
          const failure = yield* recovery.failure();
          throw new Error(`recovery failed before sampling: ${failure.message}`);
        })(),
      ]);
      yield* recoveryRequest.respond.text("DURABLE_EFFECT_RECOVERED_V1");
      expect((yield* recovery.settled()).text).toBe("DURABLE_EFFECT_RECOVERED_V1");
    },
  );
}

describe("crank-native durable tool semantics", () => {
  const binding: Binding = "in-process";

  it("parks, resumes in a fresh worker, samples, and preserves follow-up history", async () => {
    await runDurableToolScenario(binding);
  }, 30_000);

  it.each(["decline", "cancel"] as const)(
    "replays a fresh worker for durable %s",
    async (action) => {
      await runDurableElicitOutcome(binding, action);
    },
  );

  it("records a host-effect failure and recovers on the next turn", async () => {
    await runDurableEffectFailure(binding);
  });
});
