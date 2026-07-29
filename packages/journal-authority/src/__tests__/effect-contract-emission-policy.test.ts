import {
  createDurableEffectRegistration,
  type EffectDefinition,
} from "@sweatpants/durable-effects";

import {
  ProgramDriverRegistryContext,
  createProgramDriverRegistry,
} from "@sweatpants/durable-execution";
import { run } from "effection";
import { describe, expect, it } from "vitest";

import { effectContractDigest } from "@sweatpants/durable-effects/runtime";
import { CrankError } from "@sweatpants/durable-execution";
import {
  withJournalAuthority,
  createCapabilityKeyring,
  createInMemoryDurableJournalAuthority,
} from "../index.ts";
import { canonicalSnapshot, type Json } from "@sweatpants/foundation";
import {
  createPinnedDurableProgram,
  createDurableToolRegistry,
  createLocalProgramDriver,
  stableProgramAttachmentId,
  type DurableProgramManifest,
} from "@sweatpants/durable-execution";
import { ProgramRuntime } from "@sweatpants/durable-execution";
import { createDurableEffectRegistry } from "@sweatpants/durable-effects/runtime";
import {
  ANY_JSON_SCHEMA_DESCRIPTOR,
  NULL_RESULT_SCHEMA_DESCRIPTOR,
} from "@sweatpants/durable-execution";

const keyring = createCapabilityKeyring("effect-contract-policy-test", [
  { keyId: "key-1", secret: "x".repeat(32) },
]);

function effect(
  version = "1",
  cancellation = false,
  retrySafety: EffectDefinition<Json, Json, Json>["retrySafety"] = {
    mode: "idempotent",
    mechanism: "pull_id_key",
  },
): EffectDefinition<Json, Json, Json> {
  return {
    name: "sample",
    version,
    inputSchema: ANY_JSON_SCHEMA_DESCRIPTOR,
    outputSchema: ANY_JSON_SCHEMA_DESCRIPTOR,
    ...(cancellation ? { cancellation: { partialSchema: ANY_JSON_SCHEMA_DESCRIPTOR } } : {}),
    retrySafety,
  };
}

function manifest(
  id: string,
  definition: EffectDefinition<Json, Json, Json> = effect(),
): DurableProgramManifest {
  return {
    programId: id,
    version: "1",
    digest: canonicalSnapshot({ id }).sha,
    inputSchema: ANY_JSON_SCHEMA_DESCRIPTOR,
    outputSchema: NULL_RESULT_SCHEMA_DESCRIPTOR,
    elicits: {},
    effects: { [definition.name]: definition },
    capabilities: { durableEmissions: true, structuredChildren: true, replay: "strict" },
  };
}

function errorCode(error: unknown): string | undefined {
  return error instanceof CrankError ? error.code : undefined;
}

function authority(
  options: Partial<
    ConstructorParameters<
      typeof import("../durable-authority.ts").InMemoryDurableJournalAuthority
    >[0]
  > = {},
) {
  return createInMemoryDurableJournalAuthority({
    journalId: "journal",
    keyring,
    ...options,
  });
}

function openTask(
  selected: ReturnType<typeof authority>,
  taskId: string,
  selectedManifest = manifest(`program.${taskId}`),
) {
  return selected.openTask({
    sessionId: "session",
    turnId: taskId,
    taskId,
    manifest: selectedManifest,
    input: null,
    executionEpoch: 1,
    attachmentId: `attachment:${taskId}`,
    audience: "test",
  });
}

