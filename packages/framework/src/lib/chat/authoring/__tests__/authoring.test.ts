import { run, type Operation } from "effection";
import { describe, expect, it } from "vitest";
import {
  MODEL_SAMPLE_EFFECT,
  createDurableProgramContext,
  type Json,
  type ProgramResume,
  type ProgramStepProposal,
} from "@sweatpants/session-contract";
import {
  DURABLE_DRIVER_FIXTURE_SCHEMA_ENTRIES,
  DURABLE_DRIVER_FIXTURE_TOOLS,
} from "@sweatpants/session-contract/testing";
import { defineGuidance, defineResourcePackage, textResource } from "@sweatpants/core";
import {
  CHAT_MODEL_SAMPLE_EFFECT,
  acceptChatTurn,
  classifiedToolResult,
  createChatModelEffectRegistration,
  defineChatProgram,
  latestContextWindow,
  modelReadable,
  modelTool,
  normalizeChatTurnInput,
  selectChatContext,
  type ChatMessageV1,
  type ChatModelSampleOutputV2,
} from "../index.ts";

const emptyProvenance = { classifications: [], sourceDigests: [] };
function message(id: string, role: ChatMessageV1["role"], text: string): ChatMessageV1 {
  return { id, role, parts: [{ value: text, provenance: emptyProvenance }] };
}
const resources = defineResourcePackage({
  id: "review-guidance",
  version: "1",
  files: {
    "SKILL.md": textResource("Read references/checklist.md"),
    "references/checklist.md": textResource("Check authority boundaries"),
  },
});
const durableFixtureTool = DURABLE_DRIVER_FIXTURE_TOOLS[0]!;
const durableFixtureBinding = {
  program: durableFixtureTool,
  schemas: DURABLE_DRIVER_FIXTURE_SCHEMA_ENTRIES,
  resources: [],
};

const guidance = defineGuidance({
  id: "reviewing",
  summary: "Use for design reviews",
  package: resources,
  entryPath: "SKILL.md",
});

class BoundaryReached extends Error {}

async function drive(
  program: ReturnType<typeof chat>,
  input: Json,
  outcomes: ProgramResume[],
): Promise<{ proposals: ProgramStepProposal[]; result?: Json }> {
  const proposals: ProgramStepProposal[] = [];
  const remaining = [...outcomes];
  let result: Json | undefined;
  try {
    result = await run(function* () {
      const context = createDurableProgramContext(
        (proposal): Operation<ProgramResume> =>
          (function* () {
            proposals.push(proposal);
            if (remaining.length === 0) {
              throw new BoundaryReached();
            }
            return remaining.shift();
          })(),
      );
      return yield* program.program(input as never, context);
    });
  } catch (error) {
    if (!(error instanceof BoundaryReached)) {
      throw error;
    }
  }
  return { proposals, ...(result === undefined ? {} : { result }) };
}

function chat(
  prompt = "You are a reviewer",
  tools: Parameters<typeof defineChatProgram>[0]["tools"] = {},
) {
  return defineChatProgram({
    identity: { name: "review.chat", version: "1" },
    systemPrompt: { text: prompt, classification: "internal" },
    guidance: [guidance],
    resources: { guidance: modelReadable(resources, { classification: "internal" }) },
    tools,
    maxIterations: 3,
    sampling: { maxTokens: 500, toolChoice: "auto" },
  });
}

