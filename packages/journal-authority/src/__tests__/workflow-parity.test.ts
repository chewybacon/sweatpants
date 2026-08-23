import { run, scoped } from "effection";
import { describe, expect, it } from "vitest";
import {
  ExecutionDurableEffectRegistryContext,
  ProgramDriverRegistryContext,
  ProgramRouteResolver,
  createProgramDriverRegistry,
  createDurableToolRegistry,
  createPinnedDurableProgram,
  createLocalProgramDriver,
  ProgramRuntime,
  stableProgramAttachmentId,
  type AttachProgramRequest,
  type DurableProgramManifest,
} from "@sweatpants/durable-execution";
import type { Json } from "@sweatpants/foundation";
import { canonicalSnapshot } from "@sweatpants/foundation";
import {
  DurableEffectRegistryContext,
  DurableEffectRouting,
  createDurableEffectRegistry,
} from "@sweatpants/durable-effects/runtime";
import { withAuthorityTestScope } from "../journal-program-runtime.ts";
import { driveActivation } from "../workflow/host-drive.ts";
import { createAuthorityScenarioDriver } from "../testing.ts";
import { projectExecutionForest } from "../execution-forest.ts";
import {
  elicit,
  effect,
  emit,
  invoke,
  openProgramAttachment,
  record,
  wait,
  type Workflow,
} from "../workflow/runtime.ts";
import { booleanGuard, createSchemaFixture, stringGuard } from "../schema-fixtures.ts";
import { createCapabilityKeyring } from "../capabilities.ts";
import { createDurableSchemaRegistry } from "../schema-registry.ts";

const programInput = createSchemaFixture(
  "fixture.parity/input",
  "program_input",
  { type: "string" },
  stringGuard,
);
const programOutput = createSchemaFixture(
  "fixture.parity/output",
  "program_output",
  { type: "string" },
  stringGuard,
);
const echoInput = createSchemaFixture(
  "fixture.parity/echo-input",
  "effect_input",
  { type: "object" },
  () => undefined,
);
const echoOutput = createSchemaFixture(
  "fixture.parity/echo-output",
  "effect_output",
  { type: "string" },
  stringGuard,
);
const approvalResponse = createSchemaFixture(
  "fixture.parity/approval-response",
  "elicit_response",
  { type: "boolean" },
  booleanGuard,
);
const schemaRegistry = () =>
  createDurableSchemaRegistry([
    programInput.entry,
    programOutput.entry,
    echoInput.entry,
    echoOutput.entry,
    approvalResponse.entry,
  ]);
const keyring = createCapabilityKeyring("parity-authority", [
  { keyId: "parity-key", secret: "x".repeat(32) },
]);
const digest = "f".repeat(64);

