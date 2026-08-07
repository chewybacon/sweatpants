import {
  ExecutionDurableEffectRegistryContext,
  ProgramDriverRegistryContext,
  createProgramDriverRegistry,
} from "@sweatpants/durable-execution";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { call, run, type Operation } from "effection";
import { createApi } from "effection/experimental";
import { describe, expect, it } from "vitest";

import { DurableEffectRouting } from "@sweatpants/durable-effects/runtime";
import { CrankError } from "@sweatpants/durable-execution";
import {
  withJournalAuthority,
  createCapabilityKeyring,
  createInMemoryDurableJournalAuthority,
  durableAuthoritySnapshotParser,
  parseDurableAuthoritySnapshot,
  signCapability,
} from "../index.ts";
import { type Json } from "@sweatpants/foundation";
import {
  createPinnedDurableProgram,
  createDurableToolRegistry,
  createLocalProgramDriver,
  stableProgramAttachmentId,
  type AttachProgramRequest,
  type DurableProgramManifest,
} from "@sweatpants/durable-execution";
import { ProgramPeer, ProgramRuntime } from "@sweatpants/durable-execution";
import {
  DurableEffectRegistryContext,
  createDurableEffectRegistry,
} from "@sweatpants/durable-effects/runtime";
import { createDurableSchemaRegistry } from "@sweatpants/journal-authority/schema-registry";
import {
  anyGuard,
  booleanGuard,
  createSchemaFixture,
  stringGuard,
} from "@sweatpants/journal-authority/testing";

const programInput = createSchemaFixture(
  "fixture.basic/input",
  "program_input",
  { type: "string" },
  stringGuard,
);
const programOutput = createSchemaFixture(
  "fixture.basic/output",
  "program_output",
  { type: "string" },
  stringGuard,
);
const approvalResponse = createSchemaFixture(
  "fixture.basic/approval-response",
  "elicit_response",
  { type: "boolean" },
  booleanGuard,
);
const echoInput = createSchemaFixture(
  "fixture.basic/echo-input",
  "effect_input",
  { type: "string" },
  stringGuard,
);
const echoOutput = createSchemaFixture(
  "fixture.basic/echo-output",
  "effect_output",
  { type: "string" },
  stringGuard,
);
const mutateInput = createSchemaFixture(
  "fixture.basic/mutate-input",
  "effect_input",
  true,
  anyGuard,
);
const mutateOutput = createSchemaFixture(
  "fixture.basic/mutate-output",
  "effect_output",
  true,
  anyGuard,
);
const fixtureSchemaRegistry = () =>
  createDurableSchemaRegistry([
    programInput.entry,
    programOutput.entry,
    approvalResponse.entry,
    echoInput.entry,
    echoOutput.entry,
    mutateInput.entry,
    mutateOutput.entry,
  ]);

const digest = "a".repeat(64);
const manifest: DurableProgramManifest = {
  programId: "fixture.basic",
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
      version: "1",
      inputSchema: echoInput.descriptor,
      outputSchema: echoOutput.descriptor,
      retrySafety: { mode: "idempotent", mechanism: "pull_id_key" },
    },
    mutate: {
      name: "mutate",
      version: "1",
      inputSchema: mutateInput.descriptor,
      outputSchema: mutateOutput.descriptor,
      retrySafety: { mode: "unsafe" },
    },
  },
  capabilities: { durableEmissions: true, structuredChildren: true, replay: "strict" },
};

const OrdinaryFiles = createApi<{
  read(path: string): Operation<string>;
}>("ordinary-files-fixture", {
  *read() {
    throw new Error("Ordinary file provider is not installed");
  },
});

const keyring = createCapabilityKeyring("test-issuer", [
  { keyId: "key-1", secret: "x".repeat(32) },
]);

function captureError(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error("Expected action to fail");
}

