import { defineDurableEffect } from "@sweatpants/session-contract";
import { createDurableEffectRegistration } from "@sweatpants/durable-effects";

import {
  ProgramDriverRegistryContext,
  createProgramDriverRegistry,
} from "@sweatpants/durable-execution";
import { run, type Operation } from "effection";
import { describe, expect, it } from "vitest";

import {
  DurableEffectRegistryContext,
  DurableProgramCancellation,
  withJournalAuthority,
  ProgramRuntime,
  createCapabilityKeyring,
  createDurableEffectRegistry,
  createDurableSchemaRegistry,
  createPinnedDurableProgram,
  createDurableToolRegistry,
  createInMemoryDurableJournalAuthority,
  defineDurableProgramManifest,
  type AttachProgramRequest,
  type DurableSemanticRecord,
  type ProgramDriver,
  type ProgramRunResult,
} from "@sweatpants/session-contract";
import { anyGuard, createSchemaFixture, nullGuard } from "@sweatpants/session-contract/testing";

import { createLocalDurableProgramDriver } from "../index.ts";

type ChildInput = { topic: string };
type SampleInput = { round: number; answers: string[] };
type SampleOutput = { suggestion: string };
type Choice = { answer: string; continue: boolean };
type ChildOutput = { rounds: number; answers: string[] };

const choiceSchema = createSchemaFixture(
  "fixture.looping-child/choice",
  "elicit_response",
  {
    type: "object",
    required: ["answer", "continue"],
    properties: {
      answer: { type: "string" },
      continue: { type: "boolean" },
    },
    additionalProperties: false,
  },
  anyGuard,
);
const sampleInput = createSchemaFixture(
  "fixture.model-sample/input",
  "effect_input",
  true,
  anyGuard,
);
const sampleOutput = createSchemaFixture(
  "fixture.model-sample/output",
  "effect_output",
  true,
  anyGuard,
);
const cleanupInput = createSchemaFixture(
  "fixture.child-cleanup/input",
  "effect_input",
  { type: "null" },
  nullGuard,
);
const cleanupOutput = createSchemaFixture(
  "fixture.child-cleanup/output",
  "effect_output",
  { type: "null" },
  nullGuard,
);
const childInput = createSchemaFixture(
  "fixture.looping-child/input",
  "program_input",
  true,
  anyGuard,
);
const childOutput = createSchemaFixture(
  "fixture.looping-child/output",
  "program_output",
  true,
  anyGuard,
);
const parentInput = createSchemaFixture(
  "fixture.parent/input",
  "program_input",
  { type: "null" },
  nullGuard,
);
const fixtureSchemas = () =>
  createDurableSchemaRegistry([
    choiceSchema.entry,
    sampleInput.entry,
    sampleOutput.entry,
    cleanupInput.entry,
    cleanupOutput.entry,
    childInput.entry,
    childOutput.entry,
    parentInput.entry,
  ]);

const sampleDefinition = defineDurableEffect<SampleInput, SampleOutput>({
  name: "model.sample",
  version: "1",
  inputSchema: sampleInput.descriptor,
  outputSchema: sampleOutput.descriptor,
  retrySafety: { mode: "idempotent", mechanism: "pull_id_key" },
});

const cleanupDefinition = defineDurableEffect<null, null>({
  name: "child.cleanup",
  version: "1",
  inputSchema: cleanupInput.descriptor,
  outputSchema: cleanupOutput.descriptor,
  retrySafety: { mode: "idempotent", mechanism: "inherent" },
});

