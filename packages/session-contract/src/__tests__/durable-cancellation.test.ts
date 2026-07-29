import { defineDurableEffect } from "../index.ts";
import { createDurableEffectRegistration } from "@sweatpants/durable-effects";

import {
  ProgramDriverRegistryContext,
  createProgramDriverRegistry,
} from "@sweatpants/durable-execution";
import { run } from "effection";
import { describe, expect, it } from "vitest";

import {
  DurableEffectRegistryContext,
  DurableProgramCancellation,
  withJournalAuthority,
  ProgramRuntime,
  createCapabilityKeyring,
  createDurableEffectRegistry,
  createPinnedDurableProgram,
  createDurableToolRegistry,
  createInMemoryDurableJournalAuthority,
  createLocalProgramDriver,
  stableProgramAttachmentId,
  type DurableProgramManifest,
} from "../index.ts";
import { createDurableSchemaRegistry } from "@sweatpants/journal-authority/schema-registry";
import { booleanGuard, createSchemaFixture, nullGuard, stringGuard } from "../testing/index.ts";

const keyring = createCapabilityKeyring("cancellation-test", [
  { keyId: "active", secret: "durable-cancellation-test-secret!!" },
]);
const digest = "e".repeat(64);

const cancellableInput = createSchemaFixture(
  "fixture.cancellation/cancellable-input",
  "effect_input",
  { type: "string" },
  stringGuard,
);
const cancellableOutput = createSchemaFixture(
  "fixture.cancellation/cancellable-output",
  "effect_output",
  { type: "string" },
  stringGuard,
);
const cancellablePartial = createSchemaFixture(
  "fixture.cancellation/cancellable-partial",
  "effect_cancellation_partial",
  {
    type: "object",
    required: ["completed"],
    properties: { completed: { type: "integer", minimum: 0 } },
    additionalProperties: false,
  },
  (value) =>
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Number.isSafeInteger((value as { completed?: unknown }).completed) &&
    ((value as { completed: number }).completed satisfies number) >= 0 &&
    Object.keys(value).length === 1
      ? undefined
      : "partial must be { completed: nonnegative integer }",
);
const cleanupInput = createSchemaFixture(
  "fixture.cancellation/cleanup-input",
  "effect_input",
  { type: "null" },
  nullGuard,
);
const cleanupOutput = createSchemaFixture(
  "fixture.cancellation/cleanup-output",
  "effect_output",
  { type: "null" },
  nullGuard,
);
const programInput = createSchemaFixture(
  "fixture.cancellation/input",
  "program_input",
  { type: "null" },
  nullGuard,
);
const programOutput = createSchemaFixture(
  "fixture.cancellation/output",
  "program_output",
  { type: "string" },
  stringGuard,
);
const approvalResponse = createSchemaFixture(
  "fixture.cancellation/approval-response",
  "elicit_response",
  { type: "boolean" },
  booleanGuard,
);

const cancellable = defineDurableEffect<string, string, { completed: number }>({
  name: "cancellable",
  version: "1",
  inputSchema: cancellableInput.descriptor,
  outputSchema: cancellableOutput.descriptor,
  cancellation: {
    partialSchema: cancellablePartial.descriptor,
  },
  retrySafety: { mode: "idempotent", mechanism: "pull_id_key" },
});

const cleanup = defineDurableEffect<null, null>({
  name: "cleanup",
  version: "1",
  inputSchema: cleanupInput.descriptor,
  outputSchema: cleanupOutput.descriptor,
  retrySafety: { mode: "idempotent", mechanism: "inherent" },
});

const manifest: DurableProgramManifest<null, string> = {
  programId: "fixture.cancellation",
  version: "1",
  digest,
  inputSchema: programInput.descriptor,
  outputSchema: programOutput.descriptor,
  elicits: { approval: { response: approvalResponse.descriptor } },
  effects: { cancellable, cleanup },
  capabilities: { durableEmissions: true, structuredChildren: true, replay: "strict" },
};

function authority(name: string, maxOutcomeBytes?: number) {
  return createInMemoryDurableJournalAuthority({
    journalId: name,
    journalIncarnation: "1",
    keyring,
    schemaRegistry: createDurableSchemaRegistry([
      cancellableInput.entry,
      cancellableOutput.entry,
      cancellablePartial.entry,
      cleanupInput.entry,
      cleanupOutput.entry,
      programInput.entry,
      programOutput.entry,
      approvalResponse.entry,
    ]),
    ...(maxOutcomeBytes !== undefined ? { maxOutcomeBytes } : {}),
  });
}

function attach(sessionId: string) {
  return {
    sessionId,
    taskId: "turn-0/root",
    program: { id: manifest.programId, version: manifest.version, digest: manifest.digest },
    input: null,
    route: { driverKind: "program" },
    executionEpoch: 1,
  } as const;
}

function* open(name: string, selected = authority(name)) {
  const request = attach(name);
  const opened = yield* selected.openTask({
    sessionId: request.sessionId,
    turnId: "turn-0",
    taskId: request.taskId,
    manifest,
    input: null,
    executionEpoch: 1,
    attachmentId: stableProgramAttachmentId(request),
    audience: "program-runtime",
  });
  return { selected, request, programCapability: opened.programCapability };
}

