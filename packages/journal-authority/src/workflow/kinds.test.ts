import { run, scoped, type Operation } from "effection";
import { describe, expect, it } from "vitest";
import type { Json } from "@sweatpants/foundation";
import { CrankError } from "@sweatpants/durable-execution";
import { createCapabilityKeyring } from "../capabilities.ts";
import { AuthorityJournalPort, JournalAuthorityPort } from "../authority-ports.ts";
import { createInMemoryShellDrivers } from "../in-memory-shell.ts";
import { createDurableSchemaRegistry } from "../schema-registry.ts";
import { createSchemaFixture, stringGuard } from "../schema-fixtures.ts";
import type { DurableProgramManifest } from "@sweatpants/durable-execution";
import type { ResolveOperationResult } from "../authority-types.ts";
import {
  elicit,
  effect,
  installedEffect,
  InstalledEffectPort,
  invoke,
  openProgramAttachment,
  wait,
  type ProgramEvent,
  type Workflow,
} from "./runtime.ts";

const programInput = createSchemaFixture(
  "workflow.kinds/input",
  "program_input",
  { type: "string" },
  stringGuard,
);
const programOutput = createSchemaFixture(
  "workflow.kinds/output",
  "program_output",
  { type: "string" },
  stringGuard,
);
const echoInput = createSchemaFixture(
  "workflow.kinds/echo-input",
  "effect_input",
  { type: "object" },
  () => undefined,
);
const echoOutput = createSchemaFixture(
  "workflow.kinds/echo-output",
  "effect_output",
  { type: "string" },
  stringGuard,
);
const confirmResponse = createSchemaFixture(
  "workflow.kinds/confirm-response",
  "elicitation_response",
  { type: "object" },
  () => undefined,
);

let clockMs = 1_000;
const schemaRegistry = () =>
  createDurableSchemaRegistry([
    programInput.entry,
    programOutput.entry,
    echoInput.entry,
    echoOutput.entry,
    confirmResponse.entry,
  ]);
const keyring = createCapabilityKeyring("kinds-authority", [
  { keyId: "kinds-key", secret: "x".repeat(32) },
]);
const digest = "c".repeat(64);
const manifest: DurableProgramManifest = {
  programId: "workflow.kinds",
  version: "1.0.0",
  digest,
  inputSchema: programInput.descriptor,
  outputSchema: programOutput.descriptor,
  elicits: {
    confirm: { response: confirmResponse.descriptor },
  },
  effects: {
    echo: {
      name: "echo",
      version: "1.0.0",
      inputSchema: echoInput.descriptor,
      outputSchema: echoOutput.descriptor,
      retrySafety: { mode: "idempotent", mechanism: "pull_id_key" },
    },
  },
  capabilities: { durableEmissions: false, structuredChildren: true, replay: "strict" },
};

const childManifest: DurableProgramManifest = {
  ...manifest,
  programId: "workflow.kinds.child",
  digest: "d".repeat(64),
  capabilities: { durableEmissions: false, structuredChildren: false, replay: "strict" },
};

function drivers() {
  return createInMemoryShellDrivers({
    journalId: "workflow-kinds",
    journalIncarnation: "1",
    keyring,
    schemaRegistry: schemaRegistry(),
    now: () => clockMs,
  });
}

function attach(sessionId: string) {
  return {
    sessionId,
    taskId: "task-root",
    program: { id: manifest.programId, version: manifest.version, digest: manifest.digest },
    input: "input",
    route: { driverKind: "kinds-test" },
    executionEpoch: 1,
  };
}

function* installMemoryAuthority(sessionId: string): Operation<string> {
  const shell = drivers();
  yield* JournalAuthorityPort.installDriver(shell.authority);
  yield* AuthorityJournalPort.installDriver(shell.journal);
  const opened = yield* JournalAuthorityPort.api.operations.command({
    type: "execution.open-task",
    request: {
      sessionId,
      turnId: "turn-0",
      taskId: "task-root",
      manifest,
      input: "input",
      executionEpoch: 1,
      attachmentId: `attachment-${sessionId}`,
      audience: "program-host",
      route: { driverKind: "kinds-test" },
    },
  });
  return opened.programCapability;
}

