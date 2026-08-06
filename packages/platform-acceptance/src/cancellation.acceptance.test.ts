import { spawn } from "effection";
import { describe, expect, it } from "vitest";
import { withTestScenario, type TestRigOptions } from "@sweatpants/test-rig";
import {
  ACCEPTANCE_DURABLE_TOOL_NAME,
  ACCEPTANCE_MODEL_ID,
  ACCEPTANCE_TOOL_NAME,
  DURABLE_SAMPLE_PROMPT_MARKER,
  NESTED_SAMPLE_PROMPT_MARKER,
  createAcceptanceApplication,
  type AcceptanceApplicationInspection,
} from "./lib/acceptance-app.ts";

type Binding = TestRigOptions["binding"];

async function supersedeParkedOrdinaryTool(binding: Binding): Promise<void> {
  let inspection: AcceptanceApplicationInspection | undefined;
  await withTestScenario(
    {
      binding,
      modelId: ACCEPTANCE_MODEL_ID,
      cancellationTimeoutMs: 15_000,
      createApplication(context) {
        return createAcceptanceApplication(context, (created) => {
          inspection = created;
        });
      },
    },
    function* (s) {
      const conversation = s.conversation();
      const oldTurn = yield* conversation.send({ text: "SUPERSEDE_ORDINARY_OLD_V1" });
      const outer = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });
      yield* outer.respond.toolCalls([
        {
          id: "supersede-ordinary-call",
          name: ACCEPTANCE_TOOL_NAME,
          arguments: { from: "NYC", destination: "LAX" },
        },
      ]);
      yield* oldTurn.elicit("pickFlight");

      const replacement = yield* conversation.supersede({ text: "SUPERSEDE_ORDINARY_NEW_V1" });
      yield* oldTurn.failure(/turn_superseded/);
      const replacementRequest = yield* s.model.request((request) => {
        const input = JSON.stringify(request.body.input);
        expect(input).toContain("SUPERSEDE_ORDINARY_NEW_V1");
        expect(input).toContain("supersede-ordinary-call");
        expect(input).toMatch(/cancel/i);
        expect(input).not.toContain(NESTED_SAMPLE_PROMPT_MARKER);
      });
      yield* replacementRequest.respond.text("SUPERSEDE_ORDINARY_RECOVERED_V1");
      expect((yield* replacement.settled()).text).toBe("SUPERSEDE_ORDINARY_RECOVERED_V1");

      if (!inspection?.toolSessionRegistry) {
        throw new Error("tool session registry inspection unavailable");
      }
      // Registry cleanup runs when the released session settles, so wait on that
      // semantic boundary instead of sampling the store as the Turn settles.
      yield* inspection.toolSessionsDrained();
      const leaked = yield* inspection.toolSessionRegistry.get(
        `foreign:${conversation.conversationId}:turn-0/root.0`,
      );
      expect(leaked).toBeNull();
      expect(inspection.toolSessionIds).toEqual([]);
    },
  );
}

async function supersedeParkedDurableTool(binding: Binding): Promise<void> {
  await withTestScenario(
    {
      binding,
      modelId: ACCEPTANCE_MODEL_ID,
      cancellationTimeoutMs: 15_000,
      createApplication: createAcceptanceApplication,
    },
    function* (s) {
      const conversation = s.conversation();
      const oldTurn = yield* conversation.send({ text: "SUPERSEDE_DURABLE_OLD_V1" });
      const outer = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });
      yield* outer.respond.toolCalls([
        {
          id: "supersede-durable-call",
          name: ACCEPTANCE_DURABLE_TOOL_NAME,
          arguments: { topic: "durable" },
        },
      ]);
      const nested = yield* s.model.request((request) => {
        expect(JSON.stringify(request.body.input)).toContain(DURABLE_SAMPLE_PROMPT_MARKER);
      });
      yield* nested.respond.text("durable nested response");
      yield* oldTurn.elicit("chooseOption");

      const replacement = yield* conversation.supersede({ text: "SUPERSEDE_DURABLE_NEW_V1" });
      yield* oldTurn.failure(/turn_superseded/);
      const replacementRequest = yield* s.model.request((request) => {
        const input = JSON.stringify(request.body.input);
        expect(input).toContain("SUPERSEDE_DURABLE_NEW_V1");
        expect(input).toContain("supersede-durable-call");
        expect(input).toMatch(/cancel/i);
        expect(input).not.toContain(DURABLE_SAMPLE_PROMPT_MARKER);
      });
      yield* replacementRequest.respond.text("SUPERSEDE_DURABLE_RECOVERED_V1");
      expect((yield* replacement.settled()).text).toBe("SUPERSEDE_DURABLE_RECOVERED_V1");
    },
  );
}

async function cancelDurableNestedSample(binding: Binding): Promise<void> {
  await withTestScenario(
    {
      binding,
      modelId: ACCEPTANCE_MODEL_ID,
      cancellationTimeoutMs: 15_000,
      createApplication: createAcceptanceApplication,
    },
    function* (s) {
      const conversation = s.conversation();
      const turn = yield* conversation.send({ text: "CANCEL_DURABLE_SAMPLE_V1" });
      const outer = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });
      yield* outer.respond.toolCalls([
        {
          id: "cancel-durable-call",
          name: ACCEPTANCE_DURABLE_TOOL_NAME,
          arguments: { topic: "cancel" },
        },
      ]);
      const nested = yield* s.model.request((request) => {
        expect(JSON.stringify(request.body.input)).toContain(DURABLE_SAMPLE_PROMPT_MARKER);
      });

      const providerAborted = yield* spawn(() => nested.respond.awaitAbort());
      yield* turn.cancel();
      yield* providerAborted;
      yield* turn.failure();

      const recovered = yield* conversation.reopen();
      expect(recovered.conversationId).toBe(conversation.conversationId);
      const recoveryTurn = yield* recovered.send({ text: "RECOVER_AFTER_DURABLE_CANCEL_V1" });
      const recovery = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });
      yield* recovery.respond.text("DURABLE_CANCEL_RECOVERED_V1");
      expect((yield* recoveryTurn.settled()).text).toBe("DURABLE_CANCEL_RECOVERED_V1");
      expect(conversation.transcript().text).not.toContain("durable nested response");
    },
  );
}

describe("turn cancellation semantics", () => {
  it("supersedes a parked ordinary tool", async () => {
    await supersedeParkedOrdinaryTool("in-process");
  }, 30_000);

  it("supersedes a parked durable tool", async () => {
    await supersedeParkedDurableTool("in-process");
  }, 30_000);

  it("cancels a durable child while nested sampling is pending", async () => {
    await cancelDurableNestedSample("in-process");
  }, 30_000);

  // binding-conformance: cancellation must propagate through a real HTTP body.
  it("propagates nested durable cancellation over HTTP", async () => {
    await cancelDurableNestedSample("http");
  }, 30_000);
});