describe("whole-contract effect digest", () => {
  it("is structural and covers cancellation, retry safety, and version", () => {
    const first = effect();
    const separateInstance = {
      retrySafety: { mechanism: "pull_id_key", mode: "idempotent" },
      outputSchema: { ...ANY_JSON_SCHEMA_DESCRIPTOR },
      inputSchema: { ...ANY_JSON_SCHEMA_DESCRIPTOR },
      version: "1",
      name: "sample",
    } as EffectDefinition<Json, Json, Json>;

    expect(effectContractDigest(separateInstance)).toBe(effectContractDigest(first));
    expect(effectContractDigest(effect("1", true))).not.toBe(effectContractDigest(first));
    expect(effectContractDigest(effect("1", false, { mode: "unsafe" }))).not.toBe(
      effectContractDigest(first),
    );
    expect(effectContractDigest(effect("2"))).not.toBe(effectContractDigest(first));
  });

  it("accepts exact separately-instantiated handler contracts and rejects drift", () => {
    const required = effect();
    const equivalent = effect();
    const registration = createDurableEffectRegistration(
      equivalent,
      { mode: "idempotent", mechanism: "pull_id_key" },
      function* () {
        return { status: "ok", value: null };
      },
    );
    expect(() => createDurableEffectRegistry([registration], [required])).not.toThrow();
    expect(() => createDurableEffectRegistry([registration], [effect("1", true)])).toThrowError(
      expect.objectContaining({ code: "invalid_manifest" }),
    );
  });

  it("does not conflict across distinct effect versions", () => {
    const version1 = effect("1", true);
    const version2 = effect("2", false);
    const registrations = [
      createDurableEffectRegistration(
        version1,
        { mode: "idempotent", mechanism: "pull_id_key" },
        function* () {
          return { status: "ok", value: null };
        },
      ),
      createDurableEffectRegistration(
        version2,
        { mode: "idempotent", mechanism: "pull_id_key" },
        function* () {
          return { status: "ok", value: null };
        },
      ),
    ];
    expect(() => createDurableEffectRegistry(registrations, [version1, version2])).not.toThrow();
  });

  it("rejects same-key contract drift before opening another task", async () => {
    await run(function* () {
      const selected = authority();
      yield* openTask(selected, "one", manifest("program.one", effect("1", false)));
      let caught: unknown;
      try {
        yield* openTask(selected, "two", manifest("program.two", effect("1", true)));
      } catch (error) {
        caught = error;
      }
      expect(errorCode(caught)).toBe("invalid_manifest");
      expect(
        selected.readJournal("session").filter((record) => record.payload.type === "TaskOpened"),
      ).toHaveLength(1);

      const restored = authority({ snapshot: selected.exportSnapshot() });
      try {
        yield* openTask(restored, "three", manifest("program.three", effect("1", true)));
      } catch (error) {
        caught = error;
      }
      expect(errorCode(caught)).toBe("invalid_manifest");
    });
  });
});