describe("persisted boundary parsing", () => {
  it("rejects pre-v4 snapshots instead of converting them", () => {
    const snapshot = createInMemoryDurableJournalAuthority({
      journalId: "current-format-only",
      keyring,
    }).exportSnapshot();
    expect(durableAuthoritySnapshotParser.parse(snapshot)).toEqual({
      ok: true,
      value: snapshot,
    });
    expect(durableAuthoritySnapshotParser.parse({ ...snapshot, unknown: true }).ok).toBe(false);
    for (const version of [2, 3]) {
      expect(() => parseDurableAuthoritySnapshot(JSON.stringify({ ...snapshot, version }))).toThrow(
        "Invalid durable authority snapshot",
      );
    }
  });

  it("rejects malformed nested authority collections", () => {
    expect(() =>
      parseDurableAuthoritySnapshot(
        JSON.stringify({ version: 1, tasks: [null], records: [], runnable: [], nonce: 0 }),
      ),
    ).toThrow("Invalid durable authority snapshot");
    expect(() =>
      parseDurableAuthoritySnapshot(
        JSON.stringify({
          version: 1,
          tasks: [],
          records: [["session-1", [null]]],
          runnable: [],
          nonce: 0,
        }),
      ),
    ).toThrow("Invalid durable authority snapshot");
    expect(() =>
      parseDurableAuthoritySnapshot(
        JSON.stringify({
          version: 1,
          tasks: [],
          records: [
            [
              "session-1",
              [
                {
                  offset: "1",
                  eventId: "event-1",
                  sessionId: "session-1",
                  payload: { type: "FutureRecord", taskId: "task-1" },
                },
              ],
            ],
          ],
          runnable: [],
          nonce: 0,
        }),
      ),
    ).toThrow("Invalid durable authority snapshot");
  });
});

describe("capability boundary parsing", () => {
  it("does not expose signing secrets through the keyring value", () => {
    expect(Object.keys(keyring)).toEqual(["issuer", "activeKeyId"]);
    expect(JSON.stringify(keyring)).not.toContain("xxxxxxxx");
  });

  it("rejects structurally valid claims with unrecognized fields", () => {
    const permissions: ["propose", "complete"] = ["propose", "complete"];
    const claims = {
      journalId: "journal-1",
      journalIncarnation: "incarnation-1",
      sessionId: "session-1",
      taskId: "turn-0/root",
      programId: manifest.programId,
      programVersion: manifest.version,
      programDigest: manifest.digest,
      attachmentId: "attachment-1",
      executionEpoch: 1,
      audience: "program-runtime",
      permissions,
      nonce: "nonce-1",
      unexpected: "must-not-cross-boundary",
    };

    const error = captureError(() => signCapability(claims, keyring));
    expect(error).toBeInstanceOf(CrankError);
    expect(error).toMatchObject({
      _tag: "CrankError",
      code: "invalid_resolution_capability",
    });
  });
});

function attachRequest(sessionId = "session-1"): AttachProgramRequest {
  return {
    sessionId,
    taskId: "turn-0/root",
    program: { id: manifest.programId, version: manifest.version, digest: manifest.digest },
    input: "hello",
    route: { driverKind: "program" },
    executionEpoch: 1,
  };
}

function createAuthority(sessionId = "session-1", now: () => number = () => 1_000) {
  const authority = createInMemoryDurableJournalAuthority({
    journalId: "journal-1",
    journalIncarnation: "incarnation-1",
    keyring,
    now,
    schemaRegistry: fixtureSchemaRegistry(),
  });
  const attach = attachRequest(sessionId);
  return { authority, attach };
}

