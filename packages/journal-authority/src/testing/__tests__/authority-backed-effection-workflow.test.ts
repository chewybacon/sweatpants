import { run, scoped, spawn, useScope, withResolvers, type Operation } from "effection";
import { describe, expect, it } from "vitest";
import type { OperationOutcome } from "@sweatpants/durable-effects";
import {
  CrankError,
  DurableProgramCancellation,
  type AttachProgramRequest,
  type DurableProgramManifest,
  type ProgramShutdownReason,
  type ResolutionReceipt,
} from "@sweatpants/durable-execution";
import { canonicalSnapshot, type Json } from "@sweatpants/foundation";

import { createCapabilityKeyring } from "../../capabilities.ts";
import { createDurableSchemaRegistry } from "../../schema-registry.ts";
import { createSchemaFixture, stringGuard } from "../../schema-fixtures.ts";
import { createInMemoryShellDrivers } from "../../in-memory-shell.ts";
import { createStoredShellDrivers } from "../../stored-shell.ts";
import { createMemoryExecutionStore } from "../../memory.ts";
import { AuthorityJournalPort, JournalAuthorityPort } from "../../authority-ports.ts";
import { projectExecutionForest } from "../../execution-forest.ts";
import type { DurableSemanticRecord } from "../../semantic-record.ts";
import type { ExecutionStore } from "../../store.ts";
import {
  ProgramEffectRuntimeContext,
  ephemeral,
  openProofProgramAttachment,
  proofProgramCommandParser,
  proofShutdownReasonParser,
  RecordAttemptPort,
  record,
  recordWorkflowOptionsParser,
  runProofRecordWorkflow,
  proofAuthorityPort,
  type ProofProgramCommand,
  type ProofProgramEvent,
  type CoordinatedRecordAttempt,
  type Workflow,
} from "../authority-backed-effection-workflow.ts";
import {
  assertRecordExecutionIndexMatchesForest,
  foldRecordExecutionIndex,
} from "../record-execution-index.ts";

const inputSchema = createSchemaFixture(
  "proof.workflow/input",
  "program_input",
  { type: "string" },
  stringGuard,
);
const outputSchema = createSchemaFixture(
  "proof.workflow/output",
  "program_output",
  { type: "string" },
  stringGuard,
);
const schemaRegistry = () => createDurableSchemaRegistry([inputSchema.entry, outputSchema.entry]);
const keyring = createCapabilityKeyring("proof-authority", [
  { keyId: "proof-key", secret: "x".repeat(32) },
]);
const digest = "a".repeat(64);
const manifest: DurableProgramManifest = {
  programId: "proof.workflow",
  version: "1.0.0",
  digest,
  inputSchema: inputSchema.descriptor,
  outputSchema: outputSchema.descriptor,
  elicits: {},
  effects: {},
  capabilities: { durableEmissions: false, structuredChildren: false, replay: "strict" },
};

type ShellMode = "memory" | "stored";

function conflictStore(delegate: ExecutionStore): {
  readonly store: ExecutionStore;
  arm(): void;
  readonly conflicts: () => number;
} {
  let armed = false;
  let conflicts = 0;
  return {
    arm() {
      armed = true;
    },
    conflicts: () => conflicts,
    store: {
      loadControl: (executionId) => delegate.loadControl(executionId),
      *commitExecution(request) {
        if (armed) {
          armed = false;
          conflicts += 1;
          const current = yield* delegate.loadControl(request.executionId);
          return { status: "control_conflict", current };
        }
        const result = yield* delegate.commitExecution(request);
        return result;
      },
      putObject: (object) => delegate.putObject(object),
      getObject: (pointer) => delegate.getObject(pointer),
      appendJournalSegment: (segment) => delegate.appendJournalSegment(segment),
      appendReplaySegment: (segment) => delegate.appendReplaySegment(segment),
      readJournal: (task) => delegate.readJournal(task),
      readReplay: (task) => delegate.readReplay(task),
    },
  };
}

function shell(mode: ShellMode) {
  const options = {
    journalId: `proof-${mode}`,
    journalIncarnation: "1",
    keyring,
    schemaRegistry: schemaRegistry(),
    now: () => 1_000,
  };
  return mode === "memory"
    ? createInMemoryShellDrivers(options)
    : createStoredShellDrivers(createMemoryExecutionStore(), options);
}

function attach(sessionId: string): AttachProgramRequest {
  return {
    sessionId,
    taskId: "task-root",
    program: { id: manifest.programId, version: manifest.version, digest: manifest.digest },
    input: "input",
    route: { driverKind: "proof" },
    executionEpoch: 1,
  };
}

