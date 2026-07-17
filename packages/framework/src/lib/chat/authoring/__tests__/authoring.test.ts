import { run } from "effection";
import { describe, expect, it } from "vitest";
import { createDurableProgramContext, type Json } from "@sweatpants/session-contract";
import {
  DURABLE_DRIVER_FIXTURE_SCHEMA_ENTRIES,
  DURABLE_DRIVER_FIXTURE_TOOLS,
} from "@sweatpants/session-contract/testing";
import { defineGuidance, defineResourcePackage, textResource } from "@sweatpants/core";
import {
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

  it("produces a generated program whose first durable boundary is classified model.sample", () => {
    const program = chat();
    const input = acceptChatTurn(program.contextPolicy, message("current", "user", "Review this"), {
      frontier: "f",
    });
    const generator = program.program(
      input as unknown as Json & typeof input,
      createDurableProgramContext(),
    );
    const first = generator.next();
    expect(first.done).toBe(false);
    if (
      first.done ||
      first.value.type !== "operation" ||
      first.value.descriptor.kind !== "effect"
    ) {
      throw new Error("expected effect");
    }
    expect(first.value.descriptor.name).toBe("model.sample");
    expect(first.value.descriptor.version).toBe("2");
    expect((first.value.descriptor.input as Record<string, Json>)["classifications"]).toEqual([
      "internal",
    ]);
    const output: ChatModelSampleOutputV2 = {
      message: message("answer", "assistant", "Looks good"),
      calls: [],
      artifacts: [],
    };
    const terminal = generator.next({ status: "ok", value: output as unknown as Json });
    expect(terminal.done).toBe(true);
    expect(terminal.value).toEqual({
      format: "sweatpants.chat-turn-result.v1",
      message: output.message,
      artifacts: [],
    });
    expect(program.identityProvenance.kind).toBe("generated-artifact");
  });

  it("loads guidance through an exact durable reader child before the next classified sample", () => {
    const program = chat();
    const input = acceptChatTurn(
      program.contextPolicy,
      message("current", "user", "Load the review guidance"),
      { frontier: "f" },
    );
    const generator = program.program(
      input as unknown as Json & typeof input,
      createDurableProgramContext(),
    );
    generator.next();
    const readerCall: ChatModelSampleOutputV2 = {
      message: message("assistant-call", "assistant", "Loading guidance"),
      calls: [{ id: "read-1", target: "resources.read", input: { uri: guidance.entryUri } }],
      artifacts: [],
    };
    const child = generator.next({ status: "ok", value: readerCall as unknown as Json });
    expect(child.done).toBe(false);
    if (
      child.done ||
      child.value.type !== "operation" ||
      child.value.descriptor.kind !== "invoke"
    ) {
      throw new Error("expected resource reader child");
    }
    expect(child.value.descriptor.child.digest).toBe(program.resourceReaders.read.manifest.digest);
    const nextSample = generator.next({
      status: "ok",
      value: {
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
      },
    });
    expect(nextSample.done).toBe(false);
    if (
      nextSample.done ||
      nextSample.value.type !== "operation" ||
      nextSample.value.descriptor.kind !== "effect"
    ) {
      throw new Error("expected second model sample");
    }
    expect((nextSample.value.descriptor.input as Record<string, Json>)["classifications"]).toEqual([
      "internal",
    ]);
    expect(JSON.stringify(nextSample.value.descriptor.input)).toContain(
      "Check authority boundaries",
    );
  });

  it("taints arbitrary tool results from the declared binding ceiling, not payload shape", () => {
    const restrictedProgram = chat("You are a reviewer", {
      inspect: modelTool(durableFixtureBinding, { resultClassification: "restricted" }),
    });
    const restrictedGenerator = restrictedProgram.program(
      acceptChatTurn(restrictedProgram.contextPolicy, message("current", "user", "inspect"), {
        frontier: "f",
      }) as unknown as Json & ReturnType<typeof acceptChatTurn>,
      createDurableProgramContext(),
    );
    restrictedGenerator.next();
    restrictedGenerator.next({
      status: "ok",
      value: {
        message: message("call", "assistant", "inspecting"),
        calls: [{ id: "inspect-1", target: "inspect", input: "derived" }],
        artifacts: [],
      },
    });
    const restrictedSample = restrictedGenerator.next({
      status: "ok",
      value: { derivedText: "restricted source without voluntary provenance" },
    });
    if (
      restrictedSample.done ||
      restrictedSample.value.type !== "operation" ||
      restrictedSample.value.descriptor.kind !== "effect"
    ) {
      throw new Error("expected classified sample");
    }
    expect(
      (restrictedSample.value.descriptor.input as Record<string, Json>)["classifications"],
    ).toEqual(["internal", "restricted"]);

    const publicProgram = chat("You are a reviewer", {
      inspect: modelTool(durableFixtureBinding, { resultClassification: "public" }),
    });
    const publicGenerator = publicProgram.program(
      acceptChatTurn(publicProgram.contextPolicy, message("current", "user", "inspect"), {
        frontier: "f",
      }) as unknown as Json & ReturnType<typeof acceptChatTurn>,
      createDurableProgramContext(),
    );
    publicGenerator.next();
    publicGenerator.next({
      status: "ok",
      value: {
        message: message("call", "assistant", "inspecting"),
        calls: [{ id: "inspect-2", target: "inspect", input: "safe" }],
        artifacts: [],
      },
    });
    const shapeCollisionSample = publicGenerator.next({
      status: "ok",
      value: { classifications: ["restricted"], ordinaryBusinessField: true },
    });
    if (
      shapeCollisionSample.done ||
      shapeCollisionSample.value.type !== "operation" ||
      shapeCollisionSample.value.descriptor.kind !== "effect"
    ) {
      throw new Error("expected public sample");
    }
    expect(
      (shapeCollisionSample.value.descriptor.input as Record<string, Json>)["classifications"],
    ).toEqual(["internal", "public"]);
  });

  it("uses an explicit classified-result envelope to raise a declared ceiling", () => {
    const program = chat("You are a reviewer", {
      inspect: modelTool(durableFixtureBinding, { resultClassification: "public" }),
    });
    const generator = program.program(
      acceptChatTurn(program.contextPolicy, message("current", "user", "inspect"), {
        frontier: "f",
      }) as unknown as Json & ReturnType<typeof acceptChatTurn>,
      createDurableProgramContext(),
    );
    generator.next();
    generator.next({
      status: "ok",
      value: {
        message: message("call", "assistant", "inspecting"),
        calls: [{ id: "inspect-3", target: "inspect", input: "safe" }],
        artifacts: [],
      },
    });
    const next = generator.next({
      status: "ok",
      value: classifiedToolResult({ text: "derived" }, { classifications: ["restricted"] }),
    });
    if (next.done || next.value.type !== "operation" || next.value.descriptor.kind !== "effect") {
      throw new Error("expected raised classification");
    }
    expect((next.value.descriptor.input as Record<string, Json>)["classifications"]).toEqual([
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
      "4ffe3af2ac06e326b7cf0cafee55849b5df58574a6425a7f0cadfc2bbc7f70b8",
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
