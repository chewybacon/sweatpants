import { run } from "effection";
import { describe, expect, it } from "vitest";
import {
  MODEL_SAMPLE_EFFECT,
  MODEL_SAMPLE_SCHEMA_ENTRIES,
  ModelSamplingApi,
  runWithModelSamplingService,
  settleModelSample,
  type ModelSampleRequest,
  defaultModelSamplePlacementPolicy,
} from "../index.ts";

function validator(digest: string) {
  return MODEL_SAMPLE_SCHEMA_ENTRIES.find((entry) => entry.descriptor.digest === digest)!.schema;
}

const request: ModelSampleRequest = {
  invocation: {
    context: {
      messages: [
        { role: "user", content: "hello" },
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              toolCall: {
                id: "call-1",
                type: "function",
                function: { name: "lookup", arguments: { query: "open" } },
              },
            },
          ],
        },
      ],
    },
  },
  tools: { type: "none" },
  response: { type: "message" },
};

describe("durable model sampling", () => {
  it("parses the closed command once while retaining open tool arguments", async () => {
    const parsed = await validator(MODEL_SAMPLE_EFFECT.inputSchema.digest)["~standard"].validate(
      request,
    );
    expect(parsed).toEqual({ value: request });
  });

  it("rejects the removed loose request and unknown message roles", async () => {
    const schema = validator(MODEL_SAMPLE_EFFECT.inputSchema.digest)["~standard"];
    expect(await schema.validate({ messages: [{ role: "user", content: "old" }] })).toHaveProperty(
      "issues",
    );
    expect(
      await schema.validate({
        ...request,
        invocation: { context: { messages: [{ role: "activity", content: "private" }] } },
      }),
    ).toHaveProperty("issues");
  });

  it("decodes structured JSON before journaling without running an authored schema", () => {
    expect(
      settleModelSample(
        { type: "json", schema: { type: "object" } },
        { role: "assistant", content: [{ type: "text", text: '{"value":7}' }] },
      ),
    ).toMatchObject({ output: { type: "json", value: { value: 7 } } });
  });

  it("keeps outer delivery on the Host and permits trusted private execution", () => {
    expect(
      defaultModelSamplePlacementPolicy.decide({
        caller: "chat-root",
        hostAvailable: true,
        executionAvailable: true,
        executionTrusted: true,
        requiresOuterDelivery: true,
        classifications: [],
      }),
    ).toMatchObject({ executor: "host" });
    expect(
      defaultModelSamplePlacementPolicy.decide({
        caller: "nested-program",
        hostAvailable: true,
        executionAvailable: true,
        executionTrusted: true,
        requiresOuterDelivery: false,
        classifications: ["private"],
      }),
    ).toMatchObject({ executor: "execution" });
  });

  it("fails closed when neither authorized executor is available", () => {
    expect(
      defaultModelSamplePlacementPolicy.decide({
        caller: "nested-program",
        hostAvailable: false,
        executionAvailable: true,
        executionTrusted: false,
        requiresOuterDelivery: false,
        classifications: ["restricted"],
      }),
    ).toMatchObject({ executor: "reject", code: "model_sampling_placement_unavailable" });
  });

  it("supports scoped semantic middleware around the installed service", async () => {
    const observed: string[] = [];
    await run(function* () {
      yield* ModelSamplingApi.around({
        *sample([command, evidence], next) {
          observed.push(`before:${evidence.taskId}`);
          const result = yield* next(command, evidence);
          observed.push(`after:${result.status}`);
          return result;
        },
      });
      return yield* runWithModelSamplingService(
        {
          *sample() {
            return {
              status: "ok",
              value: {
                message: { role: "assistant", content: [{ type: "text", text: "done" }] },
                output: { type: "message" },
              },
            };
          },
        },
        function* () {
          return yield* ModelSamplingApi.operations.sample(request, {
            placement: {
              journal: { id: "journal", incarnation: "1" },
              program: { id: "program", version: "1", digest: "a".repeat(64) },
              route: {},
              driverKind: "program",
            },
            sessionId: "session",
            taskId: "task",
            pullId: "pull",
            attemptId: "attempt",
            effectContractDigest: "b".repeat(64),
            cancellation: new AbortController().signal,
          });
        },
      );
    });
    expect(observed).toEqual(["before:task", "after:ok"]);
  });
});