function* installAndOpen(mode: ShellMode, request: AttachProgramRequest): Operation<string> {
  const drivers = shell(mode);
  yield* JournalAuthorityPort.installDriver(drivers.authority);
  yield* AuthorityJournalPort.installDriver(drivers.journal);
  const opened = yield* JournalAuthorityPort.api.operations.command({
    type: "execution.open-task",
    request: {
      sessionId: request.sessionId,
      turnId: "turn-0",
      taskId: request.taskId,
      manifest,
      input: request.input,
      executionEpoch: request.executionEpoch,
      attachmentId: `attachment-${request.sessionId}`,
      audience: "program-host",
      route: request.route,
    },
  });
  return opened.programCapability;
}

function receipt(
  request: AttachProgramRequest,
  pullId: string,
  outcome: OperationOutcome,
): ResolutionReceipt {
  return {
    sessionId: request.sessionId,
    taskId: request.taskId,
    pullId,
    resolutionOffset: "2",
    outcomeDigest: canonicalSnapshot(outcome).sha,
    status: "accepted",
  };
}

function workflow(
  key: string,
  execute: () => Operation<string>,
  after: (value: string) => string = (value) => `${value}:done`,
): () => Workflow<Json> {
  return function* () {
    const prefix = "sync";
    const value = yield* record({ key }, function* () {
      const executed = yield* execute();
      return executed;
    });
    return after(`${prefix}:${value}`);
  };
}

function payloadTypes(records: readonly DurableSemanticRecord[]): string[] {
  return records
    .filter(
      (entry) =>
        entry.payload.type !== "AdvancementBound" && entry.payload.type !== "AdvancementReleased",
    )
    .map((entry) => entry.payload.type);
}