describe("durable cancellation and partial results", () => {
  it("accepts a schema-valid partial and degrades an invalid partial without blocking", async () => {
    await run(function* () {
      const { selected, request, programCapability } = yield* open("partial");
      const reserved = yield* selected.reserve({
        sessionId: request.sessionId,
        turnId: "turn-0",
        taskId: request.taskId,
        actionIndex: 0,
        pullIndex: 0,
        descriptor: {
          kind: "effect",
          name: cancellable.name,
          version: cancellable.version,
          input: "run",
          resolver: { audience: "effects" },
        },
        programCapability,
      });
      if (reserved.status !== "authorized") {
        throw new Error("effect was not authorized");
      }
      expect(
        yield* selected.resolve({
          capability: reserved.resolutionCapability,
          audience: "effects",
          outcome: { status: "cancelled", partial: { completed: 3 } },
        }),
      ).toMatchObject({ status: "accepted" });
      expect(selected.readJournal(request.sessionId).at(-1)?.payload).toMatchObject({
        type: "PullResolved",
        outcome: { status: "cancelled", partial: { completed: 3 } },
      });

      const invalid = yield* open("invalid-partial");
      const invalidReserved = yield* invalid.selected.reserve({
        sessionId: invalid.request.sessionId,
        turnId: "turn-0",
        taskId: invalid.request.taskId,
        actionIndex: 0,
        pullIndex: 0,
        descriptor: {
          kind: "effect",
          name: cancellable.name,
          version: cancellable.version,
          input: "run",
          resolver: { audience: "effects" },
        },
        programCapability: invalid.programCapability,
      });
      if (invalidReserved.status !== "authorized") {
        throw new Error("effect was not authorized");
      }
      expect(
        yield* invalid.selected.resolve({
          capability: invalidReserved.resolutionCapability,
          audience: "effects",
          outcome: { status: "cancelled", partial: { completed: "secret-invalid" } },
        }),
      ).toMatchObject({ status: "accepted" });
      const encoded = JSON.stringify(invalid.selected.readJournal(invalid.request.sessionId));
      expect(encoded).not.toContain("secret-invalid");
      expect(
        invalid.selected.readJournal(invalid.request.sessionId).map((r) => r.payload.type),
      ).toEqual([
        "TaskOpened",
        "PullRequested",
        "AttemptStarted",
        "CancellationPartialDiscarded",
        "PullResolved",
      ]);
    });
  });

  it("preserves the first reason and frontier across differing duplicate requests", async () => {
    await run(function* () {
      const { selected, request } = yield* open("duplicate-cancel");
      const first = yield* selected.requestCancellation(
        request.sessionId,
        request.taskId,
        "first",
        "command-a",
      );
      const duplicate = yield* selected.requestCancellation(
        request.sessionId,
        request.taskId,
        "different",
        "command-b",
      );
      expect(first).toMatchObject({ duplicate: false, commandId: "command-a", reason: "first" });
      expect(duplicate).toEqual({ ...first, duplicate: true });
      expect(selected.runnableSessions()).toEqual([request.sessionId]);
      expect(
        selected
          .readJournal(request.sessionId)
          .filter((record) => record.payload.type === "CancellationRequested"),
      ).toHaveLength(1);
    });
  });

  it("replays a parked program, throws typed cancellation once, and runs durable finally cleanup", async () => {
    let catches = 0;
    let cleanupRuns = 0;
    const tool = createPinnedDurableProgram(manifest, function* (_input, context) {
      try {
        yield* context.elicit<boolean>("approval", "Approve?", approvalResponse.descriptor);
        return "approved";
      } catch (error) {
        if (error instanceof DurableProgramCancellation) {
          catches += 1;
        }
        return "must-not-become-success";
      } finally {
        yield* context.effect(cleanup, null, { audience: "cleanup" });
        yield* context.emit("cleanup-visible", { done: true });
      }
    });
    const drivers = createProgramDriverRegistry([
      ["program", createLocalProgramDriver(createDurableToolRegistry([tool]))],
    ]);
    const effects = createDurableEffectRegistry([
      createDurableEffectRegistration(
        cleanup,
        { mode: "idempotent", mechanism: "inherent" },
        function* () {
          cleanupRuns += 1;
          return { status: "ok", value: null };
        },
      ),
    ]);
    const selected = authority("unwind");
    const request = attach("unwind");

    await run(function* () {
      yield* selected.openTask({
        sessionId: request.sessionId,
        turnId: "turn-0",
        taskId: request.taskId,
        manifest,
        input: null,
        executionEpoch: 1,
        attachmentId: stableProgramAttachmentId(request),
        audience: "program-runtime",
      });
      const first = yield* ProgramDriverRegistryContext.with(drivers, function* () {
        return yield* withJournalAuthority(selected, function* () {
          return yield* DurableEffectRegistryContext.with(effects, function* () {
            return yield* ProgramRuntime.operations.run({
              attach: request,
              executeHostEffects: true,
            });
          });
        });
      });
      expect(first.state).toBe("parked");
      yield* selected.requestCancellation(request.sessionId, request.taskId, "stop", "cancel-1");
      const second = yield* ProgramDriverRegistryContext.with(drivers, function* () {
        return yield* withJournalAuthority(selected, function* () {
          return yield* DurableEffectRegistryContext.with(effects, function* () {
            return yield* ProgramRuntime.operations.run({
              attach: request,
              executeHostEffects: true,
            });
          });
        });
      });
      expect(second).toEqual({ state: "cancelled" });
    });

    expect(catches).toBe(1);
    expect(cleanupRuns).toBe(1);
    const records = selected.readJournal(request.sessionId);
    expect(records.at(-1)?.payload).toEqual({
      type: "TaskClosed",
      taskId: request.taskId,
      outcome: { status: "cancelled" },
    });
    expect(records.some((record) => record.payload.type === "DurableEmission")).toBe(true);
    expect(JSON.stringify(records)).not.toContain("must-not-become-success");
  });
});
