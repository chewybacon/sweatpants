import { describe, expect, it } from "vitest";
import { withTestScenario } from "@sweatpants/test-rig";
import {
  ACCEPTANCE_DURABLE_TOOL_NAME,
  ACCEPTANCE_MODEL_ID,
  DURABLE_SAMPLE_PROMPT_MARKER,
  DURABLE_SAMPLE_RESPONSE_MARKER,
  acceptanceDurableTool,
  createAcceptanceApplication,
  type AcceptanceApplicationInspection,
} from "./lib/acceptance-app.ts";
import { createLocalProgramDriver } from "@sweatpants/durable-execution";

describe("model-sampling placement semantics", () => {
  it.each(["host", "execution"] as const)(
    "completes a root turn when model sampling is owned by the %s executor",
    async (ownership) => {
      let inspection: AcceptanceApplicationInspection | undefined;
      await withTestScenario(
        {
          binding: "in-process",
          modelId: ACCEPTANCE_MODEL_ID,
          createApplication: (context) =>
            createAcceptanceApplication(
              context,
              (value) => {
                inspection = value;
              },
              { modelSamplingOwnership: ownership },
            ),
        },
        function* (s) {
          const turn = yield* s.conversation().send(`PLACEMENT_${ownership.toUpperCase()}_V1`);
          const request = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });
          yield* request.respond.text(`PLACEMENT_${ownership.toUpperCase()}_COMPLETE`);
          expect((yield* turn.settled()).text).toBe(
            `PLACEMENT_${ownership.toUpperCase()}_COMPLETE`,
          );
          s.agui.assertConformant();
        },
      );

      expect(inspection?.modelSamplingExecutors).toEqual([ownership]);
      if (ownership === "execution") {
        expect(inspection?.modelSamplingProtocol).toEqual([
          "attached",
          "producer_started",
          "producer_completed",
          "acknowledged",
        ]);
      }
    },
  );

  it("keeps nested execution sampling private while the root remains executable", async () => {
    let inspection: AcceptanceApplicationInspection | undefined;
    await withTestScenario(
      {
        binding: "in-process",
        modelId: ACCEPTANCE_MODEL_ID,
        scenarioTimeoutMs: 30_000,
        createApplication: (context) =>
          createAcceptanceApplication(
            context,
            (value) => {
              inspection = value;
            },
            {
              modelSamplingOwnership: "execution",
              modelSamplingTargets: "all",
              durableDriverKind: "nested-program",
              createDurableDriver: (registry, executionEffects) =>
                createLocalProgramDriver(registry, {
                  ...(executionEffects ? { executionEffects } : {}),
                }),
            },
          ),
      },
      function* (s) {
        const turn = yield* s
          .conversation({
            tools: [acceptanceDurableTool],
            enabledTools: true,
            initialToolChoice: "required",
          })
          .send("Run the durable selection tool.");
        const outer = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });
        yield* outer.respond.toolCalls([
          {
            id: "placement-durable-call",
            name: ACCEPTANCE_DURABLE_TOOL_NAME,
            arguments: { topic: "placement" },
          },
        ]);
        const nested = yield* s.model.request((request) => {
          expect(JSON.stringify(request.body.input)).toContain(DURABLE_SAMPLE_PROMPT_MARKER);
        });
        yield* nested.respond.text(`${DURABLE_SAMPLE_RESPONSE_MARKER} private note`);
        const choose = yield* turn.elicit("chooseOption");
        yield* choose.accept({ selected: "placement-alpha" });
        const final = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });
        expect(
          JSON.stringify(s.agui.events().filter((event) => event.type === "TEXT_MESSAGE_CONTENT")),
        ).not.toContain("private note");
        yield* final.respond.text("PLACEMENT_NESTED_COMPLETE");
        expect((yield* turn.settled()).text).toBe("PLACEMENT_NESTED_COMPLETE");
        s.agui.assertConformant();
      },
    );
    expect(inspection?.modelSamplingExecutors).toEqual(["execution", "execution", "execution"]);
    expect(inspection?.modelSamplingProtocol.filter((event) => event === "attached")).toHaveLength(
      3,
    );
    expect(
      inspection?.modelSamplingProtocol.filter((event) => event === "acknowledged"),
    ).toHaveLength(3);
  });

  it("preserves execution ownership through the HTTP binding", async () => {
    let inspection: AcceptanceApplicationInspection | undefined;
    await withTestScenario(
      {
        binding: "http",
        modelId: ACCEPTANCE_MODEL_ID,
        createApplication: (context) =>
          createAcceptanceApplication(
            context,
            (value) => {
              inspection = value;
            },
            { modelSamplingOwnership: "execution" },
          ),
      },
      function* (s) {
        const turn = yield* s.conversation().send("PLACEMENT_HTTP_EXECUTION_V1");
        const request = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });
        yield* request.respond.text("PLACEMENT_HTTP_EXECUTION_COMPLETE");
        expect((yield* turn.settled()).text).toBe("PLACEMENT_HTTP_EXECUTION_COMPLETE");
        s.agui.assertConformant();
      },
    );
    expect(inspection?.modelSamplingExecutors).toEqual(["execution"]);
    expect(inspection?.modelSamplingProtocol).toContain("acknowledged");
  });
});