describe("authority-backed Effection Workflow proof", () => {
  it("provides a bounded resource handle and buffers an immediate proposal", async () => {
    const request = attach("resource-shape");
    let closureScope: unknown;
    let hostRuntime: unknown = "unset";
    await run(function* () {
      const handle = yield* openProofProgramAttachment(
        request,
        workflow("one", function* () {
          closureScope = yield* useScope();
          return "value";
        }),
      );
      hostRuntime = yield* ProgramEffectRuntimeContext.get();
      expect(Reflect.ownKeys(handle)).toEqual(["exchange", "setDisposition", "close"]);
      const proposed = yield* handle.exchange({ type: "start", input: request.input });
      expect(proposed).toEqual({
        type: "record-proposed",
        actionIndex: 0,
        descriptor: { kind: "record", key: "one", retrySafety: { mode: "repeatable" } },
      });
      if (proposed.type !== "record-proposed") {
        throw new Error("record was not proposed");
      }
      const attempted = yield* handle.exchange({
        type: "authorize-record",
        actionIndex: 0,
        pullId: "pull-one",
        attemptId: "attempt-one",
        descriptor: proposed.descriptor,
      });
      expect(attempted).toMatchObject({
        type: "record-attempt-completed",
        actionIndex: 0,
        attemptId: "attempt-one",
        outcome: { status: "ok", value: "value" },
      });
      if (attempted.type !== "record-attempt-completed") {
        throw new Error("attempt did not finish");
      }
      const terminal = yield* handle.exchange({
        type: "resume-record",
        actionIndex: 0,
        outcome: attempted.outcome,
        receipt: receipt(request, "pull-one", attempted.outcome),
        replayed: false,
      });
      expect(terminal).toEqual({ type: "completed", actionIndex: 1, value: "sync:value:done" });
      handle.setDisposition("completed");
    });
    expect(hostRuntime).toBeUndefined();
    expect(closureScope).toBeDefined();
  });

  it("makes ephemeral work explicit, journal-transparent, and rerunnable", async () => {
    let runs = 0;
    const runWorkflow = () =>
      run(function* () {
        const result = yield* openAndDriveWithoutAuthority(function* () {
          const value = yield* ephemeral(
            (function* () {
              runs += 1;
              return `ephemeral-${runs}`;
            })(),
          );
          const recorded = yield* record({ key: "ephemeral-record" }, function* () {
            return value;
          });
          return recorded;
        });
        return result;
      });
    expect(await runWorkflow()).toBe("ephemeral-1");
    expect(await runWorkflow()).toBe("ephemeral-2");
    expect(runs).toBe(2);
  });

  for (const mode of ["memory", "stored"] as const) {
    it(`commits intent, settlement, and terminal state in ${mode} mode`, async () => {
      const request = attach(`live-${mode}`);
      let closureRuns = 0;
      await run(function* () {
        yield* installAndOpen(mode, request);
        const result = yield* runProofRecordWorkflow({
          attach: request,
          authority: proofAuthorityPort(JournalAuthorityPort.api.operations),
          workflow: workflow("live", function* () {
            const records = yield* AuthorityJournalPort.api.operations.readTree(
              request.sessionId,
              request.taskId,
            );
            expect(payloadTypes(records)).toEqual([
              "TaskOpened",
              "PullRequested",
              "AttemptStarted",
            ]);
            closureRuns += 1;
            return "accepted";
          }),
        });
        expect(result).toEqual({ state: "completed", value: "sync:accepted:done" });
        const records = yield* AuthorityJournalPort.api.operations.readTree(
          request.sessionId,
          request.taskId,
        );
        expect(payloadTypes(records)).toEqual([
          "TaskOpened",
          "PullRequested",
          "AttemptStarted",
          "PullResolved",
          "TaskClosed",
        ]);
        const index = foldRecordExecutionIndex(records);
        assertRecordExecutionIndexMatchesForest(index, projectExecutionForest(records));
        const task = index.tasks.get(request.taskId);
        expect(task?.lifecycle.status).toBe("closed");
        expect(task?.actions[0]?.settlement?.outcome).toEqual({
          status: "ok",
          value: "accepted",
        });
        const pullId = task?.actions[0]?.pullId;
        if (!pullId) {
          throw new Error("fold did not retain the pull identity");
        }
        expect(
          yield* JournalAuthorityPort.api.operations.query({
            type: "pull.state",
            sessionId: request.sessionId,
            taskId: request.taskId,
            pullId,
          }),
        ).toMatchObject({
          status: "found",
          descriptor: task.actions[0]?.descriptor,
          outcome: task.actions[0]?.settlement?.outcome,
        });
        expect(
          yield* JournalAuthorityPort.api.operations.query({
            type: "task.recovery-state",
            sessionId: request.sessionId,
            taskId: request.taskId,
          }),
        ).toMatchObject({
          status: "terminal",
          outcome: task.lifecycle.status === "closed" ? task.lifecycle.outcome : undefined,
        });
      });
      expect(closureRuns).toBe(1);
    });

    it(`reconstructs a settled record without executing its closure in ${mode} mode`, async () => {
      const request = attach(`replay-${mode}`);
      let closureRuns = 0;
      await run(function* () {
        const programCapability = yield* installAndOpen(mode, request);
        const authority = JournalAuthorityPort.api.operations;
        const reserveRequest = {
          sessionId: request.sessionId,
          turnId: "turn-0",
          taskId: request.taskId,
          actionIndex: 0,
          pullIndex: 0,
          descriptor: {
            kind: "record" as const,
            key: "replay",
            retrySafety: { mode: "repeatable" as const },
          },
          programCapability,
        };
        yield* scoped(function* () {
          const handle = yield* openProofProgramAttachment(
            request,
            workflow("replay", function* () {
              closureRuns += 1;
              return "settled";
            }),
          );
          const proposed = yield* handle.exchange({ type: "start", input: request.input });
          if (proposed.type !== "record-proposed") {
            throw new Error("record was not proposed");
          }
          const reserved = yield* authority.command({
            type: "execution.reserve-pull",
            request: reserveRequest,
          });
          if (reserved.status !== "authorized") {
            throw new Error("record was not authorized");
          }
          const attempted = yield* handle.exchange({
            type: "authorize-record",
            actionIndex: 0,
            pullId: reserved.pullId,
            attemptId: reserved.attemptId,
            descriptor: reserved.descriptor as typeof proposed.descriptor,
          });
          if (attempted.type !== "record-attempt-completed") {
            throw new Error("attempt did not complete");
          }
          const resolved = yield* authority.command({
            type: "execution.resolve-pull",
            request: {
              capability: reserved.resolutionCapability,
              audience: "program-execution",
              outcome: attempted.outcome,
            },
          });
          expect(resolved.status).not.toBe("rejected");
        });
        expect(closureRuns).toBe(1);
        let terminal: ProofProgramEvent | undefined;
        yield* scoped(function* () {
          const handle = yield* openProofProgramAttachment(
            request,
            workflow("replay", function* () {
              closureRuns += 1;
              return "must-not-run";
            }),
          );
          const proposed = yield* handle.exchange({ type: "start", input: request.input });
          if (proposed.type !== "record-proposed") {
            throw new Error("record was not proposed");
          }
          const replayed = yield* authority.command({
            type: "execution.reserve-pull",
            request: reserveRequest,
          });
          if (replayed.status !== "resolved") {
            throw new Error("record was not replayed");
          }
          terminal = yield* handle.exchange({
            type: "resume-record",
            actionIndex: 0,
            outcome: replayed.outcome,
            receipt: replayed.receipt,
            replayed: true,
          });
        });
        expect(terminal).toEqual({ type: "completed", actionIndex: 1, value: "sync:settled:done" });
        expect(closureRuns).toBe(1);
        yield* authority.command({
          type: "execution.complete-task",
          request: {
            sessionId: request.sessionId,
            taskId: request.taskId,
            actionIndex: 1,
            outcome: { status: "ok", value: "sync:settled:done" },
            programCapability,
          },
        });
      });
    });
  }

  it("reevaluates reservation and resolution after stored CAS conflicts", async () => {
    const request = attach("stored-cas");
    const controlled = conflictStore(createMemoryExecutionStore());
    const drivers = createStoredShellDrivers(controlled.store, {
      journalId: "proof-stored-cas",
      journalIncarnation: "1",
      keyring,
      schemaRegistry: schemaRegistry(),
      now: () => 1_000,
    });
    let closureRuns = 0;
    await run(function* () {
      yield* JournalAuthorityPort.installDriver(drivers.authority);
      yield* AuthorityJournalPort.installDriver(drivers.journal);
      const opened = yield* JournalAuthorityPort.api.operations.command({
        type: "execution.open-task",
        request: {
          sessionId: request.sessionId,
          turnId: "turn-0",
          taskId: request.taskId,
          manifest,
          input: request.input,
          executionEpoch: request.executionEpoch,
          attachmentId: "attachment-stored-cas",
          audience: "program-host",
          route: request.route,
        },
      });
      void opened;
      controlled.arm();
      const result = yield* runProofRecordWorkflow({
        attach: request,
        authority: proofAuthorityPort(JournalAuthorityPort.api.operations),
        workflow: workflow("cas", function* () {
          closureRuns += 1;
          controlled.arm();
          return "after-cas";
        }),
      });
      expect(result).toEqual({ state: "completed", value: "sync:after-cas:done" });
      expect(controlled.conflicts()).toBe(2);
      const records = yield* AuthorityJournalPort.api.operations.readTree(
        request.sessionId,
        request.taskId,
      );
      expect(payloadTypes(records)).toEqual([
        "TaskOpened",
        "PullRequested",
        "AttemptStarted",
        "PullResolved",
        "TaskClosed",
      ]);
    });
    expect(closureRuns).toBe(1);
  });

  for (const mode of ["memory", "stored"] as const) {
    it(`turns an unsafe lost settlement into the authority indeterminate result in ${mode} mode`, async () => {
      const request = attach(`unsafe-loss-${mode}`);
      const localValue = "UNACCEPTED-UNSAFE-OUTCOME-SENTINEL";
      await run(function* () {
        const programCapability = yield* installAndOpen(mode, request);
        const authority = JournalAuthorityPort.api.operations;
        let pullId = "";
        yield* scoped(function* () {
          const handle = yield* openProofProgramAttachment(request, function* () {
            const recorded = yield* record(
              { key: "unsafe", retrySafety: { mode: "unsafe" } },
              function* () {
                return localValue;
              },
            );
            return recorded;
          });
          const proposed = yield* handle.exchange({ type: "start", input: request.input });
          if (proposed.type !== "record-proposed") {
            throw new Error("record was not proposed");
          }
          const reserved = yield* authority.command({
            type: "execution.reserve-pull",
            request: {
              sessionId: request.sessionId,
              turnId: "turn-0",
              taskId: request.taskId,
              actionIndex: 0,
              pullIndex: 0,
              descriptor: proposed.descriptor,
              programCapability,
            },
          });
          if (reserved.status !== "authorized" || reserved.descriptor.kind !== "record") {
            throw new Error("unsafe record was not authorized");
          }
          pullId = reserved.pullId;
          const attempted = yield* handle.exchange({
            type: "authorize-record",
            actionIndex: 0,
            pullId: reserved.pullId,
            attemptId: reserved.attemptId,
            descriptor: reserved.descriptor,
          });
          expect(attempted).toMatchObject({ outcome: { status: "ok", value: localValue } });
          handle.setDisposition("transport_lost");
        });
        yield* authority.command({
          type: "execution.detach-attempt",
          request: {
            sessionId: request.sessionId,
            taskId: request.taskId,
            pullId,
            reason: "transport_lost",
          },
        });
        const replayed = yield* authority.command({
          type: "execution.reserve-pull",
          request: {
            sessionId: request.sessionId,
            turnId: "turn-0",
            taskId: request.taskId,
            actionIndex: 0,
            pullIndex: 0,
            descriptor: {
              kind: "record",
              key: "unsafe",
              retrySafety: { mode: "unsafe" },
            },
            programCapability,
          },
        });
        expect(replayed).toMatchObject({
          status: "resolved",
          outcome: { status: "error", error: { code: "effect_outcome_indeterminate" } },
        });
        const records = yield* AuthorityJournalPort.api.operations.readTree(
          request.sessionId,
          request.taskId,
        );
        expect(payloadTypes(records)).toEqual([
          "TaskOpened",
          "PullRequested",
          "AttemptStarted",
          "AttemptDetached",
          "PullIndeterminate",
          "AttemptAbandoned",
          "PullResolved",
        ]);
        expect(JSON.stringify(records)).not.toContain(localValue);
        const index = foldRecordExecutionIndex(records);
        expect(JSON.stringify([...index.tasks.values()])).not.toContain(localValue);
        assertRecordExecutionIndexMatchesForest(index, projectExecutionForest(records));
      });
    });
  }

  it("accepts a canonical record cancellation", async () => {
    const request = attach("accepted-cancellation");
    await run(function* () {
      yield* installAndOpen("stored", request);
      const result = yield* runProofRecordWorkflow({
        attach: request,
        authority: proofAuthorityPort(JournalAuthorityPort.api.operations),
        workflow: workflow("cancelled-record", function* () {
          throw new DurableProgramCancellation("attempt cancelled");
        }),
      });
      expect(result).toEqual({ state: "cancelled" });
      const records = yield* AuthorityJournalPort.api.operations.readTree(
        request.sessionId,
        request.taskId,
      );
      expect(records.find((entry) => entry.payload.type === "PullResolved")?.payload).toMatchObject(
        {
          outcome: { status: "cancelled" },
        },
      );
      expect(foldRecordExecutionIndex(records).tasks.get(request.taskId)?.lifecycle).toMatchObject({
        status: "closed",
        outcome: { status: "cancelled" },
      });
    });
  });

  for (const mode of ["memory", "stored"] as const) {
    it(`accepts and replays the record error identity in ${mode} mode`, async () => {
      const request = attach(`error-${mode}`);
      await run(function* () {
        yield* installAndOpen(mode, request);
        const result = yield* runProofRecordWorkflow({
          attach: request,
          authority: proofAuthorityPort(JournalAuthorityPort.api.operations),
          workflow: workflow("error", function* () {
            throw new CrankError("proof_error", "accepted proof error");
          }),
        });
        expect(result).toEqual({
          state: "failed",
          error: { code: "proof_error", message: "accepted proof error" },
        });
        const records = yield* AuthorityJournalPort.api.operations.readTree(
          request.sessionId,
          request.taskId,
        );
        expect(
          records.find((entry) => entry.payload.type === "PullResolved")?.payload,
        ).toMatchObject({
          outcome: { status: "error", error: { code: "proof_error" } },
        });
        expect(
          foldRecordExecutionIndex(records).tasks.get(request.taskId)?.lifecycle,
        ).toMatchObject({
          status: "closed",
          outcome: { status: "error", error: { code: "proof_error" } },
        });
      });
    });
  }

  it("uses closed result-oriented parsers at authoring and command boundaries", () => {
    expect(recordWorkflowOptionsParser.parse({ key: "parsed" })).toEqual({
      ok: true,
      value: {
        kind: "record",
        key: "parsed",
        retrySafety: { mode: "repeatable" },
      },
    });
    expect(recordWorkflowOptionsParser.parse({ key: "parsed", extra: true }).ok).toBe(false);
    expect(recordWorkflowOptionsParser.parse({ key: "" }).ok).toBe(false);
    expect(recordWorkflowOptionsParser.parse({ key: "é".repeat(65) }).ok).toBe(false);
    expect(
      recordWorkflowOptionsParser.parse({ key: "k", retrySafety: { mode: "unsafe" } }),
    ).toEqual({
      ok: true,
      value: { kind: "record", key: "k", retrySafety: { mode: "unsafe" } },
    });
    expect(recordWorkflowOptionsParser.parse({ key: "k", retrySafety: { mode: "nope" } }).ok).toBe(
      false,
    );
    expect(
      recordWorkflowOptionsParser.parse({ key: "k", retrySafety: { mode: "idempotent" } }).ok,
    ).toBe(false);
    expect(proofProgramCommandParser.parse({ type: "start", input: "input" })).toEqual({
      ok: true,
      value: { type: "start", input: "input" },
    });
    expect(proofShutdownReasonParser.parse("parked")).toEqual({ ok: true, value: "parked" });
    expect(proofShutdownReasonParser.parse("detonate").ok).toBe(false);
    const authorizeBase = {
      actionIndex: 0,
      pullId: "pull",
      attemptId: "attempt",
      descriptor: { kind: "record", key: "k", retrySafety: { mode: "repeatable" } },
    } as const;
    expect(proofProgramCommandParser.parse({ type: "authorize-record", ...authorizeBase }).ok).toBe(
      true,
    );
    expect(
      proofProgramCommandParser.parse({
        type: "authorize-record",
        ...authorizeBase,
        actionIndex: -1,
      }).ok,
    ).toBe(false);
    expect(
      proofProgramCommandParser.parse({
        type: "authorize-record",
        ...authorizeBase,
        descriptor: { kind: "record", key: "é".repeat(65), retrySafety: { mode: "repeatable" } },
      }).ok,
    ).toBe(false);
    expect(
      proofProgramCommandParser.parse({
        type: "resume-record",
        actionIndex: 0,
        outcome: { status: "ok", value: "value" },
        receipt: {
          sessionId: "session",
          taskId: "task",
          pullId: "pull",
          resolutionOffset: "not-an-offset",
          outcomeDigest: "bad-digest",
          status: "accepted",
        },
        replayed: true,
      }).ok,
    ).toBe(false);
  });

  it("rejects malformed commands and dispositions at the runtime boundary", async () => {
    const request = attach("parser-boundary");
    await run(function* () {
      yield* scoped(function* () {
        const handle = yield* openProofProgramAttachment(
          request,
          workflow("boundary", function* () {
            return "unused";
          }),
        );
        let malformedError: unknown;
        try {
          yield* handle.exchange({ type: "bogus" } as unknown as ProofProgramCommand);
        } catch (error) {
          malformedError = error;
        }
        expect(malformedError).toMatchObject({ code: "program_protocol_error" });
        let dispositionError: unknown;
        try {
          handle.setDisposition("detonate" as unknown as ProgramShutdownReason);
        } catch (error) {
          dispositionError = error;
        }
        expect(dispositionError).toMatchObject({ code: "program_protocol_error" });
      });
    });
  });

  it("routes live attempts through host middleware composed at max", async () => {
    const request = attach("attempt-port");
    const seen: CoordinatedRecordAttempt[] = [];
    let calls = 0;
    await run(function* () {
      yield* RecordAttemptPort.api.around(
        {
          *run(args, next) {
            calls += 1;
            seen.push(args[0]);
            return yield* next(...args);
          },
        },
        { at: "max" },
      );
      yield* scoped(function* () {
        const handle = yield* openProofProgramAttachment(
          request,
          workflow("coordinated", function* () {
            return "value";
          }),
        );
        const proposed = yield* handle.exchange({ type: "start", input: request.input });
        if (proposed.type !== "record-proposed") {
          throw new Error("record was not proposed");
        }
        const attempted = yield* handle.exchange({
          type: "authorize-record",
          actionIndex: 0,
          pullId: "pull-coordinated",
          attemptId: "attempt-coordinated",
          descriptor: proposed.descriptor,
        });
        expect(attempted).toMatchObject({
          type: "record-attempt-completed",
          outcome: { status: "ok", value: "value" },
        });
        if (attempted.type !== "record-attempt-completed") throw new Error("attempt missing");
        const terminal = yield* handle.exchange({
          type: "resume-record",
          actionIndex: 0,
          outcome: attempted.outcome,
          receipt: receipt(request, "pull-coordinated", attempted.outcome),
          replayed: false,
        });
        expect(terminal).toEqual({ type: "completed", actionIndex: 1, value: "sync:value:done" });
      });
      expect(calls).toBe(1);
      expect(seen[0]).toMatchObject({
        actionIndex: 0,
        pullId: "pull-coordinated",
        attemptId: "attempt-coordinated",
      });
      expect(seen[0]?.cancellation).toBeInstanceOf(AbortSignal);
    });
  });

  it("lets host middleware lose the settlement while the authority still drives the journal", async () => {
    const request = attach("attempt-loss");
    let executed = false;
    await run(function* () {
      yield* RecordAttemptPort.api.around(
        {
          *run(args) {
            const produced = yield* args[1]();
            void produced;
            return {
              status: "error" as const,
              error: { code: "lost_settlement", message: "result lost before publication" },
            };
          },
        },
        { at: "max" },
      );
      yield* scoped(function* () {
        const handle = yield* openProofProgramAttachment(
          request,
          workflow("lossy", function* () {
            executed = true;
            return "produced";
          }),
        );
        const proposed = yield* handle.exchange({ type: "start", input: request.input });
        if (proposed.type !== "record-proposed") {
          throw new Error("record was not proposed");
        }
        const attempted = yield* handle.exchange({
          type: "authorize-record",
          actionIndex: 0,
          pullId: "pull-loss",
          attemptId: "attempt-loss",
          descriptor: proposed.descriptor,
        });
        expect(attempted).toMatchObject({
          type: "record-attempt-completed",
          outcome: { status: "error", error: { code: "lost_settlement" } },
        });
        if (attempted.type !== "record-attempt-completed") throw new Error("attempt missing");
        const terminal = yield* handle.exchange({
          type: "resume-record",
          actionIndex: 0,
          outcome: attempted.outcome,
          receipt: receipt(request, "pull-loss", attempted.outcome),
          replayed: false,
        });
        expect(terminal).toMatchObject({ type: "failed", error: { code: "lost_settlement" } });
      });
      expect(executed).toBe(true);
    });
  });

  it("composes max middleware outside-in around the attachment-owned driver", async () => {
    const request = attach("attempt-order");
    const order: string[] = [];
    await run(function* () {
      yield* RecordAttemptPort.api.around(
        {
          *run(args, next) {
            order.push("host");
            const outcome = yield* next(...args);
            order.push("host-done");
            return outcome;
          },
        },
        { at: "max" },
      );
      yield* scoped(function* () {
        yield* RecordAttemptPort.api.around(
          {
            *run(args, next) {
              order.push("child");
              const outcome = yield* next(...args);
              order.push("child-done");
              return outcome;
            },
          },
          { at: "max" },
        );
        const handle = yield* openProofProgramAttachment(
          request,
          workflow("ordered", function* () {
            return "value";
          }),
        );
        const proposed = yield* handle.exchange({ type: "start", input: request.input });
        if (proposed.type !== "record-proposed") {
          throw new Error("record was not proposed");
        }
        const attempted = yield* handle.exchange({
          type: "authorize-record",
          actionIndex: 0,
          pullId: "pull-ordered",
          attemptId: "attempt-ordered",
          descriptor: proposed.descriptor,
        });
        expect(attempted).toMatchObject({
          type: "record-attempt-completed",
          outcome: { status: "ok", value: "value" },
        });
      });
      expect(order).toEqual(["host", "child", "child-done", "host-done"]);
    });
  });

  it("retains current record descriptor validation", async () => {
    const invalidWorkflows: Array<() => Workflow<Json>> = [
      function* () {
        const value = yield* record({ key: "" }, function* () {
          return "no";
        });
        return value;
      },
      function* () {
        const value = yield* record({ key: "é".repeat(65) }, function* () {
          return "no";
        });
        return value;
      },
      function* () {
        const value = yield* record(
          { key: "extra", extra: true } as unknown as { key: string },
          function* () {
            return "no";
          },
        );
        return value;
      },
      function* () {
        const value = yield* record(
          { key: "retry", retrySafety: { mode: "unknown" } } as never,
          function* () {
            return "no";
          },
        );
        return value;
      },
    ];
    for (const invalid of invalidWorkflows) {
      await expect(
        run(function* () {
          const value = yield* invalid();
          return value;
        }),
      ).rejects.toMatchObject({ code: "invalid_descriptor" });
    }

    await run(function* () {
      const request = attach("key-boundary");
      const handle = yield* openProofProgramAttachment(request, function* () {
        const value = yield* record({ key: "x".repeat(128) }, function* () {
          return "ok";
        });
        return value;
      });
      const proposed = yield* handle.exchange({ type: "start", input: request.input });
      expect(proposed).toMatchObject({ descriptor: { key: "x".repeat(128) } });
    });
  });

  it("keeps local cancel and scope disposal separate from authority cancellation", async () => {
    const request = attach("local-cancel");
    await run(function* () {
      yield* scoped(function* () {
        const handle = yield* openProofProgramAttachment(
          request,
          workflow("cancel", function* () {
            return "must-not-run";
          }),
        );
        const proposed = yield* handle.exchange({ type: "start", input: request.input });
        expect(proposed.type).toBe("record-proposed");
        const terminal = yield* handle.exchange({ type: "cancel", reason: "local-only" });
        expect(terminal).toMatchObject({
          type: "failed",
          actionIndex: 0,
          error: { code: "program_cancelled" },
        });
      });
      yield* scoped(function* () {
        const handle = yield* openProofProgramAttachment(
          request,
          workflow("dispose", function* () {
            return "must-not-run";
          }),
        );
        yield* handle.exchange({ type: "start", input: request.input });
        handle.setDisposition("transport_lost");
      });
    });
  });

  it("fails closed on a nested durable operation", async () => {
    const request = attach("nested");
    await run(function* () {
      const handle = yield* openProofProgramAttachment(request, function* () {
        const outer = yield* record({ key: "outer" }, function* () {
          const inner = yield* record({ key: "inner" }, function* () {
            return "inner";
          });
          return inner;
        });
        return outer;
      });
      const proposed = yield* handle.exchange({ type: "start", input: request.input });
      if (proposed.type !== "record-proposed") {
        throw new Error("record was not proposed");
      }
      const attempted = yield* handle.exchange({
        type: "authorize-record",
        actionIndex: 0,
        pullId: "pull-nested",
        attemptId: "attempt-nested",
        descriptor: proposed.descriptor,
      });
      expect(attempted).toMatchObject({
        type: "record-attempt-completed",
        outcome: { status: "error", error: { code: "nested_durable_operation" } },
      });
    });
  });

  it("fails a durable effect before publication when runtime Context is absent", async () => {
    await expect(
      run(function* () {
        const value = yield* (function* (): Workflow<Json> {
          const recorded = yield* record({ key: "missing-context" }, function* () {
            return "no";
          });
          return recorded;
        })();
        return value;
      }),
    ).rejects.toThrow(/journal-authority:program-effect-runtime/iu);
  });

  it("rejects malformed journal order and duplicate settlement", () => {
    const opened: DurableSemanticRecord = {
      offset: "0",
      eventId: "journal:fold-invalid:0",
      sessionId: "fold-invalid",
      payload: {
        type: "TaskOpened",
        taskId: "task-root",
        turnId: "turn-0",
        programId: manifest.programId,
        programVersion: manifest.version,
        programDigest: manifest.digest,
        input: "input",
        inputDigest: canonicalSnapshot("input").sha,
      },
    };
    const requested: DurableSemanticRecord = {
      offset: "2",
      eventId: "journal:fold-invalid:2",
      sessionId: "fold-invalid",
      payload: {
        type: "PullRequested",
        taskId: "task-root",
        turnId: "turn-0",
        actionIndex: 0,
        pullIndex: 0,
        pullId: "pull-0",
        descriptor: { kind: "record", key: "fold", retrySafety: { mode: "repeatable" } },
        descriptorDigest: canonicalSnapshot({
          kind: "record",
          key: "fold",
          retrySafety: { mode: "repeatable" },
        }).sha,
      },
    };
    expect(() => foldRecordExecutionIndex([opened, requested])).toThrowError(
      expect.objectContaining({ code: "invalid_journal" }),
    );
  });

  it("fails concurrent exchanges and cancels the resource-owned attempt", async () => {
    const request = attach("concurrent-exchange");
    const entered = withResolvers<void>("concurrent attempt entered");
    const hold = withResolvers<void>("hold concurrent attempt");
    let cleaned = false;
    await run(function* () {
      const handle = yield* openProofProgramAttachment(request, function* () {
        const value = yield* record({ key: "concurrent" }, function* () {
          try {
            entered.resolve();
            yield* hold.operation;
            return "released";
          } finally {
            cleaned = true;
          }
        });
        return value;
      });
      const proposed = yield* handle.exchange({ type: "start", input: request.input });
      if (proposed.type !== "record-proposed") {
        throw new Error("record was not proposed");
      }
      const first = yield* spawn(function* () {
        try {
          const event = yield* handle.exchange({
            type: "authorize-record",
            actionIndex: 0,
            pullId: "pull-concurrent",
            attemptId: "attempt-concurrent",
            descriptor: proposed.descriptor,
          });
          return event;
        } catch (error) {
          return error;
        }
      });
      yield* entered.operation;
      let secondError: unknown;
      try {
        yield* handle.exchange({ type: "cancel", reason: "concurrent" });
      } catch (error) {
        secondError = error;
      }
      expect(secondError).toMatchObject({ code: "program_protocol_error" });
      const firstResult = yield* first;
      expect(firstResult).toMatchObject({ code: "program_protocol_error" });
    });
    expect(cleaned).toBe(true);
  });

  it("fails the attachment on a wrong command without executing the closure", async () => {
    const request = attach("wrong-command");
    let closureRuns = 0;
    await expect(
      run(function* () {
        const handle = yield* openProofProgramAttachment(
          request,
          workflow("wrong", function* () {
            closureRuns += 1;
            return "bad";
          }),
        );
        yield* handle.exchange({ type: "start", input: request.input });
        yield* handle.exchange({
          type: "resume-record",
          actionIndex: 0,
          outcome: { status: "ok", value: "unaccepted" },
          receipt: receipt(request, "pull-wrong", { status: "ok", value: "unaccepted" }),
          replayed: false,
        });
      }),
    ).rejects.toMatchObject({ code: "program_protocol_error" });
    expect(closureRuns).toBe(0);
  });
});

function* openAndDriveWithoutAuthority(workflowFactory: () => Workflow<Json>): Operation<Json> {
  const request = attach("ephemeral-no-authority");
  const handle = yield* openProofProgramAttachment(request, workflowFactory);
  const proposed = yield* handle.exchange({ type: "start", input: request.input });
  if (proposed.type !== "record-proposed") {
    throw new Error("record was not proposed");
  }
  const attempted = yield* handle.exchange({
    type: "authorize-record",
    actionIndex: 0,
    pullId: "pull-ephemeral",
    attemptId: "attempt-ephemeral",
    descriptor: proposed.descriptor,
  });
  if (attempted.type !== "record-attempt-completed") {
    throw new Error("attempt did not complete");
  }
  const terminal = yield* handle.exchange({
    type: "resume-record",
    actionIndex: 0,
    outcome: attempted.outcome,
    receipt: receipt(request, "pull-ephemeral", attempted.outcome),
    replayed: false,
  });
  if (terminal.type !== "completed") {
    throw new CrankError("runtime_error");
  }
  return terminal.value;
}
