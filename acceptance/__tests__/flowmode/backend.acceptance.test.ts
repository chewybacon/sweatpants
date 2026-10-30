// @vitest-environment node
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { run, scoped } from "effection";
import { expect, it } from "vitest";
import {
  compileReview,
  flowmodeStack,
  linkReview,
  reviewContract,
} from "../../support/flowmode.ts";
import {
  createKernelProgramBackend,
  loadKernelProgram,
  type KernelProgramBackendOptions,
} from "@sweatpants/flowmode-backend";
import {
  createWorkflowProgramDriver,
  driveProgramDriverActivation,
} from "@sweatpants/journal-authority";
import {
  ANY_JSON_SCHEMA_DESCRIPTOR as schema,
  CrankError,
  ProgramDriverRegistryContext,
  type AttachProgramRequest,
  type ProgramCheckpoint,
  type ReplayOperationEntry,
} from "@sweatpants/durable-execution";
import {
  KernelExecutor,
  requireCompiledWorkflow,
  type WorkflowBinding,
} from "@sweatpants/flowmode-runtime";
import { luaIdentity } from "@sweatpants/flowmode-runtime-lua/kernel";
import {
  canonicalDigest,
  digestCanonicalJson,
  encodeCanonicalJson,
  sha256,
} from "@sweatpants/foundation";
import { openBetterSqliteStorage } from "@sweatpants/storage-sqlite/better-sqlite3";
import { useProgramRig } from "../../support/program.ts";

const directory = new URL("../../../.artifacts/primitive-journal/loop-5/", import.meta.url);
mkdirSync(directory, { recursive: true });
const answer = { status: "ok" as const, value: { action: "accept", content: { approved: true } } };

function receipt(outcome: unknown, actionIndex: number) {
  return {
    sessionId: "backend",
    taskId: "root",
    pullId: `pull-${actionIndex}`,
    resolutionOffset: String(actionIndex + 1),
    status: "accepted" as const,
    outcomeDigest: canonicalDigest(outcome),
  };
}

