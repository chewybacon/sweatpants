import type { AuthorityScenarioDriver } from "../testing/scenario-driver.ts";
import { call } from "effection";
import { createWorkflowProgramDriver } from "../workflow/program-driver.ts";
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
import { createCapabilityKeyring } from "../index.ts";
import {
  driveInstalledTestProgramTree,
  withProgramDriverTestScope,
} from "../testing/program-driver-host.ts";
import {
  createAuthorityScenarioDriver,
  type InMemoryJournalAuthorityOptions,
} from "../testing/testing.ts";
import type { DurableAuthoritySnapshot } from "../state/authority-snapshot.ts";
import { type Json, canonicalDigest, canonicalJson } from "@sweatpants/foundation";
import {
  createPinnedDurableProgram,
  createDurableToolRegistry,
  stableProgramAttachmentId,
  type DurableProgramManifest,
} from "@sweatpants/durable-execution";
import { createDurableEffectRegistry } from "@sweatpants/durable-effects/runtime";
import {
  ANY_JSON_SCHEMA_DESCRIPTOR,
  NULL_RESULT_SCHEMA_DESCRIPTOR,
} from "@sweatpants/durable-execution";

function firstTask(snapshot: DurableAuthoritySnapshot) {
  return snapshot.sessions[0]?.[1].execution.tasks[0];
}

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
    digest: canonicalDigest({ id }),
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

function authority(options: Partial<InMemoryJournalAuthorityOptions> = {}) {
  return createAuthorityScenarioDriver({
    journalId: "journal",
    keyring,
    ...options,
  });
}

function openTask(
  selected: AuthorityScenarioDriver,
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
    return await run(function* () {
      yield* call(() =>
        run(function* () {
          const selected = yield* authority();
          yield* openTask(selected, "one", manifest("program.one", effect("1", false)));
          let caught: unknown;
          try {
            yield* openTask(selected, "two", manifest("program.two", effect("1", true)));
          } catch (error) {
            caught = error;
          }
          expect(errorCode(caught)).toBe("invalid_manifest");
          expect(
            selected
              .readJournal("session")
              .filter((record) => record.payload.type === "TaskOpened"),
          ).toHaveLength(1);

          const restored = yield* authority({ snapshot: selected.exportSnapshot() });
          try {
            yield* openTask(restored, "three", manifest("program.three", effect("1", true)));
          } catch (error) {
            caught = error;
          }
          expect(errorCode(caught)).toBe("invalid_manifest");
        }),
      );
    });
  });
});

describe("semantic emission policy", () => {
  it("validates opt-in policy while preserving absent and empty behavior", async () => {
    return await run(function* () {
      yield* call(() =>
        expect(
          run(() => authority({ emissionPolicy: { maxEmissionsPerTask: -1 } })),
        ).rejects.toThrowError(expect.objectContaining({ code: "invalid_manifest" })),
      );
      yield* call(() =>
        expect(
          run(() =>
            authority({
              emissionPolicy: { maxCumulativeEmissionBytes: Number.MAX_SAFE_INTEGER + 1 },
            }),
          ),
        ).rejects.toThrowError(expect.objectContaining({ code: "invalid_manifest" })),
      );

      yield* call(() =>
        run(function* () {
          for (const emissionPolicy of [undefined, {}] as const) {
            const selected = yield* authority(emissionPolicy ? { emissionPolicy } : {});
            const { programCapability } = yield* openTask(
              selected,
              `task-${String(emissionPolicy)}`,
            );
            for (let actionIndex = 0; actionIndex < 5; actionIndex += 1) {
              yield* selected.emit({
                sessionId: "session",
                taskId: `task-${String(emissionPolicy)}`,
                actionIndex,
                descriptor: { eventType: "token", payload: actionIndex },
                programCapability,
              });
            }
            const taskSnapshot = firstTask(selected.exportSnapshot())!;
            expect(taskSnapshot.emissionPolicy).toBeUndefined();
            // The direct snapshot mirrors current state, so counters are retained
            // even when no policy consumes them.
            expect(taskSnapshot.acceptedEmissionCount).toBe(5);
            expect(taskSnapshot.cumulativeEmissionBytes).toBeGreaterThan(0);
          }
        }),
      );
    });
  });

  it("enforces count atomically and does not double-count duplicates", async () => {
    return await run(function* () {
      yield* call(() =>
        run(function* () {
          const selected = yield* authority({ emissionPolicy: { maxEmissionsPerTask: 1 } });
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
          expect(firstTask(snapshot)?.nextActionIndex).toBe(1);
          expect(firstTask(snapshot)?.nextEmissionIndex).toBe(1);
          expect(firstTask(snapshot)?.acceptedEmissionCount).toBe(1);
          expect(
            selected
              .readJournal("session")
              .filter((record) => record.payload.type === "DurableEmission"),
          ).toHaveLength(1);
        }),
      );
    });
  });

  it("counts canonical UTF-8 payload bytes and preserves task policy across restore", async () => {
    return await run(function* () {
      yield* call(() =>
        run(function* () {
          const payload = "é";
          const exactBytes = new TextEncoder().encode(canonicalJson(payload)).byteLength;
          const selected = yield* authority({
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

          const restored = yield* authority({
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
          expect(firstTask(restored.exportSnapshot())).toMatchObject({
            acceptedEmissionCount: 2,
            cumulativeEmissionBytes: exactBytes * 2,
          });
        }),
      );
    });
  });

  it("turns an uncaught quota error into a journaled runtime failure", async () => {
    return await run(function* () {
      const runtimeManifest = { ...manifest("quota.runtime"), effects: {} };
      const tool = createPinnedDurableProgram(runtimeManifest, function* (_input, context) {
        yield* context.emit("semantic", { ordinal: 1 });
        yield* context.emit("semantic", { ordinal: 2 });
        return null;
      });
      const drivers = createProgramDriverRegistry([
        ["program", createWorkflowProgramDriver(createDurableToolRegistry([tool]))],
      ]);
      const selected = yield* authority({ emissionPolicy: { maxEmissionsPerTask: 1 } });
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

      yield* call(() =>
        run(function* () {
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
            return yield* withProgramDriverTestScope(selected, function* () {
              return yield* driveInstalledTestProgramTree({ attach });
            });
          });
          expect(result).toMatchObject({
            state: "failed",
            error: { code: "emission_quota_exceeded" },
          });
          expect(selected.readJournal("session").map((record) => record.payload.type)).toEqual([
            "TaskOpened",
            "AdvancementBound",
            "DurableEmission",
            "TaskClosed",
            "AdvancementReleased",
          ]);
        }),
      );
    });
  });
});
