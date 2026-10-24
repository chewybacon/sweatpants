// @vitest-environment node
import { mkdtempSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { describe, expect, it } from "vitest";
import { run, type Operation } from "effection";
import {
  openBetterSqliteStorage,
  openBetterSqliteStorageForTest,
  BetterSqliteDatabase,
} from "@sweatpants/storage-sqlite/better-sqlite3";
import { createJournal } from "../../../packages/journal-authority/src/shell/journal.ts";
import {
  createCapabilityKeyring,
  verifyResolutionCapability,
} from "../../../packages/journal-authority/src/contract/capabilities.ts";
import { createDurableSchemaRegistry } from "@sweatpants/journal-authority/schema-registry";
import { createSchemaFixture, stringGuard } from "@sweatpants/journal-authority/testing";
import type { DurableOperationDescriptor } from "@sweatpants/durable-execution";
import type { RecoverRecordRequest } from "../../../packages/journal-authority/src/contract/authority-types.ts";

const artifacts = resolve("../.artifacts/journal-primitives");
mkdirSync(artifacts, { recursive: true });
const directory = mkdtempSync(join(artifacts, "permission-"));
const input = createSchemaFixture(
  "permission/input",
  "program_input",
  { type: "string" },
  stringGuard,
);
const output = createSchemaFixture(
  "permission/output",
  "program_output",
  { type: "string" },
  stringGuard,
);
const effectInput = createSchemaFixture(
  "permission/effect-input",
  "effect_input",
  { type: "string" },
  stringGuard,
);
const effectOutput = createSchemaFixture(
  "permission/effect-output",
  "effect_output",
  { type: "string" },
  stringGuard,
);
const response = createSchemaFixture(
  "permission/response",
  "elicit_response",
  { type: "string" },
  stringGuard,
);
let now = 1000;
const options = {
  journalId: "permission",
  journalIncarnation: "1",
  now: () => now,
  keyring: createCapabilityKeyring("fixture", [{ keyId: "fixture", secret: "x".repeat(32) }]),
  schemaRegistry: createDurableSchemaRegistry([
    input.entry,
    output.entry,
    effectInput.entry,
    effectOutput.entry,
    response.entry,
  ]),
};
type Journal = ReturnType<typeof createJournal> extends Operation<infer T> ? T : never;
function* open(path: string) {
  const handle = yield* openBetterSqliteStorage(path, { initialize: true, wal: false });
  const journal = yield* createJournal(handle.storage.executionStore, options);
  return { handle, journal };
}
function* reserve(
  journal: Journal,
  unsafe = false,
  liveMandate = false,
  descriptor?: DurableOperationDescriptor,
) {
  const opened = yield* journal.advance({
    type: "execution.open-task",
    request: {
      sessionId: "session",
      taskId: "root",
      turnId: "turn",
      input: "hello",
      manifest: {
        programId: "permission",
        version: "1",
        digest: "c".repeat(64),
        inputSchema: input.descriptor,
        outputSchema: output.descriptor,
        elicits: { approval: { response: response.descriptor } },
        effects: {
          echo: {
            name: "echo",
            version: "1",
            inputSchema: effectInput.descriptor,
            outputSchema: effectOutput.descriptor,
            retrySafety: { mode: "repeatable" },
          },
        },
        capabilities: { durableEmissions: false, structuredChildren: false, replay: "strict" },
      },
      executionEpoch: 1,
      attachmentId: "first",
      audience: "program-host",
      route: { driverKind: "program" },
    },
  });
  let programCapability = opened.programCapability;
  let oldMandate;
  if (liveMandate) {
    const plan = yield* journal.query({ type: "forest.replay-plan", sessionId: "session" });
    const item = plan.replay[0]!;
    const bound = yield* journal.advance({
      type: "execution.bind-mandate",
      request: {
        address: item.address,
        strand: item.strand,
        program: item.program,
        attachmentId: "owner",
        ownerId: "owner",
        leaseDurationMs: 30000,
        placement: {
          route: { kind: "local", driverKind: "program", route: { driverKind: "program" } },
          evaluatorKind: "program",
          sandbox: { mode: "allocate" },
        },
        expected: {
          strandHeadDigest: item.plannedHead.digest,
          leaseEpoch: item.executionEpoch,
          forkGroupRevision: item.groupContext.groupRevision,
        },
        frontierProof: {
          frontierDigest: "d".repeat(64),
          strandHeadDigest: item.plannedHead.digest,
          replayedThroughActionIndex: item.replayedThroughActionIndex,
          replayChainDigest: item.replayChainDigest,
          cancellationReplayed: false,
        },
      },
    });
    if (bound.status !== "bound") {
      throw new Error("Expected live mandate");
    }
    programCapability = bound.mandate.programCapability;
    oldMandate = bound.mandate;
  }
  const request = {
    sessionId: "session",
    taskId: "root",
    turnId: "turn",
    actionIndex: 0,
    pullIndex: 0,
    descriptor: descriptor ?? {
      kind: "record" as const,
      key: "same",
      retrySafety: { mode: unsafe ? ("unsafe" as const) : ("repeatable" as const) },
    },
    programCapability,
  };
  const first = yield* journal.advance({ type: "execution.reserve-pull", request });
  if (first.status !== "authorized") {
    throw new Error("Expected first permission");
  }
  const recovery: RecoverRecordRequest = {
    ...request,
    pullId: first.pullId,
    expectedAttemptId: first.attemptId,
    replacement: yield* replacement(journal),
  };
  return { first, recovery, oldMandate };
}

function* replacement(
  journal: Journal,
  attachmentId = "recovery",
): Operation<RecoverRecordRequest["replacement"]> {
  const plan = yield* journal.query({ type: "forest.replay-plan", sessionId: "session" });
  const row = plan.rows[0]!;
  const state = yield* journal.query({
    type: "task.execution-state",
    sessionId: "session",
    taskId: "root",
  });
  return {
    address: row.address,
    strand: row.strand,
    program: row.program,
    ownerId: attachmentId,
    attachmentId,
    leaseDurationMs: 30000,
    placement: {
      route: { kind: "local", driverKind: "program", route: { driverKind: "program" } },
      evaluatorKind: "program",
      sandbox: { mode: "allocate" },
    },
    expected: {
      strandHeadDigest: row.head.digest,
      leaseEpoch: state.executionEpoch,
      forkGroupRevision: row.groupContext.groupRevision,
    },
    frontierProof: {
      strandHeadDigest: row.head.digest,
      replayedThroughActionIndex: row.head.actionIndex,
      frontierDigest: "d".repeat(64),
      replayChainDigest: "e".repeat(64),
      cancellationReplayed: false,
    },
  };
}
function* rejects(operation: Operation<unknown>, code: string) {
  let error: unknown;
  try {
    yield* operation;
  } catch (caught) {
    error = caught;
  }
  expect(error).toMatchObject({ code });
}
function databaseState(path: string) {
  const database = new BetterSqliteDatabase(path, { readonly: true });
  try {
    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as { name: string }[];
    return tables.map(({ name }) => ({
      name,
      rows: database.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all(),
    }));
  } finally {
    database.close();
  }
}

describe("explicit repeatable record recovery permission (real authority and SQLite)", () => {
  it("rejects retained legacy query authority without changing recovery ownership or accepted history", async () => {
    const path = join(directory, "legacy-query.sqlite");
    const saved = await run(function* () {
      const { handle, journal } = yield* open(path);
      try {
        const initial = yield* reserve(journal);
        // Captured from the real public query on the pre-fix candidate, before
        // takeover (reproduction.log). A persisted old token, not a forged token
        // or a test-only issuer; fixture journal/key/occurrence identities are stable.
        const legacy =
          "v1.Zml4dHVyZQ.eyJhdHRlbXB0SWQiOiJub25lIiwiYXVkaWVuY2UiOiJwcm9ncmFtLWV4ZWN1dGlvbiIsImRlc2NyaXB0b3JEaWdlc3QiOiIzMWQ4ODZiOTI1NTQ2NWMzZDdiNTRkMDljNjhkZGM0OWFjZDNiM2VlZjExMTE0MzdmODNmMzNmYzk2YTUxMjFkIiwiaXNzdWVyIjoiZml4dHVyZSIsImpvdXJuYWxJZCI6InBlcm1pc3Npb24iLCJqb3VybmFsSW5jYXJuYXRpb24iOiIxIiwia2V5SWQiOiJmaXh0dXJlIiwibWF4T3V0Y29tZUJ5dGVzIjoxMDQ4NTc2LCJub25jZSI6IjI1NWYzNWI4ODVkOGQ5NWJjYjZkN2NmOGZhMmU1ODljZGYwY2E3OGE1ODc3NTVjYjM5OWU4MDczMzc1YmQ5MTgiLCJwZXJtaXNzaW9ucyI6WyJyZXNvbHZlIl0sInB1bGxJZCI6IjIyNjJmMzA5ZTUwOTg4NjM5MzkzNjJmMjk0OTc1ZWM3ZjYxOTM2MGEzNGRiNWQ1NDBlN2E4ZTY1YjcwMTgwZGIiLCJyZXN1bHRTY2hlbWFEaWdlc3QiOiJhMTQ4ODViODFiZTAyNGFjZWJkNTNlZmM0NTAwNTE1ZjVlYjljN2QxMGNiN2EzYzA2MmQ2ZTk2Mzk1MzY5OGU4Iiwic2Vzc2lvbklkIjoic2Vzc2lvbiIsInRhc2tJZCI6InJvb3QiLCJ2ZXJzaW9uIjoxfQ.G3C72-KrsMqtWFBn1k8-CilV9jZ4bv7UHLBi2YbFGqw";
        const claims = verifyResolutionCapability(legacy, options.keyring, "program-execution");
        expect(claims.attemptId).toBe("none");
        expect(claims.pullId).toBe(initial.first.pullId);
        yield* rejects(
          journal.query({
            type: "pull.resolution-capability",
            sessionId: "session",
            taskId: "root",
            pullId: initial.first.pullId,
          }),
          "invalid_resolution_capability",
        );
        const successor = yield* journal.advance({
          type: "execution.recover-record",
          request: initial.recovery,
        });
        const committed = databaseState(path);
        expect(
          yield* journal.advance({
            type: "execution.resolve-pull",
            request: {
              capability: legacy,
              audience: "program-execution",
              outcome: { status: "ok", value: "late" },
            },
          }),
        ).toEqual({ status: "rejected", code: "invalid_resolution_capability" });
        expect(databaseState(path)).toEqual(committed);
        return { initial, legacy, successor };
      } finally {
        yield* handle.close();
      }
    });
    for (const phase of ["committed", "accepted", "reopened"] as const) {
      await run(function* () {
        const { handle, journal } = yield* open(path);
        try {
          const before = databaseState(path);
          yield* rejects(
            journal.query({
              type: "pull.resolution-capability",
              sessionId: "session",
              taskId: "root",
              pullId: saved.initial.first.pullId,
            }),
            "invalid_resolution_capability",
          );
          for (const value of ["successor", "changed"]) {
            for (const [capability, code] of [
              [saved.legacy, "invalid_resolution_capability"],
              [saved.initial.first.resolutionCapability, "capability_revoked"],
            ]) {
              expect(
                yield* journal.advance({
                  type: "execution.resolve-pull",
                  request: {
                    capability: capability!,
                    audience: "program-execution",
                    outcome: { status: "ok", value },
                  },
                }),
              ).toEqual({ status: "rejected", code });
              expect(databaseState(path)).toEqual(before);
            }
          }
          if (phase === "committed") {
            const current = yield* journal.advance({
              type: "execution.reserve-pull",
              request: {
                ...saved.initial.recovery,
                programCapability: saved.successor.mandate.programCapability,
              },
            });
            expect(current).toMatchObject({
              status: "authorized",
              resolutionCapability: saved.successor.resolutionCapability,
            });
            expect(
              yield* journal.advance({
                type: "execution.resolve-pull",
                request: {
                  capability: saved.successor.resolutionCapability,
                  audience: "program-execution",
                  outcome: { status: "ok", value: "successor" },
                },
              }),
            ).toMatchObject({ status: "accepted" });
          }
          const plan = yield* journal.query({ type: "forest.replay-plan", sessionId: "session" });
          expect(plan.replay[0]?.replay).toMatchObject([
            { actionIndex: 0, outcome: { status: "ok", value: "successor" } },
          ]);
        } finally {
          yield* handle.close();
        }
      });
    }
  });

  it("preserves ordinary detached contenders without recovery", async () => {
    const path = join(directory, "ordinary-contenders.sqlite");
    await run(function* () {
      const { handle, journal } = yield* open(path);
      try {
        const initial = yield* reserve(journal);
        const attached = yield* journal.advance({
          type: "execution.replace-attachment",
          request: { sessionId: "session", taskId: "root", attachmentId: "ordinary" },
        });
        const current = yield* journal.advance({
          type: "execution.reserve-pull",
          request: { ...initial.recovery, programCapability: attached.programCapability },
        });
        if (current.status !== "authorized") {
          throw new Error("Expected contender");
        }
        for (const [capability, value, status] of [
          [initial.first.resolutionCapability, "answer", "accepted"],
          [current.resolutionCapability, "answer", "duplicate"],
          [initial.first.resolutionCapability, "changed", "rejected"],
          [current.resolutionCapability, "changed", "rejected"],
        ]) {
          expect(
            yield* journal.advance({
              type: "execution.resolve-pull",
              request: {
                capability: capability!,
                audience: "program-execution",
                outcome: { status: "ok", value: value! },
              },
            }),
          ).toMatchObject({ status });
        }
      } finally {
        yield* handle.close();
      }
    });
  });

  it("preserves external attemptless elicitation tokens across attachment replacement and reopen", async () => {
    const path = join(directory, "external-elicit.sqlite");
    const saved = await run(function* () {
      const { handle, journal } = yield* open(path);
      try {
        const initial = yield* reserve(journal);
        yield* journal.advance({
          type: "execution.resolve-pull",
          request: {
            capability: initial.first.resolutionCapability,
            audience: "program-execution",
            outcome: { status: "ok", value: "first" },
          },
        });
        const pending = yield* journal.advance({
          type: "execution.reserve-pull",
          request: {
            ...initial.recovery,
            actionIndex: 1,
            pullIndex: 1,
            descriptor: {
              kind: "elicit",
              key: "approval",
              message: "Approve?",
              response: response.descriptor,
            },
          },
        });
        if (pending.status !== "pending") {
          throw new Error("Expected elicitation");
        }
        const capability = yield* journal.query({
          type: "pull.resolution-capability",
          sessionId: "session",
          taskId: "root",
          pullId: pending.pullId,
        });
        expect(capability).toBe(pending.resolutionCapability);
        expect(
          verifyResolutionCapability(capability, options.keyring, "user:approval").attemptId,
        ).toBe("none");
        yield* journal.advance({
          type: "execution.replace-attachment",
          request: { sessionId: "session", taskId: "root", attachmentId: "external-successor" },
        });
        return { capability, pullId: pending.pullId };
      } finally {
        yield* handle.close();
      }
    });
    await run(function* () {
      const { handle, journal } = yield* open(path);
      try {
        expect(
          yield* journal.query({
            type: "pull.resolution-capability",
            sessionId: "session",
            taskId: "root",
            pullId: saved.pullId,
          }),
        ).toBe(saved.capability);
        for (const status of ["accepted", "duplicate"]) {
          expect(
            yield* journal.advance({
              type: "execution.resolve-pull",
              request: {
                capability: saved.capability,
                audience: "user:approval",
                outcome: { status: "ok", value: { action: "accept", content: "yes" } },
              },
            }),
          ).toMatchObject({ status });
        }
      } finally {
        yield* handle.close();
      }
    });
  });

  it("persists same occurrence/new attempt and revokes late settlement across reopen", async () => {
    const path = join(directory, "lineage.sqlite");
    const saved = await run(function* () {
      const { handle, journal } = yield* open(path);
      try {
        return yield* reserve(journal);
      } finally {
        yield* handle.close();
      }
    });
    const successor = await run(function* () {
      const { handle, journal } = yield* open(path);
      try {
        expect(
          yield* journal.advance({
            type: "execution.bind-mandate",
            request: saved.recovery.replacement,
          }),
        ).toEqual({ status: "stale", mismatch: "strand_head" });
        const permission = yield* journal.advance({
          type: "execution.recover-record",
          request: saved.recovery,
        });
        expect(permission.pullId).toBe(saved.first.pullId);
        expect(permission.attemptId).toBe(`${saved.first.pullId}:attempt-1`);
        const plan = yield* journal.query({ type: "forest.replay-plan", sessionId: "session" });
        expect(plan.rows[0]?.classification).toBe("structurally_blocked");
        expect(
          yield* journal.advance({
            type: "execution.resolve-pull",
            request: {
              capability: saved.first.resolutionCapability,
              audience: "program-execution",
              outcome: { status: "ok", value: "late" },
            },
          }),
        ).toEqual({ status: "rejected", code: "capability_revoked" });
        return permission;
      } finally {
        yield* handle.close();
      }
    });
    await run(function* () {
      const { handle, journal } = yield* open(path);
      try {
        const accepted = yield* journal.advance({
          type: "execution.resolve-pull",
          request: {
            capability: successor.resolutionCapability,
            audience: "program-execution",
            outcome: { status: "ok", value: "successor" },
          },
        });
        expect(accepted.status).toBe("accepted");
        const records = yield* journal.readSession("session");
        expect(records.filter(({ payload }) => payload.type === "PullRequested")).toHaveLength(1);
        expect(
          records
            .filter(({ payload }) => payload.type === "AttemptStarted")
            .map(({ payload }) => payload),
        ).toMatchObject([
          { pullId: saved.first.pullId, attemptIndex: 0 },
          { pullId: saved.first.pullId, attemptIndex: 1 },
        ]);
        expect(
          records
            .filter(({ payload }) => payload.type === "AttemptAbandoned")
            .map(({ payload }) => payload),
        ).toMatchObject([
          { attemptId: saved.first.attemptId, reason: "repeatable_record_recovery" },
        ]);
        const plan = yield* journal.query({ type: "forest.replay-plan", sessionId: "session" });
        expect(plan.replay[0]?.replay).toMatchObject([
          { actionIndex: 0, outcome: { status: "ok", value: "successor" } },
        ]);
      } finally {
        yield* handle.close();
      }
    });
  });

  it("permits recovery after the previous task mandate expires", async () => {
    await run(function* () {
      const { handle, journal } = yield* open(join(directory, "expired.sqlite"));
      try {
        const { recovery } = yield* reserve(journal, false, true);
        now += 30001;
        const successor = yield* journal.advance({
          type: "execution.recover-record",
          request: recovery,
        });
        expect(successor.attemptId).toBe(`${recovery.pullId}:attempt-1`);
        const records = yield* journal.readSession("session");
        expect(records.map(({ payload }) => payload)).toContainEqual(
          expect.objectContaining({
            type: "AdvancementBound",
            leaseEpoch: successor.mandate.lease.epoch,
          }),
        );
      } finally {
        yield* handle.close();
        now = 1000;
      }
    });
  });

  it("fences prior program authority, detached contenders and stale cleanup through repeated recovery of occurrence one", async () => {
    const path = join(directory, "contenders.sqlite");
    const saved = await run(function* () {
      const { handle, journal } = yield* open(path);
      try {
        const initial = yield* reserve(journal, false, true);
        expect(initial.oldMandate).toBeDefined();
        yield* journal.advance({
          type: "execution.resolve-pull",
          request: {
            capability: initial.first.resolutionCapability,
            audience: "program-execution",
            outcome: { status: "ok", value: "first" },
          },
        });
        const request = { ...initial.recovery, actionIndex: 1, pullIndex: 1 };
        const second = yield* journal.advance({ type: "execution.reserve-pull", request });
        if (second.status !== "authorized") {
          throw new Error("second occurrence");
        }
        const attached = yield* journal.advance({
          type: "execution.replace-attachment",
          request: { sessionId: "session", taskId: "root", attachmentId: "detached-owner" },
        });
        const detachedRequest = { ...request, programCapability: attached.programCapability };
        const contender = yield* journal.advance({
          type: "execution.reserve-pull",
          request: detachedRequest,
        });
        if (contender.status !== "authorized") {
          throw new Error("contender");
        }
        const recovery = {
          ...detachedRequest,
          pullId: second.pullId,
          expectedAttemptId: contender.attemptId,
          replacement: yield* replacement(journal),
        };
        const permission = yield* journal.advance({
          type: "execution.recover-record",
          request: recovery,
        });
        expect(permission.pullId).toBe(second.pullId);
        expect(permission.attemptId).toBe(`${second.pullId}:attempt-2`);
        // Original and immediately preceding program owners cannot retrieve the successor.
        yield* rejects(
          journal.advance({ type: "execution.reserve-pull", request }),
          "stale_program_capability",
        );
        yield* rejects(
          journal.advance({ type: "execution.reserve-pull", request: detachedRequest }),
          "stale_program_capability",
        );
        yield* rejects(
          journal.advance({
            type: "execution.recover-record",
            request: { ...recovery, expectedAttemptId: permission.attemptId },
          }),
          "stale_program_capability",
        );
        const fresh = {
          ...recovery,
          programCapability: permission.mandate.programCapability,
          expectedAttemptId: permission.attemptId,
          replacement: yield* replacement(journal, "next"),
        };
        // Even the current capability and a fresh observation cannot preempt a live owner.
        yield* rejects(
          journal.advance({ type: "execution.recover-record", request: fresh }),
          "stale_program_capability",
        );
        expect(
          yield* journal.advance({
            type: "execution.release-mandate",
            request: { mandate: initial.oldMandate!, reason: "failed" },
          }),
        ).toEqual({ status: "stale" });
        for (const old of [second, contender]) {
          expect(
            yield* journal.advance({
              type: "execution.resolve-pull",
              request: {
                capability: old.resolutionCapability,
                audience: "program-execution",
                outcome: { status: "ok", value: "second" },
              },
            }),
          ).toEqual({ status: "rejected", code: "capability_revoked" });
        }
        // Neither old cleanup nor rejected settlement released replacement ownership.
        yield* rejects(
          journal.advance({ type: "execution.recover-record", request: fresh }),
          "stale_program_capability",
        );
        expect(
          yield* journal.advance({
            type: "execution.release-mandate",
            request: { mandate: permission.mandate, reason: "failed" },
          }),
        ).toEqual({ status: "released" });
        const next = yield* journal.advance({ type: "execution.recover-record", request: fresh });
        expect(next.attemptId).toBe(`${second.pullId}:attempt-3`);
        expect(
          yield* journal.advance({
            type: "execution.release-mandate",
            request: { mandate: permission.mandate, reason: "failed" },
          }),
        ).toEqual({ status: "stale" });
        yield* rejects(
          journal.advance({ type: "execution.reserve-pull", request: fresh }),
          "stale_program_capability",
        );
        return { initial, second, contender, permission, next };
      } finally {
        yield* handle.close();
      }
    });
    await run(function* () {
      const { handle, journal } = yield* open(path);
      try {
        for (const old of [saved.second, saved.contender, saved.permission]) {
          expect(
            yield* journal.advance({
              type: "execution.resolve-pull",
              request: {
                capability: old.resolutionCapability,
                audience: "program-execution",
                outcome: { status: "ok", value: "second" },
              },
            }),
          ).toEqual({ status: "rejected", code: "capability_revoked" });
        }
        expect(
          (yield* journal.advance({
            type: "execution.resolve-pull",
            request: {
              capability: saved.next.resolutionCapability,
              audience: "program-execution",
              outcome: { status: "ok", value: "second" },
            },
          })).status,
        ).toBe("accepted");
      } finally {
        yield* handle.close();
      }
    });
    await run(function* () {
      const { handle, journal } = yield* open(path);
      try {
        for (const old of [saved.second, saved.contender, saved.permission]) {
          expect(
            yield* journal.advance({
              type: "execution.resolve-pull",
              request: {
                capability: old.resolutionCapability,
                audience: "program-execution",
                outcome: { status: "ok", value: "second" },
              },
            }),
          ).toEqual({ status: "rejected", code: "capability_revoked" });
        }
        const records = (yield* journal.readSession("session")).map(({ payload }) => payload);
        expect(records.filter((p) => p.type === "PullRequested")).toHaveLength(2);
        expect(
          records.filter(
            (p) => p.type === "AttemptStarted" && p.pullId === saved.initial.first.pullId,
          ),
        ).toHaveLength(1);
        expect(
          records.filter((p) => p.type === "AttemptStarted" && p.pullId === saved.second.pullId),
        ).toHaveLength(4);
        const plan = yield* journal.query({ type: "forest.replay-plan", sessionId: "session" });
        expect(plan.replay[0]?.replay).toMatchObject([
          { actionIndex: 0, outcome: { status: "ok", value: "first" } },
          { actionIndex: 1, outcome: { status: "ok", value: "second" } },
        ]);
      } finally {
        yield* handle.close();
      }
    });
  });

  it("rolls back recovery revocations, binding, epoch, attachment and attempt at the real SQLite pre-commit boundary", async () => {
    const path = join(directory, "recovery-rollback.sqlite");
    const saved = await run(function* () {
      const { handle, journal } = yield* open(path);
      try {
        return yield* reserve(journal, false, true);
      } finally {
        yield* handle.close();
      }
    });
    now += 30001;
    try {
      const before = databaseState(path);
      await expect(
        run(function* () {
          const handle = yield* openBetterSqliteStorageForTest(path, {
            wal: false,
            faultInjection: "execution-before-commit",
          });
          try {
            const journal = yield* createJournal(handle.storage.executionStore, options);
            yield* journal.advance({ type: "execution.recover-record", request: saved.recovery });
          } finally {
            yield* handle.close();
          }
        }),
      ).rejects.toThrow("Injected SQLite fault at execution-before-commit");
      expect(databaseState(path)).toEqual(before);
      await run(function* () {
        const { handle, journal } = yield* open(path);
        try {
          const permission = yield* journal.advance({
            type: "execution.recover-record",
            request: saved.recovery,
          });
          expect(permission.attemptId).toBe(`${saved.first.pullId}:attempt-1`);
          expect(permission.mandate.lease.epoch).toBe(
            saved.recovery.replacement.expected.leaseEpoch + 1,
          );
          const records = (yield* journal.readSession("session")).map(({ payload }) => payload);
          expect(records.filter((p) => p.type === "AttemptStarted")).toHaveLength(2);
          expect(records.filter((p) => p.type === "AdvancementBound")).toHaveLength(2);
          expect(
            yield* journal.advance({
              type: "execution.release-mandate",
              request: { mandate: saved.oldMandate!, reason: "failed" },
            }),
          ).toEqual({ status: "stale" });
        } finally {
          yield* handle.close();
        }
      });
    } finally {
      now = 1000;
    }
  });

  it.each([
    "unsafe",
    "unsafe-upgrade",
    "idempotent",
    "non-record",
    "wrong-pull-index",
    "stale-epoch",
    "wrong-expected-epoch",
    "wrong-program",
    "wrong-head",
    "invalid-lease",
    "same-attachment",
    "accepted",
    "stale-attempt",
    "stale-attempt-current-owner",
    "wrong-pull",
    "wrong-descriptor",
    "wrong-turn",
    "wrong-index",
    "invalid-capability",
    "stale-attachment",
    "live-owner",
    "live-mandate",
    "cancelled",
  ])("rejects %s without changing semantic history", async (variant) => {
    await run(function* () {
      const { handle, journal } = yield* open(join(directory, `${variant}.sqlite`));
      try {
        const { first, recovery } = yield* reserve(
          journal,
          ["unsafe", "unsafe-upgrade"].includes(variant),
          variant === "live-mandate",
          variant === "idempotent"
            ? {
                kind: "record",
                key: "same",
                retrySafety: { mode: "idempotent", mechanism: "pull_id_key" },
              }
            : variant === "non-record"
              ? {
                  kind: "effect",
                  name: "echo",
                  version: "1",
                  input: "hello",
                  resolver: { audience: "program-execution" },
                }
              : undefined,
        );
        if (variant === "accepted") {
          yield* journal.advance({
            type: "execution.resolve-pull",
            request: {
              capability: first.resolutionCapability,
              audience: "program-execution",
              outcome: { status: "ok", value: "accepted" },
            },
          });
        }
        if (variant === "stale-attempt-current-owner") {
          const permission = yield* journal.advance({
            type: "execution.recover-record",
            request: recovery,
          });
          yield* journal.advance({
            type: "execution.release-mandate",
            request: { mandate: permission.mandate, reason: "failed" },
          });
          recovery.programCapability = permission.mandate.programCapability;
          recovery.replacement = yield* replacement(journal, "next");
        }
        if (variant === "stale-attempt") {
          yield* journal.advance({ type: "execution.recover-record", request: recovery });
        }
        if (variant === "unsafe-upgrade") {
          recovery.descriptor = {
            kind: "record",
            key: "same",
            retrySafety: { mode: "repeatable" },
          };
        }
        if (variant === "wrong-pull-index") {
          recovery.pullIndex = 1;
        }
        if (variant === "wrong-expected-epoch") {
          recovery.replacement = {
            ...recovery.replacement,
            expected: { ...recovery.replacement.expected, leaseEpoch: 99 },
          };
        }
        if (variant === "wrong-program") {
          recovery.replacement = {
            ...recovery.replacement,
            program: { ...recovery.replacement.program, id: "wrong" },
          };
        }
        if (variant === "wrong-head") {
          recovery.replacement = {
            ...recovery.replacement,
            expected: { ...recovery.replacement.expected, strandHeadDigest: "wrong" },
          };
        }
        if (variant === "invalid-lease") {
          recovery.replacement = { ...recovery.replacement, leaseDurationMs: 0 };
        }
        if (variant === "same-attachment") {
          recovery.replacement = { ...recovery.replacement, attachmentId: "first" };
        }
        if (variant === "stale-epoch") {
          yield* journal.advance({
            type: "execution.replace-attachment",
            request: { sessionId: "session", taskId: "root", attachmentId: "first" },
          });
        }
        if (variant === "wrong-pull") {
          recovery.pullId = "wrong";
        }
        if (variant === "wrong-descriptor") {
          recovery.descriptor = {
            kind: "record",
            key: "changed",
            retrySafety: { mode: "repeatable" },
          };
        }
        if (variant === "wrong-turn") {
          recovery.turnId = "wrong";
        }
        if (variant === "wrong-index") {
          recovery.actionIndex = 1;
        }
        if (variant === "invalid-capability") {
          recovery.programCapability = "invalid";
        }
        if (variant === "stale-attachment") {
          yield* journal.advance({
            type: "execution.bind-attachment",
            request: {
              sessionId: "session",
              taskId: "root",
              attachmentId: "replacement",
              executionEpoch: 1,
            },
          });
        }
        if (variant === "live-owner") {
          yield* journal.advance({
            type: "control.claim-activation",
            request: { sessionId: "session", ownerId: "competitor", leaseDurationMs: 30000 },
          });
        }
        if (variant === "cancelled") {
          yield* journal.advance({
            type: "execution.request-cancellation",
            request: { sessionId: "session", taskId: "root" },
          });
        }
        const before = yield* journal.readSession("session");
        let error: unknown;
        try {
          yield* journal.advance({ type: "execution.recover-record", request: recovery });
        } catch (caught) {
          error = caught;
        }
        expect(error).toBeDefined();
        expect(error).toMatchObject({
          code:
            variant === "invalid-capability"
              ? "invalid_resolution_capability"
              : [
                    "unsafe",
                    "unsafe-upgrade",
                    "wrong-descriptor",
                    "idempotent",
                    "non-record",
                  ].includes(variant)
                ? "invalid_descriptor"
                : [
                      "stale-attempt",
                      "invalid-capability",
                      "stale-attachment",
                      "live-owner",
                      "live-mandate",
                      "stale-epoch",
                    ].includes(variant)
                  ? "stale_program_capability"
                  : "invalid_command",
        });
        expect(yield* journal.readSession("session")).toEqual(before);
      } finally {
        yield* handle.close();
      }
    });
  });
});