describe("semantic emission policy", () => {
  it("validates opt-in policy while preserving absent and empty behavior", async () => {
    expect(() => authority({ emissionPolicy: { maxEmissionsPerTask: -1 } })).toThrowError(
      expect.objectContaining({ code: "invalid_manifest" }),
    );
    expect(() =>
      authority({ emissionPolicy: { maxCumulativeEmissionBytes: Number.MAX_SAFE_INTEGER + 1 } }),
    ).toThrowError(expect.objectContaining({ code: "invalid_manifest" }));

    await run(function* () {
      for (const emissionPolicy of [undefined, {}] as const) {
        const selected = authority(emissionPolicy ? { emissionPolicy } : {});
        const { programCapability } = yield* openTask(selected, `task-${String(emissionPolicy)}`);
        for (let actionIndex = 0; actionIndex < 5; actionIndex += 1) {
          yield* selected.emit({
            sessionId: "session",
            taskId: `task-${String(emissionPolicy)}`,
            actionIndex,
            descriptor: { eventType: "token", payload: actionIndex },
            programCapability,
          });
        }
        const taskSnapshot = selected.exportSnapshot().tasks[0]!;
        expect(taskSnapshot.emissionPolicy).toBeUndefined();
        expect(taskSnapshot.acceptedEmissionCount).toBeUndefined();
        expect(taskSnapshot.cumulativeEmissionBytes).toBeUndefined();
      }
    });
  });

  it("enforces count atomically and does not double-count duplicates", async () => {
    await run(function* () {
      const selected = authority({ emissionPolicy: { maxEmissionsPerTask: 1 } });
      const { programCapability } = yield* openTask(selected, "quota");
      const request = {
        sessionId: "session",
        taskId: "quota",
        actionIndex: 0,
        descriptor: { eventType: "semantic", payload: { ok: true } },
        programCapability,
      } as const;
      expect((yield* selected.emit(request)).duplicate).toBe(false);
      expect((yield* selected.emit(request)).duplicate).toBe(true);

      let caught: unknown;
      try {
        yield* selected.emit({
          ...request,
          actionIndex: 1,
          descriptor: { eventType: "semantic", payload: { ok: false } },
        });
      } catch (error) {
        caught = error;
      }
      expect(errorCode(caught)).toBe("emission_quota_exceeded");
      const snapshot = selected.exportSnapshot();
      expect(snapshot.tasks[0]?.nextActionIndex).toBe(1);
      expect(snapshot.tasks[0]?.nextEmissionIndex).toBe(1);
      expect(snapshot.tasks[0]?.acceptedEmissionCount).toBe(1);
      expect(
        selected
          .readJournal("session")
          .filter((record) => record.payload.type === "DurableEmission"),
      ).toHaveLength(1);
    });
  });

  it("counts canonical UTF-8 payload bytes and preserves task policy across restore", async () => {
    await run(function* () {
      const payload = "é";
      const exactBytes = new TextEncoder().encode(canonicalSnapshot(payload).canonical).byteLength;
      const selected = authority({
        emissionPolicy: {
          maxEmissionsPerTask: 2,
          maxCumulativeEmissionBytes: exactBytes * 2,
        },
      });
      const { programCapability } = yield* openTask(selected, "bytes");
      yield* selected.emit({
        sessionId: "session",
        taskId: "bytes",
        actionIndex: 0,
        descriptor: { eventType: "semantic", payload },
        programCapability,
      });

      const restored = authority({
        emissionPolicy: { maxEmissionsPerTask: 1, maxCumulativeEmissionBytes: 1 },
        snapshot: selected.exportSnapshot(),
      });
      const rebound = yield* restored.bindProgramAttachment(
        "session",
        "bytes",
        "attachment:bytes",
        1,
      );
      yield* restored.emit({
        sessionId: "session",
        taskId: "bytes",
        actionIndex: 1,
        descriptor: { eventType: "semantic", payload },
        programCapability: rebound.programCapability,
      });

      let caught: unknown;
      try {
        yield* restored.emit({
          sessionId: "session",
          taskId: "bytes",
          actionIndex: 2,
          descriptor: { eventType: "semantic", payload },
          programCapability: rebound.programCapability,
        });
      } catch (error) {
        caught = error;
      }
      expect(errorCode(caught)).toBe("emission_quota_exceeded");
      expect(restored.exportSnapshot().tasks[0]).toMatchObject({
        acceptedEmissionCount: 2,
        cumulativeEmissionBytes: exactBytes * 2,
      });
    });
  });

  it("turns an uncaught quota error into a journaled runtime failure", async () => {
    const runtimeManifest = { ...manifest("quota.runtime"), effects: {} };
    const tool = createPinnedDurableProgram(runtimeManifest, function* (_input, context) {
      yield* context.emit("semantic", { ordinal: 1 });
      yield* context.emit("semantic", { ordinal: 2 });
      return null;
    });
    const drivers = createProgramDriverRegistry([
      ["program", createLocalProgramDriver(createDurableToolRegistry([tool]))],
    ]);
    const selected = authority({ emissionPolicy: { maxEmissionsPerTask: 1 } });
    const attach = {
      sessionId: "session",
      taskId: "runtime",
      program: {
        id: runtimeManifest.programId,
        version: runtimeManifest.version,
        digest: runtimeManifest.digest,
      },
      input: null,
      route: { driverKind: "program" },
      executionEpoch: 1,
    } as const;

    await run(function* () {
      yield* selected.openTask({
        sessionId: attach.sessionId,
        turnId: "runtime",
        taskId: attach.taskId,
        manifest: runtimeManifest,
        input: attach.input,
        executionEpoch: 1,
        attachmentId: stableProgramAttachmentId(attach),
        audience: "test",
      });
      const result = yield* ProgramDriverRegistryContext.with(drivers, function* () {
        return yield* withJournalAuthority(selected, function* () {
          return yield* ProgramRuntime.operations.run({ attach });
        });
      });
      expect(result).toMatchObject({
        state: "failed",
        error: { code: "emission_quota_exceeded" },
      });
      expect(selected.readJournal("session").map((record) => record.payload.type)).toEqual([
        "TaskOpened",
        "DurableEmission",
        "TaskClosed",
      ]);
    });
  });
});