function expectEvent(event: ProgramEvent, type: ProgramEvent["type"]): void {
  if (event.type !== type) {
    throw new Error(`expected ${type}, got ${event.type}`);
  }
}

describe("sequential pull kinds", () => {
  it("executes a declared effect through reservation fencing and schema validation", async () => {
    const request = attach("effect-live");
    await run(function* () {
      const programCapability = yield* installMemoryAuthority(request.sessionId);
      const authority = JournalAuthorityPort.api.operations;
      let attemptPullId = "";
      yield* scoped(function* () {
        const handle = yield* openProgramAttachment(request, function* (): Workflow<Json> {
          const echoed = yield* effect(
            {
              name: "echo",
              version: "1.0.0",
              input: { message: "hello" },
              resolver: { audience: "program-execution" },
            },
            function* (attempt) {
              attemptPullId = attempt.pullId;
              return "echo:hello";
            },
          );
          return echoed;
        });
        const proposed = yield* handle.exchange({ type: "start", input: request.input });
        expectEvent(proposed, "record-proposed");
        if (proposed.type !== "record-proposed") return;
        expect(proposed.descriptor.kind).toBe("effect");
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
        if (reserved.status !== "authorized") {
          throw new Error(`unexpected reservation ${reserved.status}`);
        }
        expect(reserved.effectDefinition?.name).toBe("echo");
        expect(typeof reserved.effectContractDigest).toBe("string");
        if (reserved.descriptor.kind !== "effect") return;
        const attempted = yield* handle.exchange({
          type: "authorize-record",
          actionIndex: 0,
          pullId: reserved.pullId,
          attemptId: reserved.attemptId,
          descriptor: proposed.descriptor,
        });
        expectEvent(attempted, "record-attempt-completed");
        if (attempted.type !== "record-attempt-completed") return;
        expect(attemptPullId).toBe(reserved.pullId);
        expect(attempted.outcome).toMatchObject({
          status: "ok",
          value: "echo:hello",
        });
        const resolved = yield* authority.command({
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
        const resumed = yield* handle.exchange({
          type: "resume-record",
          actionIndex: 0,
          outcome: attempted.outcome,
          receipt: {
            sessionId: request.sessionId,
            taskId: request.taskId,
            pullId: reserved.pullId,
            resolutionOffset: resolved.receipt.resolutionOffset,
            outcomeDigest: resolved.receipt.outcomeDigest,
            status: "accepted",
          },
          replayed: false,
        });
        expectEvent(resumed, "completed");
        if (resumed.type === "completed") {
          expect(resumed.value).toBe("echo:hello");
        }
      });
    });
  });

  it("rejects effects that the program manifest does not declare", async () => {
    const request = attach("effect-undeclared");
    let failure: unknown;
    await run(function* () {
      const programCapability = yield* installMemoryAuthority(request.sessionId);
      const authority = JournalAuthorityPort.api.operations;
      yield* scoped(function* () {
        const handle = yield* openProgramAttachment(request, function* (): Workflow<Json> {
          return yield* effect(
            {
              name: "ghost",
              version: "1.0.0",
              input: {},
              resolver: { audience: "program-execution" },
            },
            function* () {
              return "never";
            },
          );
        });
        const proposed = yield* handle.exchange({ type: "start", input: request.input });
        expectEvent(proposed, "record-proposed");
        if (proposed.type !== "record-proposed") return;
        try {
          yield* authority.command({
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
        } catch (error) {
          failure = error;
        }
      });
    });
    expect(failure).toBeInstanceOf(CrankError);
    expect((failure as CrankError).code).toBe("invalid_descriptor");
  });

  it("settles waits through the authority clock with wait_not_due rejection before due", async () => {
    const request = attach("wait-clock");
    await run(function* () {
      const programCapability = yield* installMemoryAuthority(request.sessionId);
      const authority = JournalAuthorityPort.api.operations;
      yield* scoped(function* () {
        const handle = yield* openProgramAttachment(request, function* (): Workflow<Json> {
          yield* wait({ key: "cool-off", durationMs: 5_000 });
          return "woke";
        });
        const proposed = yield* handle.exchange({ type: "start", input: request.input });
        expectEvent(proposed, "record-proposed");
        if (proposed.type !== "record-proposed") return;
        expect(proposed.descriptor.kind).toBe("wait");
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
        if (reserved.status !== "pending") {
          throw new Error(`expected pending, got ${reserved.status}`);
        }
        expect(reserved.resolutionCapability).toBeTruthy();
        const early = yield* authority.command({
          type: "execution.resolve-pull",
          request: {
            capability: reserved.resolutionCapability!,
            audience: "scheduler",
            outcome: { status: "ok", value: null },
          },
        });
        const earlyResult = early as ResolveOperationResult;
        expect(earlyResult.status).toBe("rejected");
        if (earlyResult.status === "rejected") {
          expect(earlyResult.code).toBe("wait_not_due");
        }
        clockMs += 6_000;
        const resolved = yield* authority.command({
          type: "execution.resolve-pull",
          request: {
            capability: reserved.resolutionCapability!,
            audience: "scheduler",
            outcome: { status: "ok", value: null },
          },
        });
        const resolution = resolved as ResolveOperationResult;
        if (resolution.status !== "accepted") {
          throw new Error(`resolution rejected: ${resolution.status}`);
        }
        const terminal = yield* handle.exchange({
          type: "resume-record",
          actionIndex: 0,
          outcome: { status: "ok", value: null },
          receipt: {
            sessionId: request.sessionId,
            taskId: request.taskId,
            pullId: reserved.pullId,
            resolutionOffset: resolution.receipt.resolutionOffset,
            outcomeDigest: resolution.receipt.outcomeDigest,
            status: "accepted",
          },
          replayed: true,
        });
        expectEvent(terminal, "completed");
        if (terminal.type === "completed") {
          expect(terminal.value).toBe("woke");
        }
      });
    });
    clockMs = 1_000;
  });

  it("settles declared elicitations through participant validation", async () => {
    const request = attach("elicit-participant");
    await run(function* () {
      const programCapability = yield* installMemoryAuthority(request.sessionId);
      const authority = JournalAuthorityPort.api.operations;
      yield* scoped(function* () {
        const handle = yield* openProgramAttachment(request, function* (): Workflow<Json> {
          yield* elicit({
            key: "confirm",
            message: "Proceed?",
            response: confirmResponse.descriptor,
          });
          return "confirmed";
        });
        const proposed = yield* handle.exchange({ type: "start", input: request.input });
        expectEvent(proposed, "record-proposed");
        if (proposed.type !== "record-proposed") return;
        expect(proposed.descriptor.kind).toBe("elicit");
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
        if (reserved.status !== "pending") {
          throw new Error(`expected pending, got ${reserved.status}`);
        }
        const invalid = yield* authority.query({
          type: "pull.validate-elicit-response",
          request: {
            sessionId: request.sessionId,
            pullId: reserved.pullId,
            participantId: "user:confirm",
            completion: { unexpected: true },
          },
        });
        expect(invalid.status).toBe("schema_validation_failed");
        const validated = yield* authority.query({
          type: "pull.validate-elicit-response",
          request: {
            sessionId: request.sessionId,
            pullId: reserved.pullId,
            participantId: "user:confirm",
            completion: { action: "accept", content: { confirmed: true } },
          },
        });
        if (validated.status !== "valid") {
          throw new Error(`validation failed: ${validated.status}`);
        }
        expect(validated.audience).toBe("user:confirm");
        const resolved = (yield* authority.command({
          type: "execution.resolve-pull",
          request: {
            capability: reserved.resolutionCapability!,
            audience: validated.audience,
            outcome: validated.outcome,
          },
        })) as ResolveOperationResult;
        if (resolved.status !== "accepted") {
          throw new Error(`resolution rejected: ${resolved.status}`);
        }
        const terminal = yield* handle.exchange({
          type: "resume-record",
          actionIndex: 0,
          outcome: validated.outcome,
          receipt: {
            sessionId: request.sessionId,
            taskId: request.taskId,
            pullId: reserved.pullId,
            resolutionOffset: resolved.receipt.resolutionOffset,
            outcomeDigest: resolved.receipt.outcomeDigest,
            status: "accepted",
          },
          replayed: true,
        });
        expectEvent(terminal, "completed");
        if (terminal.type === "completed") {
          expect(terminal.value).toBe("confirmed");
        }
      });
    });
  });

  it("composes a child program run and settles the parent invocation", async () => {
    const request = attach("invoke-parent");
    await run(function* () {
      const parentCapability = yield* installMemoryAuthority(request.sessionId);
      const authority = JournalAuthorityPort.api.operations;
      yield* scoped(function* () {
        const handle = yield* openProgramAttachment(request, function* (): Workflow<Json> {
          const result = yield* invoke({
            child: {
              id: childManifest.programId,
              version: childManifest.version,
              digest: childManifest.digest,
              input: "for-child",
            },
          });
          return result;
        });
        const proposed = yield* handle.exchange({ type: "start", input: request.input });
        expectEvent(proposed, "record-proposed");
        if (proposed.type !== "record-proposed") return;
        expect(proposed.descriptor.kind).toBe("invoke");
        const reserved = yield* authority.command({
          type: "execution.reserve-pull",
          request: {
            sessionId: request.sessionId,
            turnId: "turn-0",
            taskId: request.taskId,
            actionIndex: 0,
            pullIndex: 0,
            descriptor: proposed.descriptor,
            programCapability: parentCapability,
          },
        });
        if (reserved.status !== "pending" || !reserved.resolutionCapability) {
          throw new Error(`expected pending with capability, got ${reserved.status}`);
        }
        if (proposed.descriptor.kind !== "invoke") return;
        const childTask = yield* authority.command({
          type: "execution.ensure-child",
          request: {
            sessionId: request.sessionId,
            turnId: "turn-0",
            parentTaskId: request.taskId,
            parentPullId: reserved.pullId,
            child: proposed.descriptor.child,
            manifest: childManifest,
            executionEpoch: 1,
            audience: "workflow-host",
            route: { driverKind: "kinds-test" },
          },
        });
        const childRequest = {
          sessionId: request.sessionId,
          taskId: childTask.taskId,
          program: {
            id: childManifest.programId,
            version: childManifest.version,
            digest: childManifest.digest,
          },
          input: "for-child",
          route: { driverKind: "kinds-test" },
          executionEpoch: 1,
        };
        const childBound = yield* authority.command({
          type: "execution.bind-attachment",
          request: {
            sessionId: request.sessionId,
            taskId: childTask.taskId,
            attachmentId: `attachment-${childTask.taskId}`,
            executionEpoch: 1,
          },
        });
        const childCapability = childBound.programCapability;
        yield* scoped(function* () {
          const childHandle = yield* openProgramAttachment(
            childRequest,
            function* (): Workflow<Json> {
              return "child-done";
            },
          );
          const childStarted = yield* childHandle.exchange({
            type: "start",
            input: "for-child",
          });
          expectEvent(childStarted, "completed");
        });
        yield* authority.command({
          type: "execution.complete-task",
          request: {
            sessionId: request.sessionId,
            taskId: childTask.taskId,
            actionIndex: 0,
            outcome: { status: "ok", value: "child-done" },
            programCapability: childCapability,
          },
        });
        // Completing the child settles the parent pull; a fresh reservation
        // returns the settled outcome with its journal receipt (replay path).
        const settled = yield* authority.command({
          type: "execution.reserve-pull",
          request: {
            sessionId: request.sessionId,
            turnId: "turn-0",
            taskId: request.taskId,
            actionIndex: 0,
            pullIndex: 0,
            descriptor: proposed.descriptor,
            programCapability: parentCapability,
          },
        });
        if (settled.status !== "resolved") {
          throw new Error(`expected resolved replay, got ${settled.status}`);
        }
        const terminal = yield* handle.exchange({
          type: "resume-record",
          actionIndex: 0,
          outcome: settled.outcome,
          receipt: settled.receipt,
          replayed: true,
        });
        expectEvent(terminal, "completed");
        if (terminal.type === "completed") {
          expect(terminal.value).toBe("child-done");
        }
      });
    });
  });

  it("parks an elicitation across activations until the participant settles", async () => {
    const request = attach("elicit-parked");
    const shellDrivers = createInMemoryShellDrivers({
      journalId: "workflow-kinds-parked",
      journalIncarnation: "1",
      keyring,
      schemaRegistry: schemaRegistry(),
      now: () => 1_000,
    });
    function* install(): Operation<void> {
      yield* JournalAuthorityPort.installDriver(shellDrivers.authority);
      yield* AuthorityJournalPort.installDriver(shellDrivers.journal);
    }
    const authority = JournalAuthorityPort.api.operations;

    // ── Activation 1: propose the elicitation, reserve it, then park. ──
    let pullId = "";
    let capability = "";
    let programCapability = "";
    await run(function* () {
      yield* install();
      const opened = (yield* authority.command({
        type: "execution.open-task",
        request: {
          sessionId: request.sessionId,
          turnId: "turn-0",
          taskId: request.taskId,
          manifest,
          input: "input",
          executionEpoch: 1,
          attachmentId: "attachment-elicit-1",
          audience: "program-host",
          route: { driverKind: "kinds-test" },
        },
      })) as unknown as { programCapability: string };
      programCapability = opened.programCapability;
      yield* scoped(function* () {
        const handle = yield* openProgramAttachment(request, function* (): Workflow<Json> {
          yield* elicit({
            key: "confirm",
            message: "Proceed?",
            response: confirmResponse.descriptor,
          });
          return "confirmed";
        });
        const started = yield* handle.exchange({ type: "start", input: "input" });
        expectEvent(started, "record-proposed");
        if (started.type !== "record-proposed") throw new Error("record was not proposed");
        const reserved = (yield* authority.command({
          type: "execution.reserve-pull",
          request: {
            sessionId: request.sessionId,
            turnId: "turn-0",
            taskId: request.taskId,
            actionIndex: 0,
            pullIndex: 0,
            descriptor: started.descriptor,
            programCapability,
          },
        })) as unknown as { status: string; pullId: string; resolutionCapability?: string };
        expect(reserved.status).toBe("pending");
        pullId = reserved.pullId;
        capability = reserved.resolutionCapability ?? "";
        // Park: end the activation with the elicitation still open.
      });
    });
    expect(pullId).toBeTruthy();

    // ── Participant settles while no activation is running. ──
    await run(function* () {
      yield* install();
      const validated = yield* authority.query({
        type: "pull.validate-elicit-response",
        request: {
          sessionId: request.sessionId,
          pullId,
          participantId: "user:confirm",
          completion: { action: "accept", content: { confirmed: true } },
        },
      });
      if (validated.status !== "valid") {
        throw new Error(`validation failed: ${validated.status}`);
      }
      const resolved = yield* authority.command({
        type: "execution.resolve-pull",
        request: { capability, audience: validated.audience, outcome: validated.outcome },
      });
      if (resolved.status !== "accepted") {
        throw new Error(`resolution rejected: ${resolved.status}`);
      }
    });

    // ── Activation 2: restore replays the settled elicitation and finishes. ──
    const terminal = await run(function* () {
      yield* install();
      const bound = (yield* authority.command({
        type: "execution.bind-attachment",
        request: {
          sessionId: request.sessionId,
          taskId: request.taskId,
          attachmentId: "attachment-elicit-2",
          executionEpoch: 1,
        },
      })) as unknown as { programCapability: string };
      return yield* scoped(function* () {
        const handle = yield* openProgramAttachment(request, function* (): Workflow<Json> {
          yield* elicit({
            key: "confirm",
            message: "Proceed?",
            response: confirmResponse.descriptor,
          });
          return "confirmed";
        });
        const started = yield* handle.exchange({ type: "start", input: "input" });
        expectEvent(started, "record-proposed");
        if (started.type !== "record-proposed") throw new Error("record was not proposed");
        const reserved = yield* authority.command({
          type: "execution.reserve-pull",
          request: {
            sessionId: request.sessionId,
            turnId: "turn-0",
            taskId: request.taskId,
            actionIndex: 0,
            pullIndex: 0,
            descriptor: started.descriptor,
            programCapability: bound.programCapability,
          },
        });
        if (reserved.status !== "resolved") {
          throw new Error(`expected resolved replay, got ${reserved.status}`);
        }
        return yield* handle.exchange({
          type: "resume-record",
          actionIndex: 0,
          outcome: reserved.outcome,
          receipt: reserved.receipt,
          replayed: true,
        });
      });
    });
    expectEvent(terminal, "completed");
    if (terminal.type === "completed") {
      expect(terminal.value).toBe("confirmed");
    }
  });

  it("executes installed effects through the handler port", async () => {
    const request = attach("installed-effect");
    await run(function* () {
      const programCapability = yield* installMemoryAuthority(request.sessionId);
      const authority = JournalAuthorityPort.api.operations;
      yield* scoped(function* () {
        yield* InstalledEffectPort.installDriver({
          *run(descriptor) {
            if (descriptor.name !== "echo") {
              throw new CrankError("invalid_descriptor", "unknown effect");
            }
            const input = descriptor.input;
            if (input === null || typeof input !== "object" || Array.isArray(input)) {
              throw new CrankError("invalid_descriptor", "effect input is not an object");
            }
            return `${String(input["message"])}-handled`;
          },
        });
        const handle = yield* openProgramAttachment(request, function* (): Workflow<Json> {
          const out = yield* installedEffect({
            name: "echo",
            version: "1.0.0",
            input: { message: "host" },
            resolver: { audience: "program-execution" },
          });
          return out;
        });
        const started = yield* handle.exchange({ type: "start", input: "input" });
        expectEvent(started, "record-proposed");
        if (started.type !== "record-proposed") throw new Error("record was not proposed");
        const reserved = yield* authority.command({
          type: "execution.reserve-pull",
          request: {
            sessionId: request.sessionId,
            turnId: "turn-0",
            taskId: request.taskId,
            actionIndex: 0,
            pullIndex: 0,
            descriptor: started.descriptor,
            programCapability,
          },
        });
        if (reserved.status !== "authorized") {
          throw new Error(`unexpected reservation ${reserved.status}`);
        }
        const attempted = yield* handle.exchange({
          type: "authorize-record",
          actionIndex: 0,
          pullId: reserved.pullId,
          attemptId: reserved.attemptId,
          descriptor: started.descriptor,
        });
        expect(attempted).toMatchObject({
          type: "record-attempt-completed",
          outcome: { status: "ok", value: "host-handled" },
        });
      });
    });
  });

  it("fails closed on installed effects when no handler is registered", async () => {
    const request = attach("installed-effect-missing");
    await run(function* () {
      yield* installMemoryAuthority(request.sessionId);
      yield* scoped(function* () {
        const handle = yield* openProgramAttachment(request, function* (): Workflow<Json> {
          return yield* installedEffect({
            name: "echo",
            version: "1.0.0",
            input: {},
            resolver: { audience: "program-execution" },
          });
        });
        const started = yield* handle.exchange({ type: "start", input: "input" });
        if (started.type !== "record-proposed") throw new Error("record was not proposed");
        const attempted = yield* handle.exchange({
          type: "authorize-record",
          actionIndex: 0,
          pullId: "pull-installed",
          attemptId: "attempt-installed",
          descriptor: started.descriptor,
        });
        expect(attempted).toMatchObject({
          type: "record-attempt-completed",
          outcome: {
            status: "error",
            error: { code: "program_protocol_error" },
          },
        });
      });
    });
  });
});
