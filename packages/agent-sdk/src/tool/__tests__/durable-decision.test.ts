import { expect, it } from "vitest";
import { run } from "effection";
import { z } from "zod";
import {
  MODEL_DECISION_EFFECT,
  MODEL_DECISION_SCHEMA_ENTRIES,
  type DecisionRequest,
} from "@sweatpants/model-decision";
import {
  createTestDurableProgramContext,
  type TestProgramStepProposal,
} from "@sweatpants/durable-execution/testing";
import { createDurableTool } from "../durable-create.ts";

const request: DecisionRequest = {
  input: "hello",
  question: {
    type: "choice",
    instructions: "Choose",
    choices: [
      { value: "a", description: "A" },
      { value: "b", description: "B" },
    ],
  },
};
const binding = { provider: "opencode", id: "jev-1.13" };

it("declares one canonical decision effect, pins the binding, and composes with sampling", async () => {
  const builder = createDurableTool("decider", { version: "1" })
    .description("Decide")
    .parameters(z.object({}));
  const tool = builder
    .decisions(binding)
    .samples()
    .execute(function* (_, ctx) {
      return yield* ctx.decision(request);
    });
  const other = builder
    .samples()
    .decisions({ ...binding, id: "different" })
    .execute(function* (_, ctx) {
      return yield* ctx.decision(request);
    });
  expect(tool.manifest.digest).not.toBe(other.manifest.digest);
  expect(tool.manifest.effects[MODEL_DECISION_EFFECT.name]).toEqual(MODEL_DECISION_EFFECT);
  expect(tool.manifest.pulls?.sample).toBeDefined();
  for (const entry of MODEL_DECISION_SCHEMA_ENTRIES) {
    expect(tool.artifacts.catalog).toContain(entry);
  }
  const proposals: TestProgramStepProposal[] = [];
  const result = await run(() =>
    tool.program(
      {},
      createTestDurableProgramContext(function* (proposal) {
        proposals.push(proposal);
        return {
          status: "ok",
          value: { answer: { type: "refusal" }, model: binding, usage: null },
        };
      }),
    ),
  );
  expect(result.answer).toEqual({ type: "refusal" });
  expect(proposals).toEqual([
    expect.objectContaining({
      type: "operation",
      descriptor: {
        kind: "effect",
        name: "model.decision",
        version: "1",
        input: { binding, request },
        resolver: { audience: "effect:model.decision" },
      },
    }),
  ]);
});

it("requires explicit opt-in and rejects duplicate capability declarations", () => {
  const builder = createDurableTool("decider", { version: "1" })
    .description("Decide")
    .parameters(z.object({}));
  builder.execute(function* (_, ctx) {
    // @ts-expect-error decision requires .decisions(binding)
    return yield* ctx.decision(request);
  });
  expect(() => builder.decisions(binding).decisions(binding)).toThrow("already declared");
});
