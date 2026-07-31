import { describe, expect, it } from "vitest";
import { withTestScenario, type TestRigOptions } from "@sweatpants/test-rig";
import { ACCEPTANCE_MODEL_ID, createAcceptanceApplication } from "./lib/acceptance-app.ts";

type Binding = TestRigOptions["binding"];
type FailureKind = "error" | "partial" | "disconnect";

async function recoverConversation(binding: Binding, kind: FailureKind): Promise<void> {
  await withTestScenario(
    {
      binding,
      modelId: ACCEPTANCE_MODEL_ID,
      createApplication: createAcceptanceApplication,
      scenarioTimeoutMs: 30_000,
    },
    function* (s) {
      const conversation = s.conversation();
      const failedTurn = yield* conversation.send(`FAILURE_${kind.toUpperCase()}_V1`);
      const failedRequest = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });

      if (kind === "error") {
        yield* failedRequest.respond.error({
          code: "provider_unavailable",
          message: "planned provider failure",
          status: 503,
        });
      } else {
        const stream = yield* failedRequest.respond.textStream(["PARTIAL_V1"]);
        yield* stream.releaseNext();
        expect(yield* failedTurn.textDelta("PARTIAL_V1")).toMatchObject({ delta: "PARTIAL_V1" });
        if (kind === "partial") {
          yield* stream.fail({ code: "stream_failed", message: "planned stream failure" });
        } else {
          yield* stream.disconnect();
        }
      }

      yield* failedTurn.failure();
      const events = conversation.transcript().events;
      expect(events.filter((event) => event.type === "RUN_ERROR")).toHaveLength(1);
      expect(events.some((event) => event.type === "RUN_FINISHED")).toBe(false);
      if (kind !== "error") {
        expect(conversation.transcript().text).toContain("PARTIAL_V1");
      }

      const recoveryTurn = yield* conversation.send(`RECOVERY_AFTER_${kind.toUpperCase()}_V1`);
      const recoveryRequest = yield* s.model.request((request) => {
        const input = JSON.stringify(request.body.input);
        expect(input).toContain(`RECOVERY_AFTER_${kind.toUpperCase()}_V1`);
        if (kind !== "error") {
          expect(input).toContain("PARTIAL_V1");
        }
      });
      yield* recoveryRequest.respond.text(`RECOVERED_${kind.toUpperCase()}_V1`);
      const recovered = yield* recoveryTurn.settled();
      expect(recovered.outcome).toBe("success");
      expect(recovered.text).toBe(`RECOVERED_${kind.toUpperCase()}_V1`);
    },
  );
}

async function completeEmptyAssistant(binding: Binding): Promise<void> {
  await withTestScenario(
    { binding, modelId: ACCEPTANCE_MODEL_ID, createApplication: createAcceptanceApplication },
    function* (s) {
      const conversation = s.conversation();
      const turn = yield* conversation.send("EMPTY_ASSISTANT_V1");
      const request = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });
      yield* request.respond.text("");
      const transcript = yield* turn.settled();
      expect(transcript.outcome).toBe("success");
      expect(transcript.text).toBe("");

      const recoveryTurn = yield* conversation.send("RECOVERY_AFTER_EMPTY_ASSISTANT_V1");
      const recoveryRequest = yield* s.model.request((next) => {
        const input = JSON.stringify(next.body.input);
        expect(input).toContain("EMPTY_ASSISTANT_V1");
        expect(input).toContain("RECOVERY_AFTER_EMPTY_ASSISTANT_V1");
      });
      yield* recoveryRequest.respond.text("RECOVERED_AFTER_EMPTY_ASSISTANT_V1");
      expect((yield* recoveryTurn.settled()).text).toBe("RECOVERED_AFTER_EMPTY_ASSISTANT_V1");
    },
  );
}

describe("provider failure recovery", () => {
  it.each(["error", "partial"] as const)(
    "recovers the conversation after %s failure",
    async (kind) => {
      await recoverConversation("in-process", kind);
    },
    30_000,
  );

  it("completes an empty assistant response without hanging", async () => {
    await completeEmptyAssistant("in-process");
  });

  // binding-conformance: disconnect propagation crosses the real HTTP stream.
  it("recovers after provider disconnect over HTTP", async () => {
    await recoverConversation("http", "disconnect");
  }, 30_000);
});