const manifest: DurableProgramManifest = {
  programId: "fixture.parity",
  version: "1.0.0",
  digest,
  inputSchema: programInput.descriptor,
  outputSchema: programOutput.descriptor,
  elicits: {
    approval: { response: approvalResponse.descriptor },
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
  capabilities: { durableEmissions: true, structuredChildren: false, replay: "strict" },
};

const childManifest: DurableProgramManifest = {
  programId: "fixture.parity.child",
  version: "1.0.0",
  digest: "e".repeat(64),
  inputSchema: programInput.descriptor,
  outputSchema: programOutput.descriptor,
  elicits: {},
  effects: {},
  capabilities: { durableEmissions: false, structuredChildren: false, replay: "strict" },
};
const invokeManifest: DurableProgramManifest = {
  ...manifest,
  programId: "fixture.parity.invoke-parent",
  digest: "d".repeat(64),
  capabilities: { ...manifest.capabilities, structuredChildren: true },
};

function attach(sessionId: string): AttachProgramRequest {
  return {
    sessionId,
    taskId: "turn-0/root",
    program: { id: manifest.programId, version: manifest.version, digest: manifest.digest },
    input: "hello",
    route: { driverKind: "program" },
    executionEpoch: 1,
  };
}

/**
 * Shared authority clock. Waits stamp `notBefore` from this at reserve time
 * and gate resolution against it; sections reset it before driving.
 */
let clockMs = 1_000;

function makeAuthority(journalId: string) {
  return createAuthorityScenarioDriver({
    journalId,
    journalIncarnation: "incarnation-1",
    keyring,
    now: () => clockMs,
    schemaRegistry: schemaRegistry(),
  });
}

function payloadTypes(records: readonly { payload: { type: string } }[]): string[] {
  return records.map((entry) => entry.payload.type);
}

function settledValues(records: readonly { payload: { type: string; outcome?: Json } }[]): Json[] {
  return records
    .filter((entry) => entry.payload.type === "PullResolved")
    .map((entry) =>
      entry.payload.type === "PullResolved"
        ? (entry.payload.outcome as { value: Json }).value
        : undefined,
    );
}

interface ScenarioResult {
  value: Json;
  journalTypes: string[];
  forest: unknown;
  settledValues: Json[];
}

describe("legacy vs workflow runtime parity", () => {
  it("produces identical journals for an effect-and-emission program", async () => {
    const sessionId = "parity-inline";

    // ── Legacy runtime ──
    const oldResult = await run(function* () {
      const authority = makeAuthority("journal-parity-inline-legacy");
      const tool = createPinnedDurableProgram(manifest, function* (_input, context) {
        const a = yield* context.record({ key: "step-one" }, function* () {
          return "one";
        });
        const echoed = yield* context.effect<string>(
          "echo",
          "1.0.0",
          { message: a },
          { audience: "program-execution" },
        );
        yield* context.emit("workflow.parity/between", { after: echoed });
        const b = yield* context.record({ key: "step-two" }, function* () {
          return "two";
        });
        return `${a}|${echoed}|${b}`;
      });
      const drivers = createProgramDriverRegistry([
        ["program", createLocalProgramDriver(createDurableToolRegistry([tool]))],
      ]);
      const effects = createDurableEffectRegistry([
        {
          definition: manifest.effects["echo"]!,
          satisfies: { mode: "idempotent", mechanism: "pull_id_key" },
          handler: (input) =>
            (function* () {
              return { status: "ok" as const, value: `${input["message"]}-executed` };
            })(),
        },
      ]);
      const request = attach(sessionId);
      yield* withAuthorityTestScope(authority, function* () {
        yield* authority.openTask({
          sessionId: request.sessionId,
          turnId: "turn-0",
          taskId: request.taskId,
          manifest,
          input: request.input,
          executionEpoch: 1,
          attachmentId: stableProgramAttachmentId(request),
          audience: "program-host",
        });
        yield* DurableEffectRouting.around({
          *route() {
            return { placement: "execution" as const };
          },
        });
        yield* ProgramDriverRegistryContext.with(drivers, function* () {
          yield* DurableEffectRegistryContext.with(effects, function* () {
            yield* ExecutionDurableEffectRegistryContext.with(effects, function* () {
              yield* ProgramRuntime.operations.run({
                attach: request,
                executeHostEffects: true,
              });
            });
          });
        });
      });
      const journal = authority.readJournal(sessionId);
      const closed = journal.find((entry) => entry.payload.type === "TaskClosed");
      if (!closed || closed.payload.type !== "TaskClosed") {
        throw new Error("legacy did not close the task");
      }
      return {
        value: (closed.payload.outcome as { value: Json }).value,
        journalTypes: payloadTypes(journal),
        forest: canonicalSnapshot(projectExecutionForest(journal)),
        settledValues: settledValues(journal),
      };
    });

    // ── New runtime ──
    const newResult = await run(function* () {
      const authority = makeAuthority("journal-parity-inline-modern");
      const request = attach(sessionId);
      let terminalValue: Json | undefined;
      yield* withAuthorityTestScope(authority, function* () {
        const opened = yield* authority.openTask({
          sessionId: request.sessionId,
          turnId: "turn-0",
          taskId: request.taskId,
          manifest,
          input: request.input,
          executionEpoch: 1,
          attachmentId: stableProgramAttachmentId(request),
          audience: "program-host",
        });
        const settled = yield* driveActivation({
          attach: request,
          authority,
          programCapability: opened.programCapability,
          workflow: function* (): Workflow<Json> {
            const a = yield* record({ key: "step-one" }, function* () {
              return "one";
            });
            const echoed = yield* effect(
              {
                name: "echo",
                version: "1.0.0",
                input: { message: a },
                resolver: { audience: "program-execution" },
              },
              function* () {
                return `${a}-executed`;
              },
            );
            yield* emit("workflow.parity/between", { after: echoed });
            const b = yield* record({ key: "step-two" }, function* () {
              return "two";
            });
            return `${a}|${echoed}|${b}`;
          },
        });
        if (settled.state !== "completed") {
          throw new Error(`unexpected activation state ${settled.state}`);
        }
        terminalValue = settled.value;
      });
      const journal = authority.readJournal(sessionId);
      if (terminalValue === undefined) throw new Error("no terminal value");
      return {
        value: terminalValue,
        journalTypes: payloadTypes(journal),
        forest: canonicalSnapshot(projectExecutionForest(journal)),
        settledValues: settledValues(journal),
      };
    });

    expect(newResult.value).toBe(oldResult.value);
    expect(newResult.journalTypes).toEqual(oldResult.journalTypes);
    expect(newResult.forest).toEqual(oldResult.forest);
    expect(newResult.settledValues).toEqual(oldResult.settledValues);
    expect(newResult.settledValues).toEqual(["one", "one-executed", "two"]);
  });

  it("parks elicitations identically across activations in both runtimes", async () => {
    const sessionId = "parity-parked";
    const settledOutcome: Json = { action: "accept", content: true };

    // ── Legacy runtime: ProgramRuntime.run parks natively on elicit. ──
    const oldResult = await run(function* () {
      const authority = makeAuthority("journal-parity-parked-legacy");
      const tool = createPinnedDurableProgram(manifest, function* (_input, context) {
        yield* context.elicit<boolean>("approval", "Continue?", approvalResponse.descriptor);
        return "approved:true";
      });
      const drivers = createProgramDriverRegistry([
        ["program", createLocalProgramDriver(createDurableToolRegistry([tool]))],
      ]);
      const request = attach(sessionId);
      let journalTypes: string[] = [];
      let forest: unknown;
      yield* withAuthorityTestScope(authority, function* () {
        yield* authority.openTask({
          sessionId: request.sessionId,
          turnId: "turn-0",
          taskId: request.taskId,
          manifest,
          input: request.input,
          executionEpoch: 1,
          attachmentId: stableProgramAttachmentId(request),
          audience: "program-host",
        });
        const firstRun = yield* ProgramDriverRegistryContext.with(drivers, function* () {
          return yield* ProgramRuntime.operations.run({ attach: request });
        });
        if (firstRun.state !== "parked" || firstRun.reason !== "elicit") {
          throw new Error(`expected parked elicit, got ${firstRun.state}/${firstRun.reason}`);
        }
        const pending = authority
          .readJournal(sessionId)
          .find(
            (entry) =>
              entry.payload.type === "PullRequested" && entry.payload.descriptor.kind === "elicit",
          );
        if (!pending || pending.payload.type !== "PullRequested") {
          throw new Error("elicitation was not recorded");
        }
        const capability = authority.resolutionCapability(
          sessionId,
          request.taskId,
          pending.payload.pullId,
        );
        const resolved = yield* authority.resolve({
          capability,
          audience: "user:approval",
          outcome: { status: "ok", value: settledOutcome },
        });
        if (resolved.status !== "accepted") {
          throw new Error(`resolution rejected: ${resolved.status}`);
        }
        const journal = authority.readJournal(sessionId);
        journalTypes = payloadTypes(journal);
        forest = canonicalSnapshot(projectExecutionForest(journal));
      });
      return { journalTypes, forest };
    });

    // ── New runtime: host parks by ending activation on pending; an ──
    // ── external participant settles; settlement semantics must match. ──
    const newResult = await run(function* () {
      const authority = makeAuthority("journal-parity-parked-modern");
      const request = attach(sessionId);
      let pullId = "";
      let capability = "";
      let journalTypes: string[] = [];
      let forest: unknown;
      yield* withAuthorityTestScope(authority, function* () {
        const opened = yield* authority.openTask({
          sessionId: request.sessionId,
          turnId: "turn-0",
          taskId: request.taskId,
          manifest,
          input: request.input,
          executionEpoch: 1,
          attachmentId: stableProgramAttachmentId(request),
          audience: "program-host",
        }) as unknown as { programCapability: string };

        // Activation 1: propose, reserve pending, park by ending activation.
        yield* scoped(function* () {
          const handle = yield* openProgramAttachment(request, function* (): Workflow<Json> {
            yield* elicit({
              key: "approval",
              message: "Continue?",
              response: approvalResponse.descriptor,
            });
            return "approved:true";
          });
          const started = yield* handle.exchange({ type: "start", input: "hello" });
          if (started.type !== "record-proposed") throw new Error("not proposed");
          expect(started.descriptor.kind).toBe("elicit");
          const reserved = yield* authority.reserve({
            sessionId: request.sessionId,
            turnId: "turn-0",
            taskId: request.taskId,
            actionIndex: 0,
            pullIndex: 0,
            descriptor: started.descriptor,
            programCapability: opened.programCapability,
          });
          if (reserved.status !== "pending") {
            throw new Error(`expected pending, got ${reserved.status}`);
          }
          pullId = reserved.pullId;
          capability = reserved.resolutionCapability;
          // Park: end this activation with the elicitation still open.
        });

        // Participant settles while no activation is running.
        const resolved = yield* authority.resolve({
          capability,
          audience: "user:approval",
          outcome: { status: "ok", value: settledOutcome },
        });
        if (resolved.status !== "accepted") {
          throw new Error(`resolution rejected: ${resolved.status}`);
        }

        // Activation 2: restore replays the settled elicitation.
        const bound = yield* authority.bindProgramAttachment(
          request.sessionId,
          request.taskId,
          stableProgramAttachmentId(request) + "-2",
          1,
        );
        yield* scoped(function* () {
          const handle = yield* openProgramAttachment(request, function* (): Workflow<Json> {
            yield* elicit({
              key: "approval",
              message: "Continue?",
              response: approvalResponse.descriptor,
            });
            return "approved:true";
          });
          const started = yield* handle.exchange({ type: "start", input: "hello" });
          if (started.type !== "record-proposed") throw new Error("not proposed on restore");
          const reserved = yield* authority.reserve({
            sessionId: request.sessionId,
            turnId: "turn-0",
            taskId: request.taskId,
            actionIndex: 0,
            pullIndex: 0,
            descriptor: started.descriptor,
            programCapability: bound.programCapability,
          });
          if (reserved.status !== "resolved") {
            throw new Error(`expected resolved replay, got ${reserved.status}`);
          }
          yield* handle.exchange({
            type: "resume-record",
            actionIndex: 0,
            outcome: reserved.outcome,
            receipt: reserved.receipt,
            replayed: true,
          });
        });
        const journal = authority.readJournal(request.sessionId);
        journalTypes = payloadTypes(journal);
        forest = canonicalSnapshot(projectExecutionForest(journal));
      });
      return { journalTypes, forest };
    });

    expect(newResult.journalTypes).toEqual(oldResult.journalTypes);
    expect(newResult.forest).toEqual(oldResult.forest);
  });

  it("settles waits through the authority clock identically in both runtimes", async () => {
    const sessionId = "parity-wait";

    // ── Legacy runtime: park on the wait, settle after the clock advances. ──
    clockMs = 1_000;
    const oldResult = await run(function* () {
      const authority = makeAuthority("journal-parity-wait-legacy");
      const tool = createPinnedDurableProgram(manifest, function* (_input, context) {
        yield* context.clock.sleep(5_000, "cool-off");
        return "woke";
      });
      const drivers = createProgramDriverRegistry([
        ["program", createLocalProgramDriver(createDurableToolRegistry([tool]))],
      ]);
      const request = attach(sessionId);
      yield* withAuthorityTestScope(authority, function* () {
        yield* authority.openTask({
          sessionId: request.sessionId,
          turnId: "turn-0",
          taskId: request.taskId,
          manifest,
          input: request.input,
          executionEpoch: 1,
          attachmentId: stableProgramAttachmentId(request),
          audience: "program-host",
        });
        const firstRun = yield* ProgramDriverRegistryContext.with(drivers, function* () {
          return yield* ProgramRuntime.operations.run({ attach: request });
        });
        if (firstRun.state !== "parked" || firstRun.reason !== "wait") {
          throw new Error(`expected parked wait, got ${firstRun.state}/${firstRun.reason}`);
        }
        const pending = authority
          .readJournal(sessionId)
          .find(
            (entry) =>
              entry.payload.type === "PullRequested" && entry.payload.descriptor.kind === "wait",
          );
        if (!pending || pending.payload.type !== "PullRequested") {
          throw new Error("wait was not recorded");
        }
        const capability = authority.resolutionCapability(
          sessionId,
          request.taskId,
          pending.payload.pullId,
        );
        // Before due: rejection carries the public error code.
        const early = yield* authority.resolve({
          capability,
          audience: "scheduler",
          outcome: { status: "ok", value: null },
        });
        if (early.status !== "rejected" || early.code !== "wait_not_due") {
          throw new Error(`expected wait_not_due, got ${early.status}`);
        }
        clockMs += 6_000;
        const resolved = yield* authority.resolve({
          capability,
          audience: "scheduler",
          outcome: { status: "ok", value: null },
        });
        if (resolved.status !== "accepted") {
          throw new Error(`resolution rejected: ${resolved.status}`);
        }
        // Restore activation replays the settled wait and completes.
        const secondRun = yield* ProgramDriverRegistryContext.with(drivers, function* () {
          return yield* ProgramRuntime.operations.run({ attach: request });
        });
        if (secondRun.state !== "completed") {
          throw new Error(`restore did not complete: ${secondRun.state}`);
        }
      });
      const journal = authority.readJournal(sessionId);
      return {
        value: "woke",
        journalTypes: payloadTypes(journal),
        forest: canonicalSnapshot(projectExecutionForest(journal)),
        settledValues: settledValues(journal),
      };
    });

    // ── New runtime: host parks by ending activation; clock settles; ──
    // ── restored activation replays. ──
    clockMs = 1_000;
    const newResult = await run(function* () {
      const authority = makeAuthority("journal-parity-wait-modern");
      const request = attach(sessionId);
      yield* withAuthorityTestScope(authority, function* () {
        const opened = yield* authority.openTask({
          sessionId: request.sessionId,
          turnId: "turn-0",
          taskId: request.taskId,
          manifest,
          input: request.input,
          executionEpoch: 1,
          attachmentId: stableProgramAttachmentId(request),
          audience: "program-host",
        }) as unknown as { programCapability: string };

        // Activation 1: propose the wait, reserve pending, park.
        let pullId = "";
        let capability = "";
        yield* scoped(function* () {
          const handle = yield* openProgramAttachment(request, function* (): Workflow<Json> {
            yield* wait({ key: "cool-off", durationMs: 5_000 });
            return "woke";
          });
          const started = yield* handle.exchange({ type: "start", input: "hello" });
          if (started.type !== "record-proposed") throw new Error("not proposed");
          if (started.descriptor.kind !== "wait") throw new Error("not a wait");
          const reserved = yield* authority.reserve({
            sessionId: request.sessionId,
            turnId: "turn-0",
            taskId: request.taskId,
            actionIndex: started.actionIndex,
            pullIndex: 0,
            descriptor: started.descriptor,
            programCapability: opened.programCapability,
          });
          if (reserved.status !== "pending") {
            throw new Error(`expected pending, got ${reserved.status}`);
          }
          pullId = reserved.pullId;
          capability = reserved.resolutionCapability;
        });

        const early = yield* authority.resolve({
          capability,
          audience: "scheduler",
          outcome: { status: "ok", value: null },
        });
        if (early.status !== "rejected" || early.code !== "wait_not_due") {
          throw new Error(`expected wait_not_due, got ${early.status}`);
        }
        clockMs += 6_000;
        const resolved = yield* authority.resolve({
          capability,
          audience: "scheduler",
          outcome: { status: "ok", value: null },
        });
        if (resolved.status !== "accepted") {
          throw new Error(`resolution rejected: ${resolved.status}`);
        }
        void pullId;

        // Activation 2: restore replays the settled wait and completes.
        const bound = yield* authority.bindProgramAttachment(
          request.sessionId,
          request.taskId,
          stableProgramAttachmentId(request) + "-2",
          1,
        );
        yield* scoped(function* () {
          const handle = yield* openProgramAttachment(request, function* (): Workflow<Json> {
            yield* wait({ key: "cool-off", durationMs: 5_000 });
            return "woke";
          });
          const started = yield* handle.exchange({ type: "start", input: "hello" });
          if (started.type !== "record-proposed") throw new Error("not proposed on restore");
          const reserved = yield* authority.reserve({
            sessionId: request.sessionId,
            turnId: "turn-0",
            taskId: request.taskId,
            actionIndex: 0,
            pullIndex: 0,
            descriptor:
              started.type === "record-proposed" ? started.descriptor : (undefined as never),
            programCapability: bound.programCapability,
          });
          if (reserved.status !== "resolved") {
            throw new Error(`expected resolved replay, got ${reserved.status}`);
          }
          const terminal = yield* handle.exchange({
            type: "resume-record",
            actionIndex: 0,
            outcome: reserved.outcome,
            receipt: reserved.receipt,
            replayed: true,
          });
          if (terminal.type !== "completed") throw new Error(`terminal ${terminal.type}`);
          yield* authority.complete({
            sessionId: request.sessionId,
            taskId: request.taskId,
            actionIndex: terminal.actionIndex,
            outcome: { status: "ok", value: terminal.value },
            programCapability: bound.programCapability,
          });
        });
      });
      const journal = authority.readJournal(request.sessionId);
      return {
        value: "woke",
        journalTypes: payloadTypes(journal),
        forest: canonicalSnapshot(projectExecutionForest(journal)),
        settledValues: settledValues(journal),
      };
    });

    expect(newResult.value).toBe(oldResult.value);
    expect(newResult.journalTypes).toEqual(oldResult.journalTypes);
    expect(newResult.forest).toEqual(oldResult.forest);
    expect(newResult.settledValues).toEqual(oldResult.settledValues);
    expect(newResult.settledValues).toEqual([null]);
  });

  it("composes child invocations identically in both runtimes", async () => {
    const sessionId = "parity-invoke";

    // ── Legacy runtime: ProgramRuntime composes the child inline. ──
    const oldResult = await run(function* () {
      const authority = makeAuthority("journal-parity-invoke-legacy");
      const parentTool = createPinnedDurableProgram(invokeManifest, function* (_input, context) {
        const childResult = yield* context.invoke<Json>({
          id: childManifest.programId,
          version: childManifest.version,
          digest: childManifest.digest,
          input: "for-child",
        });
        return `parent:${childResult}`;
      });
      const childTool = createPinnedDurableProgram(childManifest, function* () {
        return "child-done";
      });
      const drivers = createProgramDriverRegistry([
        ["program", createLocalProgramDriver(createDurableToolRegistry([parentTool, childTool]))],
      ]);
      const request: AttachProgramRequest = {
        sessionId,
        taskId: "turn-0/root",
        program: {
          id: invokeManifest.programId,
          version: invokeManifest.version,
          digest: invokeManifest.digest,
        },
        input: "hello",
        route: { driverKind: "program" },
        executionEpoch: 1,
      };
      yield* withAuthorityTestScope(authority, function* () {
        yield* authority.openTask({
          sessionId: request.sessionId,
          turnId: "turn-0",
          taskId: request.taskId,
          manifest: invokeManifest,
          input: request.input,
          executionEpoch: 1,
          attachmentId: stableProgramAttachmentId(request),
          audience: "program-host",
        });
        const runResult = yield* ProgramDriverRegistryContext.with(drivers, function* () {
          return yield* ProgramRuntime.operations.run({ attach: request });
        });
        if (runResult.state !== "completed") {
          throw new Error(`legacy invoke did not complete: ${runResult.state}`);
        }
      });
      const journal = authority.readJournal(sessionId);
      const closed = journal.find((entry) => entry.payload.type === "TaskClosed");
      if (!closed || closed.payload.type !== "TaskClosed") {
        throw new Error("legacy invoke did not close the task");
      }
      return {
        value: (closed.payload.outcome as { value: Json }).value,
        journalTypes: payloadTypes(journal),
        forest: canonicalSnapshot(projectExecutionForest(journal)),
        settledValues: settledValues(journal),
      };
    });

    // ── New runtime: host drives the same composition protocol. Route ──
    // ── derivation goes through the shared ProgramRouteResolver port. ──
    const newResult = await run(function* () {
      const authority = makeAuthority("journal-parity-invoke-modern");
      const request: AttachProgramRequest = {
        sessionId,
        taskId: "turn-0/root",
        program: {
          id: invokeManifest.programId,
          version: invokeManifest.version,
          digest: invokeManifest.digest,
        },
        input: "hello",
        route: { driverKind: "program" },
        executionEpoch: 1,
      };
      yield* withAuthorityTestScope(authority, function* () {
        const opened = yield* authority.openTask({
          sessionId: request.sessionId,
          turnId: "turn-0",
          taskId: request.taskId,
          manifest: invokeManifest,
          input: request.input,
          executionEpoch: 1,
          attachmentId: stableProgramAttachmentId(request),
          audience: "program-host",
        }) as unknown as { programCapability: string };

        // Activation 1: propose the invocation, reserve pending, park.
        let childDescriptor!: { id: string; version: string; digest: string; input: Json };
        let pullId = "";
        yield* scoped(function* () {
          const handle = yield* openProgramAttachment(request, function* (): Workflow<Json> {
            const childResult = yield* invoke({
              child: {
                id: childManifest.programId,
                version: childManifest.version,
                digest: childManifest.digest,
                input: "for-child",
              },
            });
            return `parent:${childResult}`;
          });
          const started = yield* handle.exchange({ type: "start", input: "hello" });
          if (started.type !== "record-proposed" || started.descriptor.kind !== "invoke") {
            throw new Error("expected invoke proposal");
          }
          if (started.descriptor.kind !== "invoke") return;
          childDescriptor = started.descriptor.child;
          const reserved = yield* authority.reserve({
            sessionId: request.sessionId,
            turnId: "turn-0",
            taskId: request.taskId,
            actionIndex: started.actionIndex,
            pullIndex: 0,
            descriptor: started.descriptor,
            programCapability: opened.programCapability,
          });
          if (reserved.status !== "pending") {
            throw new Error(`expected pending, got ${reserved.status}`);
          }
          pullId = reserved.pullId;
        });

        // Host composes: resolve route via the shared port, ensure-child,
        // run the child to completion, close it — closing settles the
        // parent pull.
        const routeResolver = yield* ProgramRouteResolver.use();
        const childRoute = yield* routeResolver.resolve({
          program: childDescriptor as never,
          parentRoute: request.route,
        });
        const childTask = yield* authority.ensureChildTask({
          sessionId: request.sessionId,
          turnId: "turn-0",
          parentTaskId: request.taskId,
          parentPullId: pullId,
          child: childDescriptor,
          manifest: childManifest,
          executionEpoch: 1,
          audience: "program-runtime",
          route: childRoute,
        });
        const childRequest: AttachProgramRequest = {
          sessionId: request.sessionId,
          taskId: childTask.taskId,
          program: {
            id: childManifest.programId,
            version: childManifest.version,
            digest: childManifest.digest,
          },
          input: "for-child",
          route: childRoute,
          executionEpoch: 1,
        };
        const childBound = yield* authority.bindProgramAttachment(
          request.sessionId,
          childTask.taskId,
          stableProgramAttachmentId(childRequest),
          1,
        );
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
          if (childStarted.type !== "completed") {
            throw new Error(`child did not complete: ${childStarted.type}`);
          }
          yield* authority.complete({
            sessionId: request.sessionId,
            taskId: childTask.taskId,
            actionIndex: childStarted.actionIndex,
            outcome: { status: "ok", value: childStarted.value },
            programCapability: childBound.programCapability,
          });
        });

        // Activation 2: parent replays the settled invocation.
        const bound = yield* authority.bindProgramAttachment(
          request.sessionId,
          request.taskId,
          stableProgramAttachmentId(request) + "-2",
          1,
        );
        yield* scoped(function* () {
          const handle = yield* openProgramAttachment(request, function* (): Workflow<Json> {
            const childResult = yield* invoke({
              child: {
                id: childManifest.programId,
                version: childManifest.version,
                digest: childManifest.digest,
                input: "for-child",
              },
            });
            return `parent:${childResult}`;
          });
          const started = yield* handle.exchange({ type: "start", input: "hello" });
          if (started.type !== "record-proposed") throw new Error("not proposed on restore");
          const reserved = yield* authority.reserve({
            sessionId: request.sessionId,
            turnId: "turn-0",
            taskId: request.taskId,
            actionIndex: started.actionIndex,
            pullIndex: 0,
            descriptor:
              started.type === "record-proposed" ? started.descriptor : (undefined as never),
            programCapability: bound.programCapability,
          });
          if (reserved.status !== "resolved") {
            throw new Error(`expected resolved replay, got ${reserved.status}`);
          }
          const terminal = yield* handle.exchange({
            type: "resume-record",
            actionIndex: started.actionIndex,
            outcome: reserved.outcome,
            receipt: reserved.receipt,
            replayed: true,
          });
          if (terminal.type !== "completed") throw new Error(`terminal ${terminal.type}`);
          yield* authority.complete({
            sessionId: request.sessionId,
            taskId: request.taskId,
            actionIndex: terminal.actionIndex,
            outcome: { status: "ok", value: terminal.value },
            programCapability: bound.programCapability,
          });
        });
      });
      const journal = authority.readJournal(request.sessionId);
      return {
        journalTypes: payloadTypes(journal),
        forest: canonicalSnapshot(projectExecutionForest(journal)),
        settledValues: settledValues(journal),
      };
    });

    expect(newResult.journalTypes).toEqual(oldResult.journalTypes);
    expect(newResult.forest).toEqual(oldResult.forest);
    expect(newResult.settledValues).toEqual(oldResult.settledValues);
    expect(newResult.settledValues).toEqual(["child-done"]);
  });

  it.each([
    {
      name: "thrown plain errors",
      code: "program_error",
      body: function* (): Workflow<Json> {
        throw new Error("boom");
      },
      legacyBody: function* (): Generator<Json> {
        throw new Error("boom");
      },
    },
    {
      name: "output schema violations",
      code: "schema_validation_failed",
      body: function* (): Workflow<Json> {
        return 42;
      },
      legacyBody: function* (): Generator<Json> {
        return 42;
      },
    },
    {
      name: "oversized terminal values",
      code: "payload_too_large",
      body: function* (): Workflow<Json> {
        return "x".repeat(2 * 1024 * 1024);
      },
      legacyBody: function* (): Generator<Json> {
        return "x".repeat(2 * 1024 * 1024);
      },
    },
  ])("closes value-refusal failures identically in both runtimes: $name", async (scenario) => {
    const sessionId = `parity-failure-${scenario.code}`;

    // ── Legacy runtime ──
    const oldResult = await run(function* () {
      const authority = makeAuthority(`journal-${sessionId}-legacy`);
      const tool = createPinnedDurableProgram(manifest, scenario.legacyBody);
      const drivers = createProgramDriverRegistry([
        ["program", createLocalProgramDriver(createDurableToolRegistry([tool]))],
      ]);
      const request = attach(sessionId);
      yield* withAuthorityTestScope(authority, function* () {
        yield* authority.openTask({
          sessionId: request.sessionId,
          turnId: "turn-0",
          taskId: request.taskId,
          manifest,
          input: request.input,
          executionEpoch: 1,
          attachmentId: stableProgramAttachmentId(request),
          audience: "program-host",
        });
        const runResult = yield* ProgramDriverRegistryContext.with(drivers, function* () {
          return yield* ProgramRuntime.operations.run({ attach: request });
        });
        if (runResult.state !== "failed") {
          throw new Error(`legacy did not fail: ${runResult.state}`);
        }
        if (runResult.error.code !== scenario.code) {
          throw new Error(`legacy code ${runResult.error.code}, expected ${scenario.code}`);
        }
      });
      return authority.readJournal(sessionId);
    });

    // ── New runtime ──
    const newResult = await run(function* () {
      const authority = makeAuthority(`journal-${sessionId}-modern`);
      const request = attach(sessionId);
      yield* withAuthorityTestScope(authority, function* () {
        const opened = yield* authority.openTask({
          sessionId: request.sessionId,
          turnId: "turn-0",
          taskId: request.taskId,
          manifest,
          input: request.input,
          executionEpoch: 1,
          attachmentId: stableProgramAttachmentId(request),
          audience: "program-host",
        }) as unknown as { programCapability: string };
        const settled = yield* driveActivation({
          attach: request,
          authority,
          programCapability: opened.programCapability,
          workflow: scenario.body,
        });
        if (settled.state !== "failed") {
          throw new Error(`modern did not fail: ${settled.state}`);
        }
        if (settled.error.code !== scenario.code) {
          throw new Error(`modern code ${settled.error.code}, expected ${scenario.code}`);
        }
      });
      return authority.readJournal(request.sessionId);
    });

    // Journals must be indistinguishable, including TaskClosed{error}.
    const oldClosed = oldResult.find((e) => e.payload.type === "TaskClosed");
    const newClosed = newResult.find((e) => e.payload.type === "TaskClosed");
    expect(newClosed).toBeDefined();
    expect(
      newClosed && newClosed.payload.type === "TaskClosed"
        ? (newClosed.payload.outcome as { status: string }).status
        : undefined,
    ).toBe("error");
    expect(payloadTypes(newResult)).toEqual(payloadTypes(oldResult));
    expect(canonicalSnapshot(projectExecutionForest(newResult))).toEqual(
      canonicalSnapshot(projectExecutionForest(oldResult)),
    );
  });
});
