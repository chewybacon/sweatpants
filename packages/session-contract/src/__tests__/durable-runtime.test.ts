import { run, type Operation } from "effection";
import { describe, expect, it } from "vitest";

import {
  DurableEffectRegistryContext,
  JournalAuthority,
  JournalAuthorityContext,
  ProgramDriverRegistryContext,
  ProgramPeer,
  ProgramRuntime,
  createCapabilityKeyring,
  createDurableEffectRegistry,
  createDurableTool,
  createDurableToolRegistry,
  createInMemoryDurableJournalAuthority,
  createLocalGeneratorDriver,
  createProgramDriverRegistry,
  stableProgramAttachmentId,
  type AttachProgramRequest,
  type DurableProgramManifest,
  type Json,
} from "../index.ts";

const digest = "a".repeat(64);
const manifest: DurableProgramManifest = {
  programId: "fixture.basic",
  version: "1.0.0",
  digest,
  inputSchema: { type: "string" },
  outputSchema: { type: "string" },
  elicits: {
    approval: { responseSchema: { type: "boolean" } },
  },
  effects: {
    echo: {
      name: "echo",
      version: "1",
      inputSchema: { type: "string" },
      outputSchema: { type: "string" },
      retrySafety: { mode: "idempotent", mechanism: "pull_id_key" },
    },
    mutate: {
      name: "mutate",
      version: "1",
      inputSchema: true,
      outputSchema: true,
      retrySafety: { mode: "unsafe", onIndeterminate: "await_decision" },
    },
  },
  capabilities: { durableEmissions: true, structuredChildren: true, replay: "strict" },
};

const keyring = createCapabilityKeyring("test-issuer", [
  { keyId: "key-1", secret: "x".repeat(32) },
]);

function attachRequest(sessionId = "session-1"): AttachProgramRequest {
  return {
    sessionId,
    taskId: "turn-0/root",
    program: { id: manifest.programId, version: manifest.version, digest: manifest.digest },
    input: "hello",
    route: { driverKind: "generator" },
    executionEpoch: 1,
  };
}

function createAuthority(sessionId = "session-1", now: () => number = () => 1_000) {
  const authority = createInMemoryDurableJournalAuthority({
    journalId: "journal-1",
    journalIncarnation: "incarnation-1",
    keyring,
    now,
  });
  const attach = attachRequest(sessionId);
  return { authority, attach };
}

