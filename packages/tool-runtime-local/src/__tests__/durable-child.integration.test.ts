import { run, type Operation } from "effection";
import { describe, expect, it } from "vitest";
import {
  DurableEffectRegistryContext,
  JournalAuthorityContext,
  ProgramDriverRegistryContext,
  ProgramRuntime,
  createCapabilityKeyring,
  createDurableEffectRegistration,
  createDurableEffectRegistry,
  createDurableTool,
  createDurableToolRegistry,
  createInMemoryDurableJournalAuthority,
  createProgramDriverRegistry,
  defineDurableEffect,
  defineDurableProgramManifest,
  type AttachProgramRequest,
  type DurableSemanticRecord,
  type JsonSchema,
  type ProgramDriver,
  type ProgramRunResult,
} from "@sweatpants/session-contract";

import { createLocalDurableProgramDriver } from "../index.ts";

type ChildInput = { topic: string };
type SampleInput = { round: number; answers: string[] };
type SampleOutput = { suggestion: string };
type Choice = { answer: string; continue: boolean };
type ChildOutput = { rounds: number; answers: string[] };

const choiceSchema: JsonSchema = {
  type: "object",
  required: ["answer", "continue"],
  properties: {
    answer: { type: "string" },
    continue: { type: "boolean" },
  },
  additionalProperties: false,
};

const sampleDefinition = defineDurableEffect<SampleInput, SampleOutput>({
  name: "model.sample",
  version: "1",
  inputSchema: {
    type: "object",
    required: ["round", "answers"],
    properties: {
      round: { type: "integer" },
      answers: { type: "array", items: { type: "string" } },
    },
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    required: ["suggestion"],
    properties: { suggestion: { type: "string" } },
    additionalProperties: false,
  },
  retrySafety: { mode: "idempotent", mechanism: "pull_id_key" },
});

const childManifest = defineDurableProgramManifest<ChildInput, ChildOutput>({
  programId: "fixture.looping-child",
  version: "1.0.0",
  digest: "c".repeat(64),
  inputSchema: {
    type: "object",
    required: ["topic"],
    properties: { topic: { type: "string" } },
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    required: ["rounds", "answers"],
    properties: {
      rounds: { type: "integer" },
      answers: { type: "array", items: { type: "string" } },
    },
    additionalProperties: false,
  },
  elicits: { choice: { responseSchema: choiceSchema } },
  effects: { [sampleDefinition.name]: sampleDefinition },
  capabilities: {
    durableEmissions: true,
    structuredChildren: false,
    replay: "strict",
  },
});

const parentManifest = defineDurableProgramManifest<null, ChildOutput>({
  programId: "fixture.parent",
  version: "1.0.0",
  digest: "b".repeat(64),
  inputSchema: { type: "null" },
  outputSchema: childManifest.outputSchema,
  elicits: {},
  effects: {},
  capabilities: {
    durableEmissions: false,
    structuredChildren: true,
    replay: "strict",
  },
});