const childManifest = defineDurableProgramManifest<ChildInput, ChildOutput>({
  programId: "fixture.looping-child",
  version: "1.0.0",
  digest: "c".repeat(64),
  inputSchema: childInput.descriptor,
  outputSchema: childOutput.descriptor,
  elicits: { choice: { response: choiceSchema.descriptor } },
  effects: {
    [sampleDefinition.name]: sampleDefinition,
    [cleanupDefinition.name]: cleanupDefinition,
  },
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
  inputSchema: parentInput.descriptor,
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

    const child = createPinnedDurableProgram(childManifest, function* (input, context) {
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
        const result = yield* context.elicit<Choice>(
          "choice",
          `Round ${round + 1}: ${sampled.suggestion}`,
          choiceSchema.descriptor,
        );
        if (result.action !== "accept") {
          break;
        }
        answers.push(result.content.answer);
        if (!result.content.continue) {
          break;
        }
      }
      return { rounds: answers.length, answers };
    });
    const parent = createPinnedDurableProgram(parentManifest, function* (_input, context) {
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
    const drivers = createProgramDriverRegistry([["program", driver]]);
    const effects = createDurableEffectRegistry([
      createDurableEffectRegistration(
        sampleDefinition,
        { mode: "idempotent", mechanism: "pull_id_key" },
        function* (input) {
          sampleExecutions += 1;
          return { status: "ok", value: { suggestion: `suggestion-${input.round}` } };
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
      schemaRegistry: fixtureSchemas(),
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

  it("cancels an active child leaves-first and runs child cleanup before closing the parent", async () => {
    let sampleExecutions = 0;
    let cleanupExecutions = 0;
    let childCancellationCatches = 0;

    const child = createPinnedDurableProgram(childManifest, function* (input, context) {
      try {
        const sampled = yield* context.effect(
          sampleDefinition,
          { round: 0, answers: [] },
          { audience: "model-runtime" },
        );
        yield* context.emit("child_round", {
          topic: input.topic,
          round: 0,
          suggestion: sampled.suggestion,
        });
        const result = yield* context.elicit<Choice>(
          "choice",
          `Choose: ${sampled.suggestion}`,
          choiceSchema.descriptor,
        );
        return {
          rounds: 1,
          answers: result.action === "accept" ? [result.content.answer] : [],
        };
      } catch (error) {
        if (error instanceof DurableProgramCancellation) {
          childCancellationCatches += 1;
        }
        return { rounds: 99, answers: ["must-not-be-success"] };
      } finally {
        yield* context.effect(cleanupDefinition, null, { audience: "child-cleanup" });
        yield* context.emit("child_cleanup_complete", { cleaned: true });
      }
    });
    const parent = createPinnedDurableProgram(parentManifest, function* (_input, context) {
      return yield* context.invoke<ChildOutput>({
        id: childManifest.programId,
        version: childManifest.version,
        digest: childManifest.digest,
        input: { topic: "cancellation" },
      });
    });
    const tools = createDurableToolRegistry([parent, child]);
    const drivers = createProgramDriverRegistry([
      ["program", createLocalDurableProgramDriver(tools)],
    ]);
    const effects = createDurableEffectRegistry([
      createDurableEffectRegistration(
        sampleDefinition,
        { mode: "idempotent", mechanism: "pull_id_key" },
        function* () {
          sampleExecutions += 1;
          return { status: "ok", value: { suggestion: "cancel-me" } };
        },
      ),
      createDurableEffectRegistration(
        cleanupDefinition,
        { mode: "idempotent", mechanism: "inherent" },
        function* () {
          cleanupExecutions += 1;
          return { status: "ok", value: null };
        },
      ),
    ]);
    const keyring = createCapabilityKeyring("parent-child-cancellation-test", [
      { keyId: "active", secret: "parent-child-cancel-secret-32-bytes" },
    ]);
    let authority = createInMemoryDurableJournalAuthority({
      journalId: "parent-child-integration",
      journalIncarnation: "1",
      keyring,
      schemaRegistry: fixtureSchemas(),
    });
    const sessionId = "parent-child-cancellation-session";
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
      const pending = findPendingChildElicit(authority.readJournal(sessionId), childTaskId);
      const staleCapability = authority.resolutionCapability(
        sessionId,
        childTaskId,
        pending.pullId,
      );

      const accepted = yield* authority.requestCancellation(
        sessionId,
        parentTaskId,
        "cancel-parent",
        "cancel-parent-command",
      );
      expect(accepted).toMatchObject({
        accepted: true,
        duplicate: false,
        frontier: { pullId: expect.any(String) },
      });
      expect(
        yield* authority.resolve({
          capability: staleCapability,
          audience: "user:choice",
          outcome: { status: "ok", value: { answer: "late", continue: false } },
        }),
      ).toEqual({ status: "rejected", code: "capability_revoked" });

      authority = recreate(authority, keyring);
      expect(yield* runProgram(attach, authority, drivers, effects)).toEqual({
        state: "cancelled",
      });
    });

    expect(sampleExecutions).toBe(1);
    expect(cleanupExecutions).toBe(1);
    expect(childCancellationCatches).toBe(1);

    const journal = authority.readJournal(sessionId);
    const cancellations = journal.filter(
      (record) => record.payload.type === "CancellationRequested",
    );
    expect(cancellations.map((record) => record.payload.taskId)).toEqual([
      parentTaskId,
      childTaskId,
    ]);
    const childCleanup = journal.findIndex(
      (record) =>
        record.payload.type === "PullRequested" &&
        record.payload.taskId === childTaskId &&
        record.payload.descriptor.kind === "effect" &&
        record.payload.descriptor.name === cleanupDefinition.name,
    );
    const childClose = journal.findIndex(
      (record) => record.payload.type === "TaskClosed" && record.payload.taskId === childTaskId,
    );
    const parentResolution = journal.findIndex(
      (record) => record.payload.type === "PullResolved" && record.payload.taskId === parentTaskId,
    );
    const parentClose = journal.findIndex(
      (record) => record.payload.type === "TaskClosed" && record.payload.taskId === parentTaskId,
    );
    expect(childCleanup).toBeGreaterThan(-1);
    expect(childCleanup).toBeLessThan(childClose);
    expect(childClose).toBeLessThan(parentResolution);
    expect(parentResolution).toBeLessThan(parentClose);
    expect(journal[childClose]?.payload).toMatchObject({
      type: "TaskClosed",
      taskId: childTaskId,
      outcome: { status: "cancelled" },
    });
    expect(journal[parentClose]?.payload).toMatchObject({
      type: "TaskClosed",
      taskId: parentTaskId,
      outcome: { status: "cancelled" },
    });
    expect(JSON.stringify(journal)).not.toContain("must-not-be-success");
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
    route: { driverKind: "program" },
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
    return yield* withJournalAuthority(authority, function* () {
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
    schemaRegistry: fixtureSchemas(),
  });
}

function findPendingChildElicit(
  journal: DurableSemanticRecord[],
  childTaskId: string,
): Extract<DurableSemanticRecord["payload"], { type: "PullRequested" }> {
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
  return request.payload;
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
    outcome: { status: "ok", value: { action: "accept", content: value } },
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