describe("crank-native durable runtime", () => {
  it("validates manifests and drives a disposable local generator with ordered actions", async () => {
    const tool = createDurableTool(manifest, function* (input, context) {
      yield* context.emit("progress", { input });
      return yield* context.effect<string>("echo", "1", input, { audience: "host-effects" });
    });
    const registry = createDurableToolRegistry([tool]);
    const driver = createLocalGeneratorDriver(registry);

    await run(function* () {
      const attachment = yield* driver.attach(attachRequest());
      expect(() => JSON.stringify(attachment)).toThrow(/runtime-only/);
      const emission = yield* driver.step(attachment, { type: "start", input: "hello" });
      expect(emission).toMatchObject({ type: "emission", actionIndex: 0 });
      const operation = yield* driver.step(attachment, {
        type: "ack_emission",
        actionIndex: 0,
        offset: "2",
      });
      expect(operation).toMatchObject({
        type: "operation",
        actionIndex: 1,
        descriptor: { kind: "effect", name: "echo", input: "hello" },
      });
      const completed = yield* driver.step(attachment, {
        type: "resume",
        actionIndex: 1,
        outcome: { status: "ok", value: "world" },
        receipt: {
          sessionId: "session-1",
          taskId: "turn-0/root",
          pullId: "pull",
          resolutionOffset: "4",
          outcomeDigest: "digest",
          status: "accepted",
        },
        replayed: false,
      });
      expect(completed).toEqual({ type: "completed", actionIndex: 2, value: "world" });
      yield* driver.shutdown(attachment, "completed");
    });

    expect(() =>
      createDurableTool({ ...manifest, digest: "not-a-digest" }, function* () {
        return "bad";
      }),
    ).toThrow(/digest/);
  });

  it("reserves before dispatch and resolves processlessly with audience-bound idempotent receipts", async () => {
    const { authority, attach } = createAuthority();
    await run(function* () {
      const opened = yield* authority.openTask({
        sessionId: attach.sessionId,
        turnId: "turn-0",
        taskId: attach.taskId,
        manifest,
        input: attach.input,
        executionEpoch: attach.executionEpoch,
        attachmentId: stableProgramAttachmentId(attach),
        audience: "program-host",
      });
      const reserved = yield* authority.reserve({
        sessionId: attach.sessionId,
        turnId: "turn-0",
        taskId: attach.taskId,
        actionIndex: 0,
        pullIndex: 0,
        descriptor: {
          kind: "effect",
          name: "echo",
          version: "1",
          input: "hello",
          resolver: { audience: "host-effects" },
        },
        programCapability: opened.programCapability,
      });
      expect(reserved.status).toBe("authorized");
      if (reserved.status !== "authorized") return;
      expect(authority.readJournal(attach.sessionId).map((record) => record.payload.type)).toEqual([
        "TaskOpened",
        "PullRequested",
        "AttemptStarted",
      ]);
      expect(
        yield* authority.resolve({
          capability: reserved.resolutionCapability,
          audience: "wrong",
          outcome: { status: "ok", value: "hello" },
        }),
      ).toEqual({ status: "rejected", code: "wrong_audience" });
      const accepted = yield* authority.resolve({
        capability: reserved.resolutionCapability,
        audience: "host-effects",
        outcome: { status: "ok", value: "hello" },
      });
      expect(accepted.status).toBe("accepted");
      const duplicate = yield* authority.resolve({
        capability: reserved.resolutionCapability,
        audience: "host-effects",
        outcome: { status: "ok", value: "hello" },
      });
      expect(duplicate).toMatchObject({ status: "duplicate", receipt: { status: "duplicate" } });
      expect(
        yield* authority.resolve({
          capability: reserved.resolutionCapability,
          audience: "host-effects",
          outcome: { status: "ok", value: "different" },
        }),
      ).toEqual({ status: "rejected", code: "resolution_conflict" });
      expect(authority.runnableSessions()).toEqual([attach.sessionId]);

      const replay = yield* authority.reserve({
        sessionId: attach.sessionId,
        turnId: "turn-0",
        taskId: attach.taskId,
        actionIndex: 0,
        pullIndex: 0,
        descriptor: {
          kind: "effect",
          name: "echo",
          version: "1",
          input: "hello",
          resolver: { audience: "host-effects" },
        },
        programCapability: opened.programCapability,
      });
      expect(replay).toMatchObject({
        status: "resolved",
        outcome: { status: "ok", value: "hello" },
      });
    });
  });

  it("rehydrates authority snapshots without losing pull capability or runnable state", async () => {
    const { authority, attach } = createAuthority("snapshot");
    await run(function* () {
      const opened = yield* authority.openTask({
        sessionId: attach.sessionId,
        turnId: "turn-0",
        taskId: attach.taskId,
        manifest,
        input: attach.input,
        executionEpoch: 1,
        attachmentId: stableProgramAttachmentId(attach),
        audience: "program-host",
      });
      const reserved = yield* authority.reserve({
        sessionId: attach.sessionId,
        turnId: "turn-0",
        taskId: attach.taskId,
        actionIndex: 0,
        pullIndex: 0,
        descriptor: {
          kind: "effect",
          name: "echo",
          version: "1",
          input: "hello",
          resolver: { audience: "host-effects" },
        },
        programCapability: opened.programCapability,
      });
      if (reserved.status !== "authorized") throw new Error("not authorized");
      const recovered = createInMemoryDurableJournalAuthority({
        journalId: "journal-1",
        journalIncarnation: "incarnation-1",
        keyring,
        now: () => 1_000,
        snapshot: authority.exportSnapshot(),
      });
      expect(
        yield* recovered.resolve({
          capability: reserved.resolutionCapability,
          audience: "host-effects",
          outcome: { status: "ok", value: "hello" },
        }),
      ).toMatchObject({ status: "accepted" });
      expect(recovered.runnableSessions()).toEqual(["snapshot"]);
    });
  });

  it("keeps detached attempt capabilities valid, fences old program authority, and parks unsafe ambiguity", async () => {
    const { authority, attach } = createAuthority("takeover");
    await run(function* () {
      const opened = yield* authority.openTask({
        sessionId: attach.sessionId,
        turnId: "turn-0",
        taskId: attach.taskId,
        manifest,
        input: attach.input,
        executionEpoch: 1,
        attachmentId: stableProgramAttachmentId(attach),
        audience: "program-host",
      });
      const first = yield* authority.reserve({
        sessionId: attach.sessionId,
        turnId: "turn-0",
        taskId: attach.taskId,
        actionIndex: 0,
        pullIndex: 0,
        descriptor: {
          kind: "effect",
          name: "mutate",
          version: "1",
          input: null,
          resolver: { audience: "mutator" },
        },
        programCapability: opened.programCapability,
      });
      if (first.status !== "authorized") throw new Error("not authorized");
      const replacement = yield* authority.replaceAttachment(
        attach.sessionId,
        attach.taskId,
        "replacement",
      );
      expect(() =>
        authority
          .reserve({
            sessionId: attach.sessionId,
            turnId: "turn-0",
            taskId: attach.taskId,
            actionIndex: 0,
            pullIndex: 0,
            descriptor: {
              kind: "effect",
              name: "mutate",
              version: "1",
              input: null,
              resolver: { audience: "mutator" },
            },
            programCapability: opened.programCapability,
          })
          .next(),
      ).toThrow(/stale_program_capability/);
      const parked = yield* authority.reserve({
        sessionId: attach.sessionId,
        turnId: "turn-0",
        taskId: attach.taskId,
        actionIndex: 0,
        pullIndex: 0,
        descriptor: {
          kind: "effect",
          name: "mutate",
          version: "1",
          input: null,
          resolver: { audience: "mutator" },
        },
        programCapability: replacement.programCapability,
      });
      expect(parked).toMatchObject({ status: "pending", reason: "indeterminate" });
      expect(
        yield* authority.resolve({
          capability: first.resolutionCapability,
          audience: "mutator",
          outcome: { status: "ok", value: { committed: true } },
        }),
      ).toMatchObject({ status: "accepted" });
    });
  });

  it("persists relative wait deadlines once and rejects early scheduler resolution", async () => {
    let now = 10_000;
    const { authority, attach } = createAuthority("wait", () => now);
    await run(function* () {
      const opened = yield* authority.openTask({
        sessionId: attach.sessionId,
        turnId: "turn-0",
        taskId: attach.taskId,
        manifest,
        input: attach.input,
        executionEpoch: 1,
        attachmentId: stableProgramAttachmentId(attach),
        audience: "program-host",
      });
      const pending = yield* authority.reserve({
        sessionId: attach.sessionId,
        turnId: "turn-0",
        taskId: attach.taskId,
        actionIndex: 0,
        pullIndex: 0,
        descriptor: { kind: "wait", key: "delay", durationMs: 500 },
        programCapability: opened.programCapability,
      });
      if (pending.status !== "pending") throw new Error("wait did not park");
      const capability = authority.resolutionCapability(
        attach.sessionId,
        attach.taskId,
        pending.pullId,
      );
      expect(
        yield* authority.resolve({
          capability,
          audience: "scheduler",
          outcome: { status: "ok", value: null },
        }),
      ).toEqual({ status: "rejected", code: "wait_not_due" });
      now = 10_500;
      expect(
        yield* authority.resolve({
          capability,
          audience: "scheduler",
          outcome: { status: "ok", value: null },
        }),
      ).toMatchObject({ status: "accepted" });
      const request = authority
        .readJournal(attach.sessionId)
        .find((record) => record.payload.type === "PullRequested");
      expect(request?.payload).toMatchObject({
        descriptor: { durationMs: 500, notBefore: new Date(10_500).toISOString() },
      });
    });
  });

  it("uses native createApi max/min middleware and runs host effects through durable receipt gating", async () => {
    const tool = createDurableTool(manifest, function* (input, context) {
      yield* context.emit("progress", { stage: "before" });
      return yield* context.effect<string>("echo", "1", input, { audience: "host-effects" });
    });
    const tools = createDurableToolRegistry([tool]);
    const drivers = createProgramDriverRegistry([["generator", createLocalGeneratorDriver(tools)]]);
    const effects = createDurableEffectRegistry([
      {
        definition: manifest.effects.echo!,
        satisfies: { mode: "idempotent", mechanism: "pull_id_key" },
        handler: (input): Operation<Json> =>
          (function* () {
            return input;
          })(),
      },
    ]);
    const { authority, attach } = createAuthority("runtime");
    const order: string[] = [];

    await run(function* () {
      yield* authority.openTask({
        sessionId: attach.sessionId,
        turnId: "turn-0",
        taskId: attach.taskId,
        manifest,
        input: attach.input,
        executionEpoch: 1,
        attachmentId: stableProgramAttachmentId(attach),
        audience: "program-host",
      });
      yield* ProgramPeer.around(
        {
          *step(args, next) {
            order.push("max-enter");
            const value = yield* next(...args);
            order.push("max-exit");
            return value;
          },
        },
        { at: "max" },
      );
      yield* ProgramPeer.around(
        {
          *step(args, next) {
            order.push("min-enter");
            const value = yield* next(...args);
            order.push("min-exit");
            return value;
          },
        },
        { at: "min" },
      );
      const result = yield* ProgramDriverRegistryContext.with(drivers, function* () {
        return yield* JournalAuthorityContext.with(authority, function* () {
          return yield* DurableEffectRegistryContext.with(effects, function* () {
            return yield* ProgramRuntime.operations.run({
              attach,
              executeHostEffects: true,
            });
          });
        });
      });
      expect(result).toEqual({ state: "completed", value: "hello" });
      expect(authority.readJournal(attach.sessionId).map((record) => record.payload.type)).toEqual([
        "TaskOpened",
        "DurableEmission",
        "PullRequested",
        "AttemptStarted",
        "PullResolved",
        "TaskClosed",
      ]);
    });

    expect(order.slice(0, 4)).toEqual(["max-enter", "min-enter", "min-exit", "max-exit"]);
  });
});