describe("automatic local durable parent/child recovery", () => {
  it("recreates a multi-round sampling and eliciting child without coordinator-side task management", async () => {
    let parentFactories = 0;
    let childFactories = 0;
    let sampleExecutions = 0;
    let activeAttachments = 0;
    let attachmentCount = 0;
    let shutdownCount = 0;

    const child = createDurableTool(childManifest, function* (input, context) {
      childFactories += 1;
      const answers: string[] = [];
      for (let round = 0; round < 3; round += 1) {
        const sampled = yield* context.effect(
          sampleDefinition,
          { round, answers },
          { audience: "model-runtime" },
        );
        yield* context.emit("child_round", {
          topic: input.topic,
          round,
          suggestion: sampled.suggestion,
        });
        const response = yield* context.elicit<Choice>(
          "choice",
          `Round ${round + 1}: ${sampled.suggestion}`,
          choiceSchema,
        );
        answers.push(response.answer);
        if (!response.continue) {
          break;
        }
      }
      return { rounds: answers.length, answers };
    });
    const parent = createDurableTool(parentManifest, function* (_input, context) {
      parentFactories += 1;
      return yield* context.invoke<ChildOutput>({
        id: childManifest.programId,
        version: childManifest.version,
        digest: childManifest.digest,
        input: { topic: "durability" },
      });
    });
    const tools = createDurableToolRegistry([parent, child]);
    const concrete = createLocalDurableProgramDriver(tools);
    const driver: ProgramDriver = {
      *attach(request) {
        const attachment = yield* concrete.attach(request);
        activeAttachments += 1;
        attachmentCount += 1;
        return attachment;
      },
      *step(attachment, command) {
        return yield* concrete.step(attachment, command);
      },
      *shutdown(attachment, reason) {
        try {
          yield* concrete.shutdown(attachment, reason);
        } finally {
          activeAttachments -= 1;
          shutdownCount += 1;
        }
      },
      *manifest(program) {
        if (!concrete.manifest) {
          throw new Error("Local driver must resolve manifests");
        }
        return yield* concrete.manifest(program);
      },
    };
    const drivers = createProgramDriverRegistry([["generator", driver]]);
    const effects = createDurableEffectRegistry([
      createDurableEffectRegistration(
        sampleDefinition,
        { mode: "idempotent", mechanism: "pull_id_key" },
        function* (input) {
          sampleExecutions += 1;
          return { suggestion: `suggestion-${input.round}` };
        },
      ),
    ]);
    const keyring = createCapabilityKeyring("parent-child-test", [
      { keyId: "active", secret: "parent-child-secret-is-32-bytes!!" },
    ]);
    let authority = createInMemoryDurableJournalAuthority({
      journalId: "parent-child-integration",
      journalIncarnation: "1",
      keyring,
    });
    const sessionId = "parent-child-session";
    const parentTaskId = "turn-0/root";
    const childTaskId = `${parentTaskId}.0`;
    const attach = attachRequest(sessionId, parentTaskId);

    await run(function* () {
      yield* authority.openTask({
        sessionId,
        turnId: "turn-0",
        taskId: parentTaskId,
        manifest: parentManifest,
        input: null,
        executionEpoch: 1,
        attachmentId: "unattached-parent",
        audience: "program-runtime",
      });

      expect(yield* runProgram(attach, authority, drivers, effects)).toMatchObject({
        state: "parked",
        reason: "elicit",
      });
      expect(activeAttachments).toBe(0);
      authority = recreate(authority, keyring);
      yield* acceptPending(authority, sessionId, childTaskId, {
        answer: "first-answer",
        continue: true,
      });
      authority = recreate(authority, keyring);

      expect(yield* runProgram(attach, authority, drivers, effects)).toMatchObject({
        state: "parked",
        reason: "elicit",
      });
      expect(activeAttachments).toBe(0);
      authority = recreate(authority, keyring);
      yield* acceptPending(authority, sessionId, childTaskId, {
        answer: "second-answer",
        continue: false,
      });
      authority = recreate(authority, keyring);

      expect(yield* runProgram(attach, authority, drivers, effects)).toEqual({
        state: "completed",
        value: { rounds: 2, answers: ["first-answer", "second-answer"] },
      });
      expect(activeAttachments).toBe(0);

      const journal = authority.readJournal(sessionId);
      expect(countPulls(journal, childTaskId, "effect")).toBe(2);
      expect(countPulls(journal, childTaskId, "elicit")).toBe(2);
      expect(
        journal.filter(
          (record) =>
            record.payload.type === "DurableEmission" && record.payload.taskId === childTaskId,
        ),
      ).toHaveLength(2);
      const childClose = journal.findIndex(
        (record) => record.payload.type === "TaskClosed" && record.payload.taskId === childTaskId,
      );
      const parentResolution = journal.findIndex(
        (record) =>
          record.payload.type === "PullResolved" && record.payload.taskId === parentTaskId,
      );
      expect(childClose).toBeLessThan(parentResolution);
      expect(journal.at(-1)?.payload).toMatchObject({
        type: "TaskClosed",
        taskId: parentTaskId,
      });
    });

    expect(sampleExecutions).toBe(2);
    expect(parentFactories).toBe(3);
    expect(childFactories).toBe(3);
    expect(attachmentCount).toBe(6);
    expect(shutdownCount).toBe(6);
  });
});

function attachRequest(sessionId: string, taskId: string): AttachProgramRequest {
  return {
    sessionId,
    taskId,
    program: {
      id: parentManifest.programId,
      version: parentManifest.version,
      digest: parentManifest.digest,
    },
    input: null,
    route: { driverKind: "generator" },
    executionEpoch: 1,
  };
}

function runProgram(
  attach: AttachProgramRequest,
  authority: ReturnType<typeof createInMemoryDurableJournalAuthority>,
  drivers: ReturnType<typeof createProgramDriverRegistry>,
  effects: ReturnType<typeof createDurableEffectRegistry>,
): Operation<ProgramRunResult> {
  return ProgramDriverRegistryContext.with(drivers, function* () {
    return yield* JournalAuthorityContext.with(authority, function* () {
      return yield* DurableEffectRegistryContext.with(effects, function* () {
        return yield* ProgramRuntime.operations.run({ attach, executeHostEffects: true });
      });
    });
  });
}

function recreate(
  authority: ReturnType<typeof createInMemoryDurableJournalAuthority>,
  keyring: ReturnType<typeof createCapabilityKeyring>,
) {
  return createInMemoryDurableJournalAuthority({
    journalId: "parent-child-integration",
    journalIncarnation: "1",
    keyring,
    snapshot: authority.exportSnapshot(),
  });
}

function* acceptPending(
  authority: ReturnType<typeof createInMemoryDurableJournalAuthority>,
  sessionId: string,
  childTaskId: string,
  value: Choice,
): Operation<void> {
  const journal = authority.readJournal(sessionId);
  const resolved = new Set(
    journal.flatMap((record) =>
      record.payload.type === "PullResolved" ? [record.payload.pullId] : [],
    ),
  );
  const request = journal.find(
    (record) =>
      record.payload.type === "PullRequested" &&
      record.payload.taskId === childTaskId &&
      record.payload.descriptor.kind === "elicit" &&
      !resolved.has(record.payload.pullId),
  );
  if (!request || request.payload.type !== "PullRequested") {
    throw new Error("Missing child elicitation");
  }
  const result = yield* authority.resolve({
    capability: authority.resolutionCapability(sessionId, childTaskId, request.payload.pullId),
    audience: "user:choice",
    outcome: { status: "ok", value },
  });
  if (result.status === "rejected") {
    throw new Error(result.code);
  }
}

function countPulls(
  journal: DurableSemanticRecord[],
  taskId: string,
  kind: "effect" | "elicit",
): number {
  return journal.filter(
    (record) =>
      record.payload.type === "PullRequested" &&
      record.payload.taskId === taskId &&
      record.payload.descriptor.kind === kind,
  ).length;
}