describe("crank-native durable runtime", () => {
  it("rejects noncanonical and oversized terminal values before driver transport", async () => {
    const terminalManifest: DurableProgramManifest = {
      ...manifest,
      programId: "fixture.terminal-bounds",
      digest: "b".repeat(64),
      outputSchema: createSchemaFixture(
        "fixture.terminal-bounds/output",
        "program_output",
        true,
        anyGuard,
      ).descriptor,
    };
    const runTerminal = async (value: unknown) => {
      const tool = createPinnedDurableProgram(terminalManifest, function* () {
        return value as Json;
      });
      const driver = createLocalProgramDriver(createDurableToolRegistry([tool]));
      return await run(function* () {
        const attachment = yield* driver.attach({
          ...attachRequest("terminal-bounds"),
          program: {
            id: terminalManifest.programId,
            version: terminalManifest.version,
            digest: terminalManifest.digest,
          },
        });
        const step = yield* driver.step(attachment, { type: "start", input: "hello" });
        yield* driver.shutdown(attachment, "failed");
        return step;
      });
    };

    await expect(runTerminal(() => undefined)).resolves.toMatchObject({
      type: "failed",
      error: { code: "schema_validation_failed" },
    });
    await expect(runTerminal("x".repeat(1024 * 1024 + 1))).resolves.toMatchObject({
      type: "failed",
      error: { code: "payload_too_large" },
    });
  });

  it("validates manifests and drives a disposable local program task with ordered actions", async () => {
    const tool = createPinnedDurableProgram(manifest, function* (input, context) {
      yield* context.emit("progress", { input });
      return yield* context.effect<string>("echo", "1", input, { audience: "host-effects" });
    });
    const registry = createDurableToolRegistry([tool]);
    const driver = createLocalProgramDriver(registry);

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
      createPinnedDurableProgram({ ...manifest, digest: "not-a-digest" }, function* () {
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
      if (reserved.status !== "authorized") {
        return;
      }
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
      if (reserved.status !== "authorized") {
        throw new Error("not authorized");
      }
      const recovered = createInMemoryDurableJournalAuthority({
        journalId: "journal-1",
        journalIncarnation: "incarnation-1",
        keyring,
        now: () => 1_000,
        snapshot: parseDurableAuthoritySnapshot(JSON.stringify(authority.exportSnapshot())),
        schemaRegistry: fixtureSchemaRegistry(),
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

  it("fences old program authority and settles a detached unsafe attempt as indeterminate", async () => {
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
      if (first.status !== "authorized") {
        throw new Error("not authorized");
      }
      const replacement = yield* authority.replaceAttachment(
        attach.sessionId,
        attach.taskId,
        "replacement",
      );
      // The guard rejects before the operation suspends, so stepping the
      // iterator once is enough to observe it.
      const staleReserve = (): IteratorResult<unknown> => {
        const operation = authority.reserve({
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
        return operation[Symbol.iterator]().next();
      };
      expect(staleReserve).toThrow(/stale_program_capability/);
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
      expect(parked).toMatchObject({
        status: "resolved",
        outcome: { status: "error", error: { code: "effect_outcome_indeterminate" } },
      });
      expect(
        yield* authority.resolve({
          capability: first.resolutionCapability,
          audience: "mutator",
          outcome: { status: "ok", value: { committed: true } },
        }),
      ).toMatchObject({ status: "rejected", code: "capability_revoked" });
    });
  });

  it("retries a detached repeatable recording with one pull and distinct attempts", async () => {
    const { authority, attach } = createAuthority("repeatable-record");
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
      const descriptor = {
        kind: "record" as const,
        key: "random-value",
        retrySafety: { mode: "repeatable" as const },
      };
      const first = yield* authority.reserve({
        sessionId: attach.sessionId,
        turnId: "turn-0",
        taskId: attach.taskId,
        actionIndex: 0,
        pullIndex: 0,
        descriptor,
        programCapability: opened.programCapability,
      });
      if (first.status !== "authorized") {
        throw new Error("first recording was not authorized");
      }
      const replacement = yield* authority.replaceAttachment(
        attach.sessionId,
        attach.taskId,
        "repeatable-replacement",
      );
      const second = yield* authority.reserve({
        sessionId: attach.sessionId,
        turnId: "turn-0",
        taskId: attach.taskId,
        actionIndex: 0,
        pullIndex: 0,
        descriptor,
        programCapability: replacement.programCapability,
      });
      if (second.status !== "authorized") {
        throw new Error("retry was not authorized");
      }
      expect(second.pullId).toBe(first.pullId);
      expect(second.attemptId).not.toBe(first.attemptId);
      expect(
        yield* authority.resolve({
          capability: second.resolutionCapability,
          audience: "program-execution",
          outcome: { status: "ok", value: "second-value" },
        }),
      ).toMatchObject({ status: "accepted" });
      expect(
        yield* authority.resolve({
          capability: first.resolutionCapability,
          audience: "program-execution",
          outcome: { status: "ok", value: "first-value" },
        }),
      ).toMatchObject({ status: "rejected" });
      const replayed = yield* authority.reserve({
        sessionId: attach.sessionId,
        turnId: "turn-0",
        taskId: attach.taskId,
        actionIndex: 0,
        pullIndex: 0,
        descriptor,
        programCapability: replacement.programCapability,
      });
      expect(replayed).toMatchObject({
        status: "resolved",
        outcome: { status: "ok", value: "second-value" },
      });
    });
  });

  it("fails a detached unsafe recording without retrying", async () => {
    const { authority, attach } = createAuthority("unsafe-record");
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
      const descriptor = {
        kind: "record" as const,
        key: "unsafe-send",
        retrySafety: { mode: "unsafe" as const },
      };
      const first = yield* authority.reserve({
        sessionId: attach.sessionId,
        turnId: "turn-0",
        taskId: attach.taskId,
        actionIndex: 0,
        pullIndex: 0,
        descriptor,
        programCapability: opened.programCapability,
      });
      expect(first.status).toBe("authorized");
      const replacement = yield* authority.replaceAttachment(
        attach.sessionId,
        attach.taskId,
        "unsafe-replacement",
      );
      const replayed = yield* authority.reserve({
        sessionId: attach.sessionId,
        turnId: "turn-0",
        taskId: attach.taskId,
        actionIndex: 0,
        pullIndex: 0,
        descriptor,
        programCapability: replacement.programCapability,
      });
      expect(replayed).toMatchObject({
        status: "resolved",
        outcome: { status: "error", error: { code: "effect_outcome_indeterminate" } },
      });
      expect(
        authority
          .readJournal(attach.sessionId)
          .filter((record) => record.payload.type === "AttemptStarted"),
      ).toHaveLength(1);
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
      if (pending.status !== "pending") {
        throw new Error("wait did not park");
      }
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

  it("keeps payload commands pending when a retained validator bundle is unavailable", async () => {
    const { authority, attach } = createAuthority("missing-schema");
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
      if (reserved.status !== "authorized") {
        throw new Error("effect not authorized");
      }
      const unavailable = createInMemoryDurableJournalAuthority({
        journalId: "journal-1",
        journalIncarnation: "incarnation-1",
        keyring,
        snapshot: authority.exportSnapshot(),
      });
      expect(
        yield* unavailable.resolve({
          capability: reserved.resolutionCapability,
          audience: "host-effects",
          outcome: { status: "ok", value: "hello" },
        }),
      ).toEqual({ status: "rejected", code: "schema_version_unavailable" });
      expect(
        unavailable
          .readJournal(attach.sessionId)
          .some((record) => record.payload.type === "PullResolved"),
      ).toBe(false);
      expect(yield* unavailable.nonterminalSchemaDigests()).toContain(
        manifest.effects["echo"]?.outputSchema.digest,
      );
      // Cancellation without a payload schema remains available.
      expect(
        yield* unavailable.requestCancellation(
          attach.sessionId,
          attach.taskId,
          "bundle missing",
          "cancel-missing-schema",
        ),
      ).toMatchObject({ accepted: true });
    });
  });

  it("reruns ordinary Effection file reads while replaying explicit recordings", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sweatpants-ordinary-replay-"));
    const file = join(directory, "value.txt");
    await writeFile(file, "ordinary-1", "utf8");
    let ordinaryReads = 0;
    let recordedReads = 0;
    const tool = createPinnedDurableProgram(manifest, function* (_input, context) {
      const ordinary = yield* OrdinaryFiles.operations.read(file);
      const recorded = yield* context.record({ key: "stable-read" }, function* () {
        recordedReads += 1;
        return `recorded-${recordedReads}`;
      });
      const approval = yield* context.elicit<boolean>(
        "approval",
        "Continue?",
        approvalResponse.descriptor,
      );
      return `${ordinary}:${recorded}:${approval.action}`;
    });
    const tools = createDurableToolRegistry([tool]);
    const drivers = createProgramDriverRegistry([["program", createLocalProgramDriver(tools)]]);
    const { authority, attach } = createAuthority("ordinary-operation-replay");

    await run(function* () {
      yield* OrdinaryFiles.around({
        *read([path]) {
          ordinaryReads += 1;
          return yield* call(() => readFile(path, "utf8"));
        },
      });
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
      const activate = function* () {
        return yield* ProgramDriverRegistryContext.with(drivers, function* () {
          return yield* withJournalAuthority(authority, function* () {
            return yield* DurableEffectRegistryContext.with(
              createDurableEffectRegistry([]),
              function* () {
                return yield* ProgramRuntime.operations.run({ attach, executeHostEffects: true });
              },
            );
          });
        });
      };
      expect(yield* activate()).toMatchObject({ state: "parked", reason: "elicit" });
      yield* call(() => writeFile(file, "ordinary-2", "utf8"));
      const pending = authority
        .readJournal(attach.sessionId)
        .find(
          (record) =>
            record.payload.type === "PullRequested" && record.payload.descriptor.kind === "elicit",
        );
      if (!pending || pending.payload.type !== "PullRequested") {
        throw new Error("elicitation was not recorded");
      }
      const capability = authority.resolutionCapability(
        attach.sessionId,
        attach.taskId,
        pending.payload.pullId,
      );
      expect(
        yield* authority.resolve({
          capability,
          audience: "user:approval",
          outcome: { status: "ok", value: { action: "accept", content: true } },
        }),
      ).toMatchObject({ status: "accepted" });
      expect(yield* activate()).toEqual({
        state: "completed",
        value: "ordinary-2:recorded-1:accept",
      });
    });

    expect(ordinaryReads).toBe(2);
    expect(recordedReads).toBe(1);
    await rm(directory, { recursive: true, force: true });
  });

  it("fences a changed replay descriptor without rewriting accepted history", async () => {
    let label = "stable-a";
    const tool = createPinnedDurableProgram(manifest, function* (_input, context) {
      yield* context.record({ key: label }, function* () {
        return "accepted";
      });
      yield* context.elicit<boolean>("approval", "Continue?", approvalResponse.descriptor);
      return "done";
    });
    const tools = createDurableToolRegistry([tool]);
    const drivers = createProgramDriverRegistry([["program", createLocalProgramDriver(tools)]]);
    const { authority, attach } = createAuthority("descriptor-divergence");

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
      const activate = function* () {
        return yield* ProgramDriverRegistryContext.with(drivers, function* () {
          return yield* withJournalAuthority(authority, function* () {
            return yield* DurableEffectRegistryContext.with(
              createDurableEffectRegistry([]),
              function* () {
                return yield* ProgramRuntime.operations.run({ attach, executeHostEffects: true });
              },
            );
          });
        });
      };
      expect(yield* activate()).toMatchObject({ state: "parked", reason: "elicit" });
      const accepted = authority
        .readJournal(attach.sessionId)
        .map((record) => structuredClone(record));
      label = "changed-b";
      let caught: unknown;
      try {
        yield* activate();
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({ code: "nondeterminism_detected" });
      const after = authority.readJournal(attach.sessionId);
      expect(after.slice(0, accepted.length)).toEqual(accepted);
      expect(after.at(-1)?.payload).toMatchObject({
        type: "TaskOrphaned",
        reason: "replay_diverged",
      });
    });
  });

  it("does not rerun a completed child tool while reconstructing its parent", async () => {
    let childRuns = 0;
    const childManifest: DurableProgramManifest = {
      ...manifest,
      programId: "fixture.ordinary-child",
      digest: "b".repeat(64),
      elicits: {},
      effects: {},
    };
    const parentManifest: DurableProgramManifest = {
      ...manifest,
      programId: "fixture.ordinary-parent",
      digest: "c".repeat(64),
      effects: {},
    };
    const child = createPinnedDurableProgram(childManifest, function* () {
      childRuns += 1;
      return yield* (function* () {
        return `child-${childRuns}`;
      })();
    });
    const parent = createPinnedDurableProgram(parentManifest, function* (_input, context) {
      const value = yield* context.invoke<string>({
        id: childManifest.programId,
        version: childManifest.version,
        digest: childManifest.digest,
        input: "child",
      });
      yield* context.elicit<boolean>("approval", "Continue?", approvalResponse.descriptor);
      return value;
    });
    const tools = createDurableToolRegistry([parent, child]);
    const drivers = createProgramDriverRegistry([["program", createLocalProgramDriver(tools)]]);
    const authority = createInMemoryDurableJournalAuthority({
      journalId: "ordinary-child-journal",
      journalIncarnation: "ordinary-child-incarnation",
      keyring,
      schemaRegistry: fixtureSchemaRegistry(),
    });
    const attach = {
      sessionId: "ordinary-child-session",
      taskId: "turn-0/root",
      program: {
        id: parentManifest.programId,
        version: parentManifest.version,
        digest: parentManifest.digest,
      },
      input: "hello",
      route: { driverKind: "program" },
      executionEpoch: 1,
    };

    await run(function* () {
      yield* authority.openTask({
        sessionId: attach.sessionId,
        turnId: "turn-0",
        taskId: attach.taskId,
        manifest: parentManifest,
        input: attach.input,
        executionEpoch: 1,
        attachmentId: stableProgramAttachmentId(attach),
        audience: "program-host",
      });
      const activate = function* () {
        return yield* ProgramDriverRegistryContext.with(drivers, function* () {
          return yield* withJournalAuthority(authority, function* () {
            return yield* DurableEffectRegistryContext.with(
              createDurableEffectRegistry([]),
              function* () {
                return yield* ProgramRuntime.operations.run({ attach, executeHostEffects: true });
              },
            );
          });
        });
      };
      expect(yield* activate()).toMatchObject({ state: "parked", reason: "elicit" });
      const pending = authority
        .readJournal(attach.sessionId)
        .find(
          (record) =>
            record.payload.type === "PullRequested" &&
            record.payload.taskId === attach.taskId &&
            record.payload.descriptor.kind === "elicit",
        );
      if (!pending || pending.payload.type !== "PullRequested") {
        throw new Error("parent elicitation was not recorded");
      }
      expect(
        yield* authority.resolve({
          capability: authority.resolutionCapability(
            attach.sessionId,
            attach.taskId,
            pending.payload.pullId,
          ),
          audience: "user:approval",
          outcome: { status: "ok", value: { action: "accept", content: true } },
        }),
      ).toMatchObject({ status: "accepted" });
      expect(yield* activate()).toEqual({ state: "completed", value: "child-1" });
    });
    expect(childRuns).toBe(1);
  });

  it("fails safely when an ordinary operation is unavailable during reconstruction", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sweatpants-missing-replay-"));
    const file = join(directory, "value.txt");
    await writeFile(file, "original-file", "utf8");
    const tool = createPinnedDurableProgram(manifest, function* (_input, context) {
      const contents = yield* (function* () {
        try {
          return yield* call(() => readFile(file, "utf8"));
        } catch (error) {
          throw new CrankError(
            "workspace_file_missing",
            "The replayed file is unavailable",
            undefined,
            { cause: error },
          );
        }
      })();
      yield* context.record({ key: "checkpoint" }, function* () {
        return "recorded";
      });
      yield* context.elicit<boolean>("approval", "Continue?", approvalResponse.descriptor);
      return contents;
    });
    const tools = createDurableToolRegistry([tool]);
    const drivers = createProgramDriverRegistry([["program", createLocalProgramDriver(tools)]]);
    const { authority, attach } = createAuthority("ordinary-operation-failure");

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
      const activate = function* () {
        return yield* ProgramDriverRegistryContext.with(drivers, function* () {
          return yield* withJournalAuthority(authority, function* () {
            return yield* DurableEffectRegistryContext.with(
              createDurableEffectRegistry([]),
              function* () {
                return yield* ProgramRuntime.operations.run({ attach, executeHostEffects: true });
              },
            );
          });
        });
      };
      expect(yield* activate()).toMatchObject({ state: "parked", reason: "elicit" });
      yield* call(() => rm(file));
      const replayed = yield* activate();
      expect(replayed).toMatchObject({
        state: "failed",
        error: { code: "workspace_file_missing" },
      });
      expect(authority.readJournal(attach.sessionId).at(-1)?.payload).toMatchObject({
        type: "TaskOrphaned",
        reason: "replay_execution_failed",
      });
    });
    await rm(directory, { recursive: true, force: true });
  });

  it("routes an installed effect to execution through scoped middleware", async () => {
    let executions = 0;
    const tool = createPinnedDurableProgram(manifest, function* (input, context) {
      return yield* context.effect<string>("echo", "1", input, { audience: "host-effects" });
    });
    const tools = createDurableToolRegistry([tool]);
    const drivers = createProgramDriverRegistry([["program", createLocalProgramDriver(tools)]]);
    const effects = createDurableEffectRegistry([
      {
        definition: manifest.effects["echo"]!,
        satisfies: { mode: "idempotent", mechanism: "pull_id_key" },
        handler: (input) =>
          (function* () {
            executions += 1;
            return { status: "ok" as const, value: `${input}:execution` };
          })(),
      },
    ]);
    const { authority, attach } = createAuthority("execution-route");

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
      yield* DurableEffectRouting.around({
        *route() {
          return { placement: "execution" as const };
        },
      });
      const result = yield* ProgramDriverRegistryContext.with(drivers, function* () {
        return yield* withJournalAuthority(authority, function* () {
          return yield* DurableEffectRegistryContext.with(effects, function* () {
            return yield* ExecutionDurableEffectRegistryContext.with(effects, function* () {
              return yield* ProgramRuntime.operations.run({ attach, executeHostEffects: true });
            });
          });
        });
      });
      expect(result).toEqual({ state: "completed", value: "hello:execution" });
    });
    expect(executions).toBe(1);
  });

  it("fails closed when execution placement has no implementation", async () => {
    let hostExecutions = 0;
    const tool = createPinnedDurableProgram(manifest, function* (input, context) {
      return yield* context.effect<string>("echo", "1", input, { audience: "host-effects" });
    });
    const tools = createDurableToolRegistry([tool]);
    const drivers = createProgramDriverRegistry([["program", createLocalProgramDriver(tools)]]);
    const hostEffects = createDurableEffectRegistry([
      {
        definition: manifest.effects["echo"]!,
        satisfies: { mode: "idempotent", mechanism: "pull_id_key" },
        handler: (input) =>
          (function* () {
            hostExecutions += 1;
            return { status: "ok" as const, value: input };
          })(),
      },
    ]);
    const { authority, attach } = createAuthority("missing-execution-route");

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
      yield* DurableEffectRouting.around({
        *route() {
          return { placement: "execution" as const };
        },
      });
      const result = yield* ProgramDriverRegistryContext.with(drivers, function* () {
        return yield* withJournalAuthority(authority, function* () {
          return yield* DurableEffectRegistryContext.with(hostEffects, function* () {
            return yield* ExecutionDurableEffectRegistryContext.with(
              createDurableEffectRegistry([]),
              function* () {
                return yield* ProgramRuntime.operations.run({ attach, executeHostEffects: true });
              },
            );
          });
        });
      });
      expect(result).toMatchObject({
        state: "failed",
        error: { code: "effect_placement_unavailable" },
      });
    });
    expect(hostExecutions).toBe(0);
  });

  it("authorizes and records one execution-owned repeatable operation", async () => {
    let executions = 0;
    const tool = createPinnedDurableProgram(manifest, function* (_input, context) {
      return yield* context.record({ key: "draw-card" }, function* () {
        executions += 1;
        return "ace-of-spades";
      });
    });
    const tools = createDurableToolRegistry([tool]);
    const drivers = createProgramDriverRegistry([["program", createLocalProgramDriver(tools)]]);
    const { authority, attach } = createAuthority("record-runtime");

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
      const result = yield* ProgramDriverRegistryContext.with(drivers, function* () {
        return yield* withJournalAuthority(authority, function* () {
          return yield* DurableEffectRegistryContext.with(
            createDurableEffectRegistry([]),
            function* () {
              return yield* ProgramRuntime.operations.run({ attach, executeHostEffects: true });
            },
          );
        });
      });
      expect(result).toEqual({ state: "completed", value: "ace-of-spades" });
    });

    expect(executions).toBe(1);
    expect(authority.readJournal(attach.sessionId).map((record) => record.payload.type)).toEqual([
      "TaskOpened",
      "PullRequested",
      "AttemptStarted",
      "PullResolved",
      "TaskClosed",
    ]);
    expect(
      authority
        .readJournal(attach.sessionId)
        .find((record) => record.payload.type === "PullRequested"),
    ).toMatchObject({
      payload: {
        descriptor: {
          kind: "record",
          key: "draw-card",
          retrySafety: { mode: "repeatable" },
        },
      },
    });
  });

  it("records an oversized inline value as a typed replayable failure", async () => {
    const tool = createPinnedDurableProgram(manifest, function* (_input, context) {
      return yield* context.record({ key: "unlabeled-record" }, function* () {
        return "x".repeat(1024 * 1024 + 1);
      });
    });
    const tools = createDurableToolRegistry([tool]);
    const drivers = createProgramDriverRegistry([["program", createLocalProgramDriver(tools)]]);
    const { authority, attach } = createAuthority("oversized-record-runtime");

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
      const result = yield* ProgramDriverRegistryContext.with(drivers, function* () {
        return yield* withJournalAuthority(authority, function* () {
          return yield* DurableEffectRegistryContext.with(
            createDurableEffectRegistry([]),
            function* () {
              return yield* ProgramRuntime.operations.run({ attach, executeHostEffects: true });
            },
          );
        });
      });
      expect(result).toMatchObject({
        state: "failed",
        error: { code: "record_value_too_large" },
      });
    });
  });

  it("rejects nested durable scheduling inside a recorded operation", async () => {
    const tool = createPinnedDurableProgram(manifest, function* (input, context) {
      return yield* context.record({ key: "unlabeled-record" }, function* () {
        return yield* context.effect<string>("echo", "1", input, {
          audience: "host-effects",
        });
      });
    });
    const tools = createDurableToolRegistry([tool]);
    const drivers = createProgramDriverRegistry([["program", createLocalProgramDriver(tools)]]);
    const { authority, attach } = createAuthority("nested-record-runtime");

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
      const result = yield* ProgramDriverRegistryContext.with(drivers, function* () {
        return yield* withJournalAuthority(authority, function* () {
          return yield* DurableEffectRegistryContext.with(
            createDurableEffectRegistry([]),
            function* () {
              return yield* ProgramRuntime.operations.run({ attach, executeHostEffects: true });
            },
          );
        });
      });
      expect(result).toMatchObject({
        state: "failed",
        error: { code: "nested_durable_operation" },
      });
    });
    expect(
      authority
        .readJournal(attach.sessionId)
        .filter((record) => record.payload.type === "PullRequested"),
    ).toHaveLength(1);
  });

  it("uses native createApi max/min middleware and runs host effects through durable receipt gating", async () => {
    const tool = createPinnedDurableProgram(manifest, function* (input, context) {
      yield* context.emit("progress", { stage: "before" });
      return yield* context.effect<string>("echo", "1", input, { audience: "host-effects" });
    });
    const tools = createDurableToolRegistry([tool]);
    const drivers = createProgramDriverRegistry([["program", createLocalProgramDriver(tools)]]);
    const effects = createDurableEffectRegistry([
      {
        definition: manifest.effects["echo"]!,
        satisfies: { mode: "idempotent", mechanism: "pull_id_key" },
        handler: (input) =>
          (function* () {
            return { status: "ok" as const, value: input };
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
        return yield* withJournalAuthority(authority, function* () {
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
