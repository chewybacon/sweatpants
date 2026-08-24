import { run } from "effection";
import { describe, expect, it } from "vitest";
import {
  MODEL_SAMPLE_CONTRACT,
  MODEL_SAMPLE_CONTRACT_SCHEMA_ENTRIES,
  ModelSamplingApi,
  modelSampleRequestParser,
  runWithModelSamplingService,
  settleModelSample,
  type ModelSampleRequest,
  defaultModelSamplePlacementPolicy,
} from "../index.ts";

function validator(digest: string) {
  return MODEL_SAMPLE_CONTRACT_SCHEMA_ENTRIES.find((entry) => entry.descriptor.digest === digest)!
    .schema;
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
              type: "tool-call",
              toolCall: {
                id: "call-1",
                name: "lookup",
                input: { query: "open" },
                thoughtSignature: null,
              },
            },
          ],
        },
      ],
      tools: [],
    },
  },
  tools: { type: "none" },
  response: { type: "message" },
};

describe("durable model sampling", () => {
  it("keeps the semantic command local and journals only a bounded context source", async () => {
    const sourceRequest = {
      ...request,
      invocation: {
        context: {
          type: "object",
          object: { objectId: "context-object-1" },
          digest: "context-digest-1",
        },
      },
    };
    const parsed = await validator(MODEL_SAMPLE_CONTRACT.inputSchema.digest)["~standard"].validate(
      sourceRequest,
    );
    expect(parsed).toHaveProperty("value");
    expect(
      await validator(MODEL_SAMPLE_CONTRACT.inputSchema.digest)["~standard"].validate(request),
    ).toHaveProperty("issues");
    expect(modelSampleRequestParser.parse(request)).toEqual({ ok: true, value: request });
    expect(modelSampleRequestParser.parse({ ...request, unknown: true }).ok).toBe(false);
  });

  it("rejects oversized ingress collections", () => {
    expect(
      modelSampleRequestParser.parse({
        ...request,
        invocation: {
          context: {
            messages: Array.from({ length: 4_097 }, () => ({
              role: "user",
              content: "bounded",
            })),
            tools: [],
          },
        },
      }).ok,
    ).toBe(false);
  });

  it("rejects the removed loose request and unknown message roles", async () => {
    const schema = validator(MODEL_SAMPLE_CONTRACT.inputSchema.digest)["~standard"];
    expect(await schema.validate({ messages: [{ role: "user", content: "old" }] })).toHaveProperty(
      "issues",
    );
    expect(
      await schema.validate({
        ...request,
        invocation: {
          context: { messages: [{ role: "reasoning", content: "private" }], tools: [] },
        },
      }),
    ).toHaveProperty("issues");
  });

  it("decodes structured JSON before journaling without running an authored schema", () => {
    expect(
      settleModelSample(
        { type: "json", schema: { type: "object" } },
        {
          message: { role: "assistant", content: [{ type: "text", text: '{"value":7}' }] },
          source: null,
          usage: null,
          stopReason: null,
          responseId: null,
          errorMessage: null,
        },
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
        *sample([_command, evidence], next) {
          observed.push(`before:${evidence.taskId}`);
          const result = yield* next(_command, evidence);
          observed.push(`after:${result.status}`);
          return result;
        },
      });
      return yield* runWithModelSamplingService(
        {
          *sample() {
            return {
              status: "ok" as const,
              value: {
                message: {
                  message: {
                    role: "assistant" as const,
                    content: [{ type: "text" as const, text: "done" }],
                  },
                  source: null,
                  usage: null,
                  stopReason: null,
                  responseId: null,
                  errorMessage: null,
                },
                output: { type: "message" as const },
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