it("captures and restores real production checkpoints through scoped middleware with fresh siblings", async () => {
  const events: unknown[] = [];
  const record = (event: string, value: unknown = null) => events.push({ event, value });
  await run(function* () {
    const stack = flowmodeStack("lua");
    const definition = yield* compileReview(stack.developerCompiler);
    const options = yield* linkReview(stack, definition);
    const program = stack.createProgram({
      ...options,
      runtimeOptions: {
        middleware: [
          {
            *createKernel(args, next) {
              record("allocate");
              return yield* next(...args);
            },
          },
        ],
        kernelMiddleware: [
          {
            *start(args, next) {
              record("start");
              return yield* next(...args);
            },
            *restore(args, next) {
              record("restore");
              return yield* next(...args);
            },
            *close(args, next) {
              record("close");
              return yield* next(...args);
            },
          },
        ],
        executionMiddleware: [
          {
            *resume(args, next) {
              record("resume", args);
              return yield* next(...args);
            },
            *cancel(args, next) {
              record("cancel", args);
              return yield* next(...args);
            },
            *capture(args, next) {
              const saved = yield* next(...args);
              record("capture", saved);
              return saved;
            },
            *dispose(args, next) {
              record("dispose");
              return yield* next(...args);
            },
          },
        ],
      },
    });
    const attach: AttachProgramRequest = {
      sessionId: "backend",
      taskId: "root",
      program: {
        id: program.manifest.programId,
        version: program.manifest.version,
        digest: program.manifest.digest,
      },
      input: { title: "Publish?" },
      route: { driverKind: "workflow" },
      executionEpoch: 1,
    };
    yield* KernelExecutor.api.around({
      *start(args, next) {
        record("executor:before");
        const state = yield* next(...args);
        record("executor:after", state.boundary);
        return state;
      },
    });
    const driver = program.createDriver();
    const first = yield* driver.attach(attach);
    expect(yield* driver.step(first, { type: "start", input: attach.input })).toMatchObject({
      type: "operation",
      descriptor: { key: "approval" },
    });
    const checkpoint = JSON.parse(
      JSON.stringify(yield* driver.checkpoint(first)),
    ) as ProgramCheckpoint;
    record("checkpoint", checkpoint);
    expect(checkpoint.kind).toBe("continuation");
    yield* driver.shutdown(first, "parked");
    if (checkpoint.kind !== "continuation") {
      throw new Error("Expected continuation");
    }
    // Reuse prior evaluator checkpoints only for the same pinned program.
    // Source/import changes alter the digest and must not reuse an incompatible checkpoint.
    const baselineFile = new URL(`baseline-checkpoint-${program.manifest.digest}.json`, directory);
    const compatibility: ProgramCheckpoint = existsSync(baselineFile)
      ? (JSON.parse(readFileSync(baselineFile, "utf8")) as ProgramCheckpoint)
      : checkpoint;
    if (!existsSync(baselineFile)) {
      writeFileSync(baselineFile, JSON.stringify(checkpoint, null, 2));
    }
    if (compatibility.kind !== "continuation") {
      throw new Error("Expected baseline continuation");
    }
    const restored = yield* driver.restore({
      attach,
      checkpoint: { ...compatibility, resumeAfter: { actionIndex: -1, replayChainDigest: "seed" } },
      replay: [],
      replayChainSeed: "seed",
      replayChainDigest: "seed",
      replayedThroughActionIndex: -1,
    });
    expect(restored.frontier).toMatchObject({
      type: "operation",
      actionIndex: 0,
      descriptor: { key: "approval" },
    });
    const sibling = yield* driver.attach({ ...attach, taskId: "sibling" });
    expect(yield* driver.step(sibling, { type: "start", input: attach.input })).toMatchObject({
      type: "operation",
      descriptor: { key: "approval" },
    });
    yield* driver.shutdown(sibling, "parked");
    for (const actionIndex of [0, 1]) {
      const result = yield* driver.step(restored.attachment, {
        type: "resume",
        actionIndex,
        outcome: answer,
        replayed: true,
        receipt: receipt(answer, actionIndex),
      });
      expect(result).toMatchObject(
        actionIndex === 0
          ? { type: "operation", descriptor: { key: "cleanup" } }
          : { type: "completed", value: "approved" },
      );
      record("step", result);
    }
    const completed = yield* driver.checkpoint(restored.attachment);
    expect(completed.kind).toBe("continuation");
    record("completed-checkpoint", completed);
    expect(events.filter((e) => (e as { event: string }).event === "cancel")).toHaveLength(0);
    expect(events.filter((e) => (e as { event: string }).event === "start")).toHaveLength(2);
    expect(events.filter((e) => (e as { event: string }).event === "restore")).toHaveLength(1);
    expect(events.filter((e) => (e as { event: string }).event === "executor:before")).toHaveLength(
      3,
    );
    yield* driver.shutdown(restored.attachment, "completed");
    record("identity", program.manifest);
  });
  writeFileSync(new URL("checkpoint-evidence.json", directory), JSON.stringify(events, null, 2));
});

