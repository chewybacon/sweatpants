import { race } from "effection";
import { describe, expect, it } from "vitest";
import {
  CALLER_AUTHORITATIVE_EXTENSION_URI,
  createA2AProgramDriver,
  createA2AProgramExecutor,
} from "@sweatpants/a2a";
import {
  createInProcessA2AConnector,
  createRegistryManifestProvider,
} from "@sweatpants/a2a/testing";
import { withTestScenario, type TestRigOptions } from "@sweatpants/test-rig";
import {
  ACCEPTANCE_DURABLE_TOOL_NAME,
  ACCEPTANCE_MODEL_ID,
  DURABLE_SAMPLE_PROMPT_MARKER,
  DURABLE_TOOL_RESULT_MARKER,
  acceptanceDurableTool,
  createAcceptanceApplication,
} from "./lib/acceptance-app.ts";

type Binding = TestRigOptions["binding"];

async function invokeRemoteStructuredChild(binding: Binding): Promise<void> {
  await withTestScenario(
    {
      binding,
      modelId: ACCEPTANCE_MODEL_ID,
      createApplication(context) {
        return createAcceptanceApplication(context, undefined, {
          durableDriverKind: "a2a",
          durableRoute: {
            driverKind: "a2a",
            protocolVersion: 1,
            extensionUri: CALLER_AUTHORITATIVE_EXTENSION_URI,
            executionId: "acceptance-subagent-execution",
            driverEndpoint: "wss://acceptance.invalid/programs",
            cardOrigin: "https://acceptance.invalid",
          },
          createDurableDriver(registry) {
            const executor = createA2AProgramExecutor({
              executorId: "acceptance-subagent-executor",
              computeGeneration: "generation-1",
              registry,
            });
            return createA2AProgramDriver({
              connector: createInProcessA2AConnector(executor),
              manifest: createRegistryManifestProvider(registry),
            });
          },
        });
      },
      scenarioTimeoutMs: 30_000,
    },
    function* (s) {
      const conversation = s.conversation({ tools: [acceptanceDurableTool] });
      const turn = yield* conversation.send("Delegate train selection to the A2A child");
      const outer = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });
      yield* outer.respond.toolCalls([
        {
          id: "a2a-subagent-call-1",
          name: ACCEPTANCE_DURABLE_TOOL_NAME,
          arguments: { topic: "a2a-subagent" },
        },
      ]);

      const nested = yield* race([
        s.model.request((request) => {
          expect(JSON.stringify(request.body.input)).toContain(DURABLE_SAMPLE_PROMPT_MARKER);
        }),
        (function* () {
          const failure = yield* turn.failure();
          throw new Error(`A2A child failed before nested sampling: ${failure.message}`);
        })(),
      ]);
      yield* nested.respond.text("A2A child recommends the express");

      const choice = yield* turn.elicit("chooseOption");
      expect(choice.context).toMatchObject({
        options: ["a2a-subagent-alpha", "a2a-subagent-beta"],
      });
      yield* choice.accept({ selected: "a2a-subagent-beta" });

      const final = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });
      const input = JSON.stringify(final.body.input);
      expect(input).toContain("a2a-subagent-call-1");
      expect(input).toContain(DURABLE_TOOL_RESULT_MARKER);
      expect(input).toContain("a2a-subagent-beta");
      yield* final.respond.text("A2A sub-agent completed.");
      expect((yield* turn.settled()).text).toBe("A2A sub-agent completed.");
    },
  );
}

describe.each<Binding>(["in-process", "http"])(
  "caller-authoritative A2A child through the %s chat binding",
  (binding) => {
    it("samples, elicits, replays, and returns through the remote executor protocol", async () => {
      await invokeRemoteStructuredChild(binding);
    }, 30_000);
  },
);
