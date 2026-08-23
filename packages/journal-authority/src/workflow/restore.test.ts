import { run, scoped } from "effection";
import { describe, expect, it } from "vitest";
import type { Operation } from "effection";
import type { Json } from "@sweatpants/foundation";
import {
  CrankError,
  type AttachProgramRequest,
  type DurableProgramManifest,
} from "@sweatpants/durable-execution";
import { createCapabilityKeyring } from "../capabilities.ts";
import { AuthorityJournalPort, JournalAuthorityPort } from "../authority-ports.ts";
import { createStoredShellDrivers } from "../stored-shell.ts";
import { createMemoryExecutionStore } from "../memory.ts";
import { createDurableSchemaRegistry } from "../schema-registry.ts";
import { createSchemaFixture, stringGuard } from "../schema-fixtures.ts";
import type { DurableProgramManifest } from "@sweatpants/durable-execution";
import { openProgramAttachment, record, type ProgramAttachmentHandle } from "./runtime.ts";

const programInput = createSchemaFixture(
  "workflow.restore/input",
  "program_input",
  { type: "string" },
  stringGuard,
);
const programOutput = createSchemaFixture(
  "workflow.restore/output",
  "program_output",
  { type: "string" },
  stringGuard,
);
const schemaRegistry = () => createDurableSchemaRegistry([programInput.entry, programOutput.entry]);
const keyring = createCapabilityKeyring("restore-authority", [
  { keyId: "restore-key", secret: "x".repeat(32) },
]);
const digest = "e".repeat(64);
const manifest: DurableProgramManifest = {
  programId: "workflow.restore",
  version: "1.0.0",
  digest,
  inputSchema: programInput.descriptor,
  outputSchema: programOutput.descriptor,
  elicits: {},
  effects: {},
  capabilities: { durableEmissions: false, structuredChildren: false, replay: "strict" },
};

/** One persistent store survives the simulated crash; every phase mounts fresh drivers. */
function makePersistentShell() {
  const store = createMemoryExecutionStore();
  const options = {
    journalId: "workflow-restore",
    journalIncarnation: "1",
    keyring,
    schemaRegistry: schemaRegistry(),
    now: () => 1_000,
  };
  return () => createStoredShellDrivers(store, options);
}

type Shell = ReturnType<ReturnType<typeof makePersistentShell>>;

function attach(sessionId: string, attachmentId: string): AttachProgramRequest {
  return {
    sessionId,
    taskId: "task-root",
    program: { id: manifest.programId, version: manifest.version, digest: manifest.digest },
    input: "input",
    route: { driverKind: "restore-test" },
    executionEpoch: 1,
  };
}

interface ExecutionCounters {
  one: number;
  two: number;
  variant: number;
}

function program(counters: ExecutionCounters): () => Workflow<Json> {
  return function* () {
    const one = yield* record({ key: "step-one" }, function* () {
      counters.one += 1;
      return "one";
    });
    const two = yield* record({ key: "step-two" }, function* () {
      counters.two += 1;
      return "two";
    });
    return `${one}|${two}`;
  };
}

let variantRuns = 0;
function divergentProgram(): () => Workflow<Json> {
  return function* () {
    yield* record({ key: "step-one-diverged" }, function* () {
      variantRuns += 1;
      return "divergent";
    });
    return "never-reached";
  };
}

function* installDrivers(shell: Shell): Operation<void> {
  yield* JournalAuthorityPort.installDriver(shell.authority);
  yield* AuthorityJournalPort.installDriver(shell.journal);
}

function* openRootTask(sessionId: string, attachmentId: string): Operation<string> {
  const opened = yield* JournalAuthorityPort.api.operations.command({
    type: "execution.open-task",
    request: {
      sessionId,
      turnId: "turn-0",
      taskId: "task-root",
      manifest,
      input: "input",
      executionEpoch: 1,
      attachmentId,
      audience: "program-host",
      route: { driverKind: "restore-test" },
    },
  });
  return opened.programCapability;
}

function* bindRootTask(sessionId: string, attachmentId: string): Operation<string> {
  const bound = yield* JournalAuthorityPort.api.operations.command({
    type: "execution.bind-attachment",
    request: { sessionId, taskId: "task-root", attachmentId, executionEpoch: 1 },
  });
  return bound.programCapability;
}