it("keeps logical cancellation, repeated yielding cleanup and physical disposal distinct in the production backend", async () => {
  const events: unknown[] = [];
  await run(function* () {
    const stack = flowmodeStack("lua");
    const definition = yield* compileReview(stack.developerCompiler);
    const options = yield* linkReview(stack, definition);
    const program = stack.createProgram(options);
    const backend = backendFor(program, options.bindOperation, events);
    const attach = attachmentFor(program);
    const parked = yield* backend.open(attach);
    const state = yield* parked.start();
    expect(state.boundary).toMatchObject({
      kind: "suspended",
      request: { boundary: { serializable: { descriptor: { key: "approval" } } } },
    });
    yield* parked.dispose();
    expect(events).not.toContainEqual({ event: "cancel", value: undefined });
    expect(events.map((e) => (e as { event: string }).event)).toEqual([
      "start",
      "dispose",
      "close",
    ]);
    events.length = 0;
    const cancelling = yield* backend.open(attach);
    const active = yield* cancelling.start();
    const cleanup = yield* active.execution.cancel("withdrawn");
    expect(cleanup).toMatchObject({
      kind: "suspended",
      request: { boundary: { serializable: { descriptor: { key: "cleanup" } } } },
    });
    const repeated = yield* active.execution.cancel("ignored second reason");
    expect(repeated.kind).toBe("suspended");
    if (repeated.kind !== "suspended") {
      throw new Error("Expected cleanup");
    }
    if (
      repeated.request.kind !== "record" ||
      cleanup.kind !== "suspended" ||
      cleanup.request.kind !== "record"
    ) {
      throw new Error("Expected record cleanup");
    }
    expect(repeated.request.boundary.serializable).toEqual(cleanup.request.boundary.serializable);
    expect(events.filter((e) => (e as { event: string }).event === "resume")).toHaveLength(0);
    expect(
      yield* active.execution.resume(repeated.suspensionId, { kind: "record", outcome: answer }),
    ).toEqual({ kind: "cancelled", reason: "withdrawn" });
    expect((yield* cancelling.capture()).kind).toBe("continuation");
    yield* cancelling.dispose();
    yield* cancelling.dispose();
    const cancelledOutcome = yield* backend.open(attach);
    const waiting = yield* cancelledOutcome.start();
    if (waiting.boundary.kind !== "suspended") {
      throw new Error("Expected approval");
    }
    const before = events.length;
    let mismatch: unknown;
    try {
      yield* waiting.execution.resume(waiting.boundary.suspensionId, {
        kind: "emission",
        value: null,
      });
    } catch (error) {
      mismatch = error;
    }
    expect(mismatch).toBeInstanceOf(Error);
    expect(events).toHaveLength(before);
    const pending = yield* waiting.execution.resume(waiting.boundary.suspensionId, {
      kind: "record",
      outcome: { status: "cancelled" },
    });
    expect(pending).toMatchObject({
      kind: "suspended",
      request: { boundary: { serializable: { descriptor: { key: "cleanup" } } } },
    });
    if (pending.kind !== "suspended") {
      throw new Error("Expected cleanup");
    }
    expect(
      yield* waiting.execution.resume(pending.suspensionId, { kind: "record", outcome: answer }),
    ).toMatchObject({ kind: "cancelled" });
    yield* cancelledOutcome.dispose();
  });
  writeFileSync(new URL("cancellation-evidence.json", directory), JSON.stringify(events, null, 2));
});

type RealProgram = ReturnType<ReturnType<typeof flowmodeStack>["createProgram"]>;
function attachmentFor(program: RealProgram): AttachProgramRequest {
  return {
    sessionId: "backend",
    taskId: "root",
    program: {
      id: program.manifest.programId,
      version: program.manifest.version,
      digest: program.manifest.digest,
    },
    input: { title: "Publish?" },
    route: { driverKind: "workflow" },
    executionEpoch: 1,
  };
}
function backendFor(
  program: RealProgram,
  bindOperation: KernelProgramBackendOptions["bindOperation"],
  events: unknown[],
  startError = false,
) {
  const record = (event: string, value?: unknown) => events.push({ event, value });
  return createKernelProgramBackend({
    kernelIdentity: luaIdentity,
    *manifest() {
      return program.manifest;
    },
    *loadProgram(digest) {
      return loadKernelProgram(program, digest);
    },
    createKernel: () =>
      program.createKernel({
        kernelMiddleware: [
          {
            *start(args, next) {
              record("start");
              const state = yield* next(...args);
              if (startError) {
                throw new CrankError("transport_broken", "scoped startup transport");
              }
              return state;
            },
            *close(args, next) {
              record("close");
              return yield* next(...args);
            },
          },
        ],
        executionMiddleware: [
          {
            *resume(args, next) {
              record("resume", args);
              return yield* next(...args);
            },
            *cancel(args, next) {
              record("cancel", args);
              return yield* next(...args);
            },
            *dispose(args, next) {
              record("dispose");
              return yield* next(...args);
            },
            *capture(args, next) {
              record("capture");
              return yield* next(...args);
            },
          },
        ],
      }),
    bindOperation,
  });
}