describe("durable chat authoring", () => {
  it("uses the one canonical model sampling contract without a bridge contract", () => {
    expect(CHAT_MODEL_SAMPLE_EFFECT).toBe(MODEL_SAMPLE_EFFECT);
  });
  it("selects one bounded explicit-first context snapshot", () => {
    const policy = latestContextWindow({
      maxMessages: 2,
      maxReferencedTasks: 1,
      maxCanonicalBytes: 16_000,
    });
    const selected = selectChatContext(policy, {
      frontier: "frontier-7",
      referenceTaskIds: ["task-a", "task-a", "task-b"],
      referencedTasks: [
        { taskId: "task-a", summary: message("summary-a", "assistant", "A") },
        { taskId: "task-b", summary: message("summary-b", "assistant", "B") },
      ],
      messages: [
        message("m1", "user", "one"),
        message("m2", "assistant", "two"),
        message("m3", "user", "three"),
      ],
    });
    expect(selected.referenceTaskIds).toEqual(["task-a", "task-b"]);
    expect(selected.referencedTasks.map((item) => item.taskId)).toEqual(["task-a"]);
    expect(selected.messages.map((item) => item.id)).toEqual(["m2", "m3"]);
    expect(selected.truncation).toEqual({ omittedMessages: 1, omittedReferencedTasks: 1 });
    expect(
      selectChatContext(policy, {
        frontier: "frontier-7",
        messages: [message("m1", "user", "one")],
      }).policyDigest,
    ).toBe(policy.digest);
  });

  it("normalizes references once and rejects malformed closed input", () => {
    const policy = latestContextWindow();
    const accepted = acceptChatTurn(policy, message("current", "user", "hello"), {
      frontier: "f",
      referenceTaskIds: ["a", "a"],
    });
    expect(accepted.context.referenceTaskIds).toEqual(["a"]);
    expect(normalizeChatTurnInput(accepted)).toEqual(accepted);
    expect(() => normalizeChatTurnInput({ ...accepted, transport: "a2a" })).toThrowError(
      expect.objectContaining({ code: "invalid_chat_program" }),
    );
  });

  it("produces a generated program whose first durable boundary is classified model.sample", async () => {
    const program = chat();
    const input = acceptChatTurn(program.contextPolicy, message("current", "user", "Review this"), {
      frontier: "f",
    });
    const output: ChatModelSampleOutputV2 = {
      message: message("answer", "assistant", "Looks good"),
      calls: [],
      artifacts: [],
    };
    const driven = await drive(program, input as unknown as Json, [
      { status: "ok", value: output as unknown as Json },
    ]);
    const first = driven.proposals[0];
    if (first?.type !== "operation" || first.descriptor.kind !== "effect") {
      throw new Error("expected effect");
    }
    expect(first.descriptor.name).toBe("model.sample");
    expect(first.descriptor.version).toBe("2");
    expect((first.descriptor.input as Record<string, Json>)["classifications"]).toEqual([
      "internal",
    ]);
    expect(driven.result).toEqual({
      format: "sweatpants.chat-turn-result.v1",
      message: output.message,
      artifacts: [],
    });
    expect(program.identityProvenance.kind).toBe("generated-artifact");
  });

  it("loads guidance through an exact durable reader child before the next classified sample", async () => {
    const program = chat();
    const input = acceptChatTurn(
      program.contextPolicy,
      message("current", "user", "Load the review guidance"),
      { frontier: "f" },
    );
    const readerCall: ChatModelSampleOutputV2 = {
      message: message("assistant-call", "assistant", "Loading guidance"),
      calls: [{ id: "read-1", target: "resources.read", input: { uri: guidance.entryUri } }],
      artifacts: [],
    };
    const readerResult = {
      kind: "text",
      text: "Check authority boundaries",
      mediaType: "text/markdown",
      packageDigest: resources.manifest.digest,
      fileDigest: resources.manifest.files["SKILL.md"]!.digest,
      classifications: ["internal"],
      sources: [
        {
          packageDigest: resources.manifest.digest,
          fileDigest: resources.manifest.files["SKILL.md"]!.digest,
        },
      ],
    } as unknown as Json;
    const driven = await drive(program, input as unknown as Json, [
      { status: "ok", value: readerCall as unknown as Json },
      { status: "ok", value: readerResult },
    ]);
    const child = driven.proposals[1];
    if (child?.type !== "operation" || child.descriptor.kind !== "invoke") {
      throw new Error("expected resource reader child");
    }
    expect(child.descriptor.child.digest).toBe(program.resourceReaders.read.manifest.digest);
    const nextSample = driven.proposals[2];
    if (nextSample?.type !== "operation" || nextSample.descriptor.kind !== "effect") {
      throw new Error("expected second model sample");
    }
    expect((nextSample.descriptor.input as Record<string, Json>)["classifications"]).toEqual([
      "internal",
    ]);
    expect(JSON.stringify(nextSample.descriptor.input)).toContain("Check authority boundaries");
  });

  it("taints arbitrary tool results from the declared binding ceiling, not payload shape", async () => {
    const sampleAfter = async (
      classification: "restricted" | "public",
      id: string,
      value: Json,
    ) => {
      const program = chat("You are a reviewer", {
        inspect: modelTool(durableFixtureBinding, { resultClassification: classification }),
      });
      const input = acceptChatTurn(program.contextPolicy, message("current", "user", "inspect"), {
        frontier: "f",
      });
      const call = {
        message: message("call", "assistant", "inspecting"),
        calls: [{ id, target: "inspect", input: classification === "public" ? "safe" : "derived" }],
        artifacts: [],
      } as unknown as Json;
      const driven = await drive(program, input as unknown as Json, [
        { status: "ok", value: call },
        { status: "ok", value },
      ]);
      const proposal = driven.proposals[2];
      if (proposal?.type !== "operation" || proposal.descriptor.kind !== "effect") {
        throw new Error("expected classified sample");
      }
      return proposal.descriptor;
    };

    const restricted = await sampleAfter("restricted", "inspect-1", {
      derivedText: "restricted source without voluntary provenance",
    });
    expect((restricted.input as Record<string, Json>)["classifications"]).toEqual([
      "internal",
      "restricted",
    ]);

    const publicDescriptor = await sampleAfter("public", "inspect-2", {
      classifications: ["restricted"],
      ordinaryBusinessField: true,
    });
    expect((publicDescriptor.input as Record<string, Json>)["classifications"]).toEqual([
      "internal",
      "public",
    ]);
  });

  it("uses an explicit classified-result envelope to raise a declared ceiling", async () => {
    const program = chat("You are a reviewer", {
      inspect: modelTool(durableFixtureBinding, { resultClassification: "public" }),
    });
    const input = acceptChatTurn(program.contextPolicy, message("current", "user", "inspect"), {
      frontier: "f",
    });
    const driven = await drive(program, input as unknown as Json, [
      {
        status: "ok",
        value: {
          message: message("call", "assistant", "inspecting"),
          calls: [{ id: "inspect-3", target: "inspect", input: "safe" }],
          artifacts: [],
        } as unknown as Json,
      },
      {
        status: "ok",
        value: classifiedToolResult(
          { text: "derived" },
          { classifications: ["restricted"] },
        ) as Json,
      },
    ]);
    const next = driven.proposals[2];
    if (next?.type !== "operation" || next.descriptor.kind !== "effect") {
      throw new Error("expected raised classification");
    }
    expect((next.descriptor.input as Record<string, Json>)["classifications"]).toEqual([
      "internal",
      "restricted",
    ]);
  });

  it("rejects reserved reader aliases and dead v1 elicitation declarations", () => {
    expect(() =>
      chat("reserved", {
        "resources.read": modelTool(durableFixtureBinding, {
          resultClassification: "public",
        }),
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_chat_program" }));
    expect(() =>
      defineChatProgram({
        identity: { name: "invalid.elicit", version: "1" },
        systemPrompt: { text: "prompt", classification: "public" },
        elicitations: {
          ask: { response: durableFixtureTool.manifest.inputSchema },
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_chat_program" }));
  });

  it("rejects an unauthorized exact sample payload before provider invocation", async () => {
    let providerCalls = 0;
    const registration = createChatModelEffectRegistration({
      allowedClassifications: ["public"],
      *sample() {
        providerCalls += 1;
        return { message: message("answer", "assistant", "no"), calls: [], artifacts: [] };
      },
    });
    await expect(
      run(() =>
        registration.handler(
          {
            messages: [],
            systemPrompt: {
              value: "secret",
              provenance: { classifications: ["restricted"], sourceDigests: [] },
            },
            tools: [],
            classifications: ["restricted"],
            sampling: {},
          },
          {
            sessionId: "s",
            taskId: "t",
            pullId: "p",
            attemptId: "a",
            cancellation: new AbortController().signal,
            resolver: { audience: "model-runtime" },
          },
        ),
      ),
    ).rejects.toMatchObject({ code: "model_egress_forbidden" });
    expect(providerCalls).toBe(0);
  });

  it("validates provider output again at the model-effect handler boundary", async () => {
    const registration = createChatModelEffectRegistration({
      allowedClassifications: ["public"],
      *sample() {
        return { invalid: true } as never;
      },
    });
    await expect(
      run(() =>
        registration.handler(
          {
            messages: [],
            systemPrompt: {
              value: "public",
              provenance: { classifications: ["public"], sourceDigests: [] },
            },
            tools: [],
            classifications: ["public"],
            sampling: {},
          },
          {
            sessionId: "s",
            taskId: "t",
            pullId: "p",
            attemptId: "a",
            cancellation: new AbortController().signal,
            resolver: { audience: "model-runtime" },
          },
        ),
      ),
    ).rejects.toMatchObject({ code: "invalid_chat_program" });
  });

  it("matches the independently frozen chat-program digest vector", () => {
    expect(chat().manifest.digest).toBe(
      "b66230c7aab573660649f86cfa9351e12d8485da943bd16f3afb147b7f0daf07",
    );
  });

  it("covers prompt and resource readers in generated identity", () => {
    const first = chat("one");
    const changed = chat("two");
    expect(changed.manifest.digest).not.toBe(first.manifest.digest);
    expect(first.resourceReaders.read.identityProvenance.kind).toBe("generated-artifact");
    expect(first.configuration).not.toHaveProperty("provider");
  });
});