/** Drives proposals to settlement until the terminal event; returns it. */
function* driveToTerminal(
  handle: ProgramAttachmentHandle,
  sessionId: string,
  programCapability: string,
): Generator<Operation<unknown>, Extract<ProgramEvent, { type: "completed" }>, unknown> {
  {
    let event = yield* handle.exchange({ type: "start", input: "input" });
    while (event.type !== "completed" && event.type !== "failed") {
      if (event.type !== "record-proposed") {
        throw new Error(`unexpected event ${event.type}`);
      }
      const reserved = yield* JournalAuthorityPort.api.operations.command({
        type: "execution.reserve-pull",
        request: {
          sessionId,
          turnId: "turn-0",
          taskId: "task-root",
          actionIndex: event.actionIndex,
          pullIndex: event.actionIndex,
          descriptor: event.descriptor,
          programCapability,
        },
      });
      if (reserved.status === "resolved") {
        // History already holds this settlement: replay, never re-execute.
        event = yield* handle.exchange({
          type: "resume-record",
          actionIndex: event.actionIndex,
          outcome: reserved.outcome,
          receipt: { ...reserved.receipt!, status: "accepted" },
          replayed: true,
        });
        continue;
      }
      if (reserved.status !== "authorized") {
        throw new Error(`unexpected reservation ${reserved.status}`);
      }
      const attempted = yield* handle.exchange({
        type: "authorize-record",
        actionIndex: event.actionIndex,
        pullId: reserved.pullId!,
        attemptId: reserved.attemptId!,
        descriptor: event.descriptor,
      });
      if (attempted.type !== "record-attempt-completed") {
        throw new Error(`expected attempt completion, got ${attempted.type}`);
      }
      const resolved = yield* JournalAuthorityPort.api.operations.command({
        type: "execution.resolve-pull",
        request: {
          capability: reserved.resolutionCapability!,
          audience: "program-execution",
          outcome: attempted.outcome,
        },
      });
      if (resolved.status !== "accepted") {
        throw new Error(`resolution rejected: ${resolved.status}`);
      }
      event = yield* handle.exchange({
        type: "resume-record",
        actionIndex: event.actionIndex,
        outcome: attempted.outcome,
        receipt: {
          sessionId,
          taskId: "task-root",
          pullId: reserved.pullId!,
          resolutionOffset: resolved.receipt!.resolutionOffset,
          outcomeDigest: resolved.receipt!.outcomeDigest,
          status: "accepted",
        },
        replayed: false,
      });
    }
    if (event.type !== "completed") throw new Error(event.error!.message);
    return event;
  }
}

describe("kill-and-resume restore", () => {
  const shell = makePersistentShell();
  const sessionId = "restore-crash";
  const counters: ExecutionCounters = { one: 0, two: 0, variant: 0 };

  it("phase 1 settles the first boundary and crashes before its resume", async () => {
    await run(function* () {
      yield* installDrivers(shell());
      const programCapability = yield* openRootTask(sessionId, "attachment-crash");
      yield* scoped(function* () {
        const handle = yield* openProgramAttachment(
          attach(sessionId, "attachment-crash"),
          program(counters),
        );
        let event = yield* handle.exchange({ type: "start", input: "input" });
        expect(event.type).toBe("record-proposed");
        // Settle step-one only: reserve, authorize, resolve — then crash
        // by ending the scope before the resume exchange.
        const reserved = yield* JournalAuthorityPort.api.operations.command({
          type: "execution.reserve-pull",
          request: {
            sessionId,
            turnId: "turn-0",
            taskId: "task-root",
            actionIndex: 0,
            pullIndex: 0,
            descriptor: event.descriptor,
            programCapability,
          },
        });
        expect(reserved.status).toBe("authorized");
        const attempted = yield* handle.exchange({
          type: "authorize-record",
          actionIndex: 0,
          pullId: reserved.pullId,
          attemptId: reserved.attemptId,
          descriptor: event.descriptor,
        });
        expect(attempted.type).toBe("record-attempt-completed");
        if (attempted.type !== "record-attempt-completed") return;
        const resolved = yield* JournalAuthorityPort.api.operations.command({
          type: "execution.resolve-pull",
          request: {
            capability: reserved.resolutionCapability,
            audience: "program-execution",
            outcome: attempted.outcome,
          },
        });
        expect(resolved.status).toBe("accepted");
        void resolved;
        // Crash: scope ends without the resume-record exchange.
      });
    });
    expect(counters.one).toBe(1);
    expect(counters.two).toBe(0);
  });

  it("phase 2 restores, replays settled history, and finishes live work", async () => {
    const terminal = await run(function* () {
      yield* installDrivers(shell());
      const programCapability = yield* bindRootTask(sessionId, "attachment-restore");
      return yield* scoped(function* () {
        const handle = yield* openProgramAttachment(
          attach(sessionId, "attachment-restore"),
          program(counters),
        );
        return yield* driveToTerminal(handle, sessionId, programCapability);
      });
    });
    expect(counters.one).toBe(1);
    expect(counters.two).toBe(1);
    expect(terminal.value).toBe("one|two");
  });

  it("re-running fully settled history suppresses every live execution", async () => {
    const before = { ...counters };
    await run(function* () {
      yield* installDrivers(shell());
      const programCapability = yield* bindRootTask(sessionId, "attachment-rerun");
      yield* scoped(function* () {
        const handle = yield* openProgramAttachment(
          attach(sessionId, "attachment-rerun"),
          program(counters),
        );
        const terminal = yield* driveToTerminal(handle, sessionId, programCapability);
        expect(terminal.value).toBe("one|two");
      });
    });
    expect(counters.one).toBe(before.one);
    expect(counters.two).toBe(before.two);
  });

  it("fails a restored run whose first boundary diverges from accepted history", async () => {
    await run(function* () {
      yield* installDrivers(shell());
      const programCapability = yield* bindRootTask(sessionId, "attachment-divergent");
      yield* scoped(function* () {
        const handle = yield* openProgramAttachment(
          attach(sessionId, "attachment-divergent"),
          divergentProgram(),
        );
        const started = yield* handle.exchange({ type: "start", input: "input" });
        expect(started.type).toBe("record-proposed");
        let failure: unknown;
        try {
          yield* JournalAuthorityPort.api.operations.command({
            type: "execution.reserve-pull",
            request: {
              sessionId,
              turnId: "turn-0",
              taskId: "task-root",
              actionIndex: 0,
              pullIndex: 0,
              descriptor: started.descriptor,
              programCapability,
            },
          });
        } catch (error) {
          failure = error;
        }
        expect(failure).toBeInstanceOf(CrankError);
        expect(variantRuns).toBe(0);
      });
    });
  });
});