it("admits installed effects once, delivers accepted success and error through native resume, and replays without dispatch", async () => {
  const events: unknown[] = [];
  let attempts = 0;
  await run(function* () {
    const stack = flowmodeStack("lua");
    const binding: WorkflowBinding = {
      kind: "host",
      contract: {
        id: "send",
        name: "send",
        description: "Installed effect",
        inputSchema: schema,
        outputSchema: schema,
      },
      capability: { name: "send", version: "1" },
    };
    const caller = requireCompiledWorkflow(
      yield* stack.compiler.compile({
        source: {
          id: "backend-effect",
          language: "lua",
          text: 'local ok, value = pcall(function() return send(input) end)\nif ok then return value else return "caught" end',
        },
        entry: "workflow",
        exports: [],
        bindings: [binding],
      }),
    );
    const implementation = yield* stack.linker.link({ caller, bindings: [binding] });
    const descriptor = {
      kind: "effect" as const,
      name: "send",
      version: "1",
      input: null,
      resolver: { audience: "program-execution" },
    };
    const program = stack.createProgram({
      implementation,
      bindings: [binding],
      contract: {
        ...reviewContract,
        programId: "backend-effect",
        effects: {
          send: {
            name: "send",
            version: "1",
            inputSchema: schema,
            outputSchema: schema,
            retrySafety: { mode: "repeatable" },
          },
        },
      },
      bindOperation: () => descriptor,
    });
    const driver = createWorkflowProgramDriver(
      backendFor(program, () => descriptor, events),
      {
        effectHandlers: new Map([
          [
            "send",
            function* () {
              attempts++;
              return "sent";
            },
          ],
        ]),
      },
    );
    const attach = attachmentFor(program);
    const active = yield* driver.attach(attach);
    expect(yield* driver.step(active, { type: "start", input: attach.input })).toMatchObject({
      type: "operation",
      descriptor,
    });
    const saved = yield* driver.checkpoint(active);
    const attempted = yield* driver.step(active, {
      type: "authorize",
      actionIndex: 0,
      pullId: "pull-0",
      attemptId: "attempt-0",
      resolutionCapability: "driver-contract",
      descriptor,
    });
    expect(attempted).toMatchObject({ authorizedOutcome: { status: "ok", value: "sent" } });
    expect(attempts).toBe(1);
    expect(events.filter((e) => (e as { event: string }).event === "resume")).toHaveLength(0);
    expect(yield* driver.checkpoint(active)).toEqual({ kind: "replay" });
    const outcome = { status: "ok" as const, value: "sent" };
    expect(
      yield* driver.step(active, {
        type: "resume",
        actionIndex: 0,
        outcome,
        replayed: false,
        receipt: receipt(outcome, 0),
      }),
    ).toEqual({ type: "completed", actionIndex: 1, value: "sent" });
    expect((yield* driver.checkpoint(active)).kind).toBe("continuation");
    yield* driver.shutdown(active, "completed");
    const body = {
      type: "operation" as const,
      actionIndex: 0,
      descriptorKind: "effect",
      descriptorDigest: digestCanonicalJson(descriptor),
      previousEntryDigest: "seed",
      outcome,
      receipt: receipt(outcome, 0),
    };
    const entry: ReplayOperationEntry = {
      ...body,
      entryDigest: sha256(
        encodeCanonicalJson({
          replayChainSeed: "seed",
          previousEntryDigest: "seed",
          entryWithoutEntryDigest: body,
        }),
      ),
    };
    const replayDriver = createWorkflowProgramDriver(backendFor(program, () => descriptor, events));
    const replayed = yield* replayDriver.restore({
      attach,
      checkpoint:
        saved.kind === "continuation"
          ? { ...saved, resumeAfter: { actionIndex: -1, replayChainDigest: "seed" } }
          : saved,
      replay: [entry],
      replayChainSeed: "seed",
      replayChainDigest: entry.entryDigest,
      replayedThroughActionIndex: 0,
    });
    expect(replayed.frontier).toEqual({ type: "completed", actionIndex: 1, value: "sent" });
    expect(attempts).toBe(1);
    yield* replayDriver.shutdown(replayed.attachment, "completed");
    const failing = yield* replayDriver.attach(attach);
    yield* replayDriver.step(failing, { type: "start", input: attach.input });
    const error = {
      status: "error" as const,
      error: { code: "declined", message: "host declined" },
    };
    expect(
      yield* replayDriver.step(failing, {
        type: "resume",
        actionIndex: 0,
        outcome: error,
        replayed: true,
        receipt: receipt(error, 0),
      }),
    ).toEqual({ type: "completed", actionIndex: 1, value: "caught" });
    yield* replayDriver.shutdown(failing, "completed");
    expect(events.filter((e) => (e as { event: string }).event === "resume")).toMatchObject([
      { value: [expect.any(String), { kind: "value", value: "sent" }] },
      { value: [expect.any(String), { kind: "value", value: "sent" }] },
      { value: [expect.any(String), { kind: "throw", value: error.error }] },
    ]);
    // The public activation path obtains mandates and accepts the attempt in the
    // real SQLite authority. The direct driver checks above isolate delivery timing.
    yield* scoped(function* () {
      const path = mkdtempSync(fileURLToPath(new URL("effect-authority-", directory)));
      const storage = yield* openBetterSqliteStorage(`${path}/authority.sqlite`, {
        initialize: true,
      });
      let authorityAttempts = 0;
      const authorizedProgram = {
        manifest: program.manifest,
        createDriver: () =>
          createWorkflowProgramDriver(
            backendFor(program, () => descriptor, events),
            {
              effectHandlers: new Map([
                [
                  "send",
                  function* () {
                    authorityAttempts++;
                    return "sent";
                  },
                ],
              ]),
            },
          ),
      };
      try {
        const rig = yield* useProgramRig(
          storage.storage.executionStore,
          authorizedProgram,
          attach.input,
        );
        yield* rig.journal.advance({
          type: "execution.open-task",
          request: {
            ...rig.attach,
            turnId: "turn",
            manifest: program.manifest,
            attachmentId: "unattached",
            audience: "acceptance",
          },
        });
        const authorityDriver = authorizedProgram.createDriver();
        const result = yield* ProgramDriverRegistryContext.with(
          new Map([["acceptance", authorityDriver]]),
          () =>
            driveProgramDriverActivation({
              authority: {
                command: rig.journal.advance.bind(rig.journal),
                query: rig.journal.query.bind(rig.journal),
              },
              driver: authorityDriver,
              attach: rig.attach,
              advancement: {
                effects: {
                  *route() {
                    return "execution" as const;
                  },
                  *executeHost() {
                    throw new Error("Expected installed execution");
                  },
                },
              },
            }),
        );
        expect(result).toEqual({ state: "completed", value: "sent" });
        const fresh = yield* useProgramRig(
          storage.storage.executionStore,
          authorizedProgram,
          attach.input,
        );
        expect(yield* fresh.advance()).toEqual({ state: "completed", value: "sent" });
        expect(authorityAttempts).toBe(1);
        const records = yield* fresh.journal.readSession(fresh.attach.sessionId);
        expect(records.filter((r) => r.payload.type === "PullRequested")).toHaveLength(1);
        writeFileSync(
          `${path}/records.json`,
          JSON.stringify({ authorityAttempts, records }, null, 2),
        );
      } finally {
        yield* storage.close();
      }
    });
  });
  writeFileSync(
    new URL("effect-evidence.json", directory),
    JSON.stringify({ attempts, events }, null, 2),
  );
});

