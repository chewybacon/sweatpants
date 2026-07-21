import { run } from "effection";
import { describe, expect, it } from "vitest";
import { withTestRig, type TestRigOptions } from "@sweatpants/test-rig";
import {
  ACCEPTANCE_DURABLE_TOOL_NAME,
  ACCEPTANCE_MODEL_ID,
  ACCEPTANCE_TOOL_NAME,
  DURABLE_SAMPLE_PROMPT_MARKER,
  NESTED_SAMPLE_PROMPT_MARKER,
  acceptanceBookingTool,
  acceptanceDurableTool,
  createAcceptanceApplication,
  type AcceptanceApplicationInspection,
} from "./lib/acceptance-app.ts";

type Binding = TestRigOptions["binding"];

async function supersedeParkedOrdinaryTool(binding: Binding): Promise<void> {
  let inspection: AcceptanceApplicationInspection | undefined;
  await withTestRig(
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
    async (rig) => {
      const conversation = rig.chat.conversation({ tools: [acceptanceBookingTool] });
      const outerPromise = rig.model.expectRequest({ model: ACCEPTANCE_MODEL_ID });
      const oldTurn = conversation.send("SUPERSEDE_ORDINARY_OLD_V1");
      const elicitPromise = oldTurn.expectElicit("pickFlight");
      await (
        await outerPromise
      ).respond.toolCalls([
        {
          id: "supersede-ordinary-call",
          name: ACCEPTANCE_TOOL_NAME,
          arguments: { from: "NYC", destination: "LAX" },
        },
      ]);
      await elicitPromise;

      const replacementPromise = rig.model.expectRequest((request) => {
        const input = JSON.stringify(request.body.input);
        expect(input).toContain("SUPERSEDE_ORDINARY_NEW_V1");
        expect(input).toContain("supersede-ordinary-call");
        expect(input).toMatch(/cancel/i);
        expect(input).not.toContain(NESTED_SAMPLE_PROMPT_MARKER);
      });
      const replacement = conversation.supersede("SUPERSEDE_ORDINARY_NEW_V1");
      await expect(oldTurn.complete()).rejects.toThrow(/turn_superseded/);
      await (await replacementPromise).respond.text("SUPERSEDE_ORDINARY_RECOVERED_V1");
      expect((await replacement.complete()).text).toBe("SUPERSEDE_ORDINARY_RECOVERED_V1");
      if (!inspection?.toolSessionRegistry) {
        throw new Error("tool session registry inspection unavailable");
      }
      const registry = inspection.toolSessionRegistry;
      const leaked = await run(function* () {
        return yield* registry.get(`foreign:${conversation.conversationId}:turn-0/root.0`);
      });
      expect(leaked).toBeNull();
    },
  );
}

async function supersedeParkedDurableTool(binding: Binding): Promise<void> {
  await withTestRig(
    {
      binding,
      modelId: ACCEPTANCE_MODEL_ID,
      cancellationTimeoutMs: 15_000,
      createApplication: createAcceptanceApplication,
    },
    async (rig) => {
      const conversation = rig.chat.conversation({ tools: [acceptanceDurableTool] });
      const outerPromise = rig.model.expectRequest({ model: ACCEPTANCE_MODEL_ID });
      const oldTurn = conversation.send("SUPERSEDE_DURABLE_OLD_V1");
      const elicitPromise = oldTurn.expectElicit("chooseOption");
      const nestedPromise = rig.model.expectRequest((request) => {
        expect(JSON.stringify(request.body.input)).toContain(DURABLE_SAMPLE_PROMPT_MARKER);
      });
      await (
        await outerPromise
      ).respond.toolCalls([
        {
          id: "supersede-durable-call",
          name: ACCEPTANCE_DURABLE_TOOL_NAME,
          arguments: { topic: "durable" },
        },
      ]);
      await (await nestedPromise).respond.text("durable nested response");
      await elicitPromise;

      const replacementPromise = rig.model.expectRequest((request) => {
        const input = JSON.stringify(request.body.input);
        expect(input).toContain("SUPERSEDE_DURABLE_NEW_V1");
        expect(input).toContain("supersede-durable-call");
        expect(input).toMatch(/cancel/i);
        expect(input).not.toContain(DURABLE_SAMPLE_PROMPT_MARKER);
      });
      const replacement = conversation.supersede("SUPERSEDE_DURABLE_NEW_V1");
      await expect(oldTurn.complete()).rejects.toThrow(/turn_superseded/);
      await (await replacementPromise).respond.text("SUPERSEDE_DURABLE_RECOVERED_V1");
      expect((await replacement.complete()).text).toBe("SUPERSEDE_DURABLE_RECOVERED_V1");
    },
  );
}

async function cancelDurableNestedSample(binding: Binding): Promise<void> {
  await withTestRig(
    {
      binding,
      modelId: ACCEPTANCE_MODEL_ID,
      cancellationTimeoutMs: 15_000,
      createApplication: createAcceptanceApplication,
    },
    async (rig) => {
      const conversation = rig.chat.conversation({ tools: [acceptanceDurableTool] });
      const outerPromise = rig.model.expectRequest({ model: ACCEPTANCE_MODEL_ID });
      const turn = conversation.send("CANCEL_DURABLE_SAMPLE_V1");
      const nestedPromise = rig.model.expectRequest((request) => {
        expect(JSON.stringify(request.body.input)).toContain(DURABLE_SAMPLE_PROMPT_MARKER);
      });
      await (
        await outerPromise
      ).respond.toolCalls([
        {
          id: "cancel-durable-call",
          name: ACCEPTANCE_DURABLE_TOOL_NAME,
          arguments: { topic: "cancel" },
        },
      ]);
      const nested = await nestedPromise;
      const providerAborted = nested.respond.awaitAbort();
      await turn.cancel();
      await providerAborted;
      await expect(turn.complete()).rejects.toThrow();

      const recoveryPromise = rig.model.expectRequest({ model: ACCEPTANCE_MODEL_ID });
      const recoveryConversation = rig.chat.conversation({
        conversationId: `post-durable-cancel-${binding}`,
      });
      const recovery = recoveryConversation.send("RECOVER_AFTER_DURABLE_CANCEL_V1");
      await (await recoveryPromise).respond.text("DURABLE_CANCEL_RECOVERED_V1");
      expect((await recovery.complete()).text).toBe("DURABLE_CANCEL_RECOVERED_V1");
      expect(conversation.transcript().text).not.toContain("durable nested response");
    },
  );
}

describe.each<Binding>(["in-process", "http"])(
  "turn cancellation through the %s binding",
  (binding) => {
    it("supersedes a parked ordinary tool", async () => {
      await supersedeParkedOrdinaryTool(binding);
    }, 30_000);

    it("supersedes a parked durable tool", async () => {
      await supersedeParkedDurableTool(binding);
    }, 30_000);

    it("cancels a durable child while nested sampling is pending", async () => {
      await cancelDurableNestedSample(binding);
    }, 30_000);
  },
);