it("preserves real guest diagnostics and scoped transport failure with replay fallback and close", async () => {
  const evidence: unknown[] = [];
  for (const transport of [false, true]) {
    const events: unknown[] = [];
    await run(function* () {
      const stack = flowmodeStack("lua");
      const caller = requireCompiledWorkflow(
        yield* stack.compiler.compile({
          source: { id: "backend-failure", language: "lua", text: 'error("authored failure")' },
          entry: "workflow",
          exports: [],
          bindings: [],
        }),
      );
      const implementation = yield* stack.linker.link({ caller, bindings: [] });
      const program = stack.createProgram({
        implementation,
        contract: reviewContract,
        bindOperation() {
          throw new Error("No request");
        },
      });
      const driver = createWorkflowProgramDriver(
        backendFor(
          program,
          () => {
            throw new Error("No request");
          },
          events,
          transport,
        ),
      );
      const attachment = yield* driver.attach(attachmentFor(program));
      const result = yield* driver.step(attachment, {
        type: "start",
        input: attachmentFor(program).input,
      });
      expect(result).toMatchObject({
        type: "failed",
        error: {
          code: transport ? "transport_broken" : "workflow_failed",
          message: expect.stringContaining(
            transport ? "scoped startup transport" : "authored failure",
          ),
        },
      });
      expect(yield* driver.checkpoint(attachment)).toEqual({ kind: "replay" });
      yield* driver.shutdown(attachment, "failed");
      expect(events.some((e) => (e as { event: string }).event === "close")).toBe(true);
      evidence.push({ transport, result, events });
    });
  }
  writeFileSync(new URL("failure-evidence.json", directory), JSON.stringify(evidence, null, 2));
});

it("retains exactly the approval and cleanup records in a real SQLite authority across fresh production drivers", async () => {
  const path = mkdtempSync(fileURLToPath(new URL("review-authority-", directory)));
  await run(function* () {
    const stack = flowmodeStack("lua");
    const definition = yield* compileReview(stack.developerCompiler);
    const options = yield* linkReview(stack, definition);
    const program = stack.createProgram(options);
    const storage = yield* openBetterSqliteStorage(`${path}/authority.sqlite`, {
      initialize: true,
    });
    const phases: unknown[] = [];
    try {
      const first = yield* useProgramRig(storage.storage.executionStore, program, {
        title: "Publish?",
      });
      yield* first.journal.advance({
        type: "execution.open-task",
        request: {
          ...first.attach,
          turnId: "turn",
          manifest: program.manifest,
          attachmentId: "unattached",
          audience: "acceptance",
        },
      });
      const ids: string[] = [];
      for (const key of ["approval", "cleanup"]) {
        const rig = yield* useProgramRig(
          storage.storage.executionStore,
          stack.createProgram(options),
          { title: "Publish?" },
        );
        const result = yield* rig.advance();
        expect(result.state).toBe("parked");
        if (result.state !== "parked") {
          throw new Error("Expected park");
        }
        ids.push(result.pullId);
        const records = yield* rig.journal.readSession(rig.attach.sessionId);
        const pulls = records
          .filter((r) => r.payload.type === "PullRequested")
          .map((r) => r.payload);
        expect(pulls).toHaveLength(ids.length);
        expect(pulls.at(-1)).toMatchObject({ descriptor: { kind: "elicit", key } });
        phases.push({ key, result, records });
        const capability = yield* rig.journal.query({
          type: "pull.resolution-capability",
          sessionId: rig.attach.sessionId,
          taskId: "root",
          pullId: result.pullId,
        });
        const accepted = yield* rig.journal.advance({
          type: "execution.resolve-pull",
          request: { capability, audience: `user:${key}`, outcome: answer },
        });
        expect(accepted.status).not.toBe("rejected");
      }
      expect(new Set(ids).size).toBe(2);
      const final = yield* useProgramRig(
        storage.storage.executionStore,
        stack.createProgram(options),
        { title: "Publish?" },
      );
      expect(yield* final.advance()).toEqual({ state: "completed", value: "approved" });
      const records = yield* final.journal.readSession(final.attach.sessionId);
      expect(records.filter((r) => r.payload.type === "PullRequested")).toHaveLength(2);
      writeFileSync(
        `${path}/records.json`,
        JSON.stringify({ identity: program.manifest, phases, records }, null, 2),
      );
    } finally {
      yield* storage.close();
    }
  });
});
