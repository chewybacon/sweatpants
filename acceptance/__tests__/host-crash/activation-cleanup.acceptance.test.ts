// @vitest-environment node
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resource, run, scoped, sleep, type Operation } from "effection";
import { expect, it } from "vitest";
import {
  ANY_JSON_SCHEMA_DESCRIPTOR as schema,
  CrankError,
  createPinnedDurableProgram,
  exactProgramKey,
  ProgramPeer,
  ProgramDriverRegistryContext,
  type DurableProgramManifest,
  type Mandate,
} from "@sweatpants/durable-execution";
import {
  createWorkflowProgramDriver,
  driveProgramDriverActivation,
  type JournalAuthorityContract,
} from "@sweatpants/journal-authority";
import type { OrphanFence } from "../../../packages/journal-authority/src/contract/authority-contract.ts";
import type { ExecutionStore } from "@sweatpants/journal-authority/store";
import { openBetterSqliteStorage } from "@sweatpants/storage-sqlite/better-sqlite3";
import { useProgramRig } from "../../support/program.ts";

const root = resolve("../.artifacts/journal-rebuild/loop-4/cleanup-runs");
mkdirSync(root, { recursive: true });
const effect = {
  name: "cleanup",
  version: "1",
  inputSchema: schema,
  outputSchema: schema,
  retrySafety: { mode: "repeatable" as const },
};
const manifest: DurableProgramManifest = {
  programId: "activation-cleanup",
  version: "1",
  digest: "e".repeat(64),
  inputSchema: schema,
  outputSchema: schema,
  effects: { cleanup: effect },
  elicits: {},
  capabilities: { durableEmissions: false, structuredChildren: false, replay: "strict" },
};
function records(database: string) {
  const sql = new DatabaseSync(database, { readOnly: true });
  try {
    expect(sql.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    return sql
      .prepare("SELECT entries_json FROM sp_execution_journal_segments ORDER BY first_sequence")
      .all()
      .flatMap((row) => JSON.parse(String(row.entries_json))) as {
      offset: string;
      payload: { type: string };
    }[];
  } finally {
    sql.close();
  }
}
for (const profile of [
  "live-successor",
  "released-successor",
  "cas-successor",
  "orphan-error",
  "primary-shutdown",
  "success-shutdown",
  "ack-shutdown",
  "release-error",
  "ack-code",
  "guards",
  "cold",
  "cold-retained",
] as const) {
  it(`owns SQLite activation cleanup ${profile}`, async () => {
    const directory = mkdtempSync(resolve(root, `${profile}-`));
    const database = resolve(directory, "authority.sqlite");
    const trace: { event: string; value: unknown }[] = [];
    const record = (event: string, value: unknown = null) => trace.push({ event, value });
    let primary = new CrankError("replay_diverged", "known observation divergence");
    const secondary = new Error("secondary cleanup failure");
    let diverge = false;
    let attempts = 0,
      disposals = 0,
      shutdowns = 0;
    try {
      await run(function* () {
        const storage = yield* openBetterSqliteStorage(database, { initialize: true });
        const writer = yield* openBetterSqliteStorage(database);
        try {
          let conflict = false;
          let competitor: Mandate | undefined;
          const store = storage.storage.executionStore;
          const wrapped: ExecutionStore = {
            ...store,
            *commitExecution(request) {
              if (
                profile === "cas-successor" &&
                !conflict &&
                request.journalSegments?.some((segment) =>
                  segment.entries.some(
                    (entry) =>
                      (entry as { payload?: { type?: string } }).payload?.type === "TaskOrphaned",
                  ),
                )
              ) {
                conflict = true;
                record("losing-draft", request);
                competitor = yield* acquireOther();
                const result = yield* store.commitExecution(request);
                record("real-cas", result);
                expect(result.status).toBe("control_conflict");
                expect(
                  records(database).some((entry) => entry.payload.type === "TaskOrphaned"),
                ).toBe(false);
                return result;
              }
              return yield* store.commitExecution(request);
            },
          };
          const tool = createPinnedDurableProgram(manifest, function* (_, context) {
            yield* resource(function* (provide) {
              try {
                yield* provide(undefined);
              } finally {
                disposals++;
                record("dispose");
              }
            });
            return yield* context.effect(effect, diverge ? "changed" : null, {
              audience: "program-execution",
            });
          });
          const program = {
            manifest,
            createDriver: () =>
              createWorkflowProgramDriver(
                new Map([
                  [
                    exactProgramKey({
                      id: manifest.programId,
                      version: manifest.version,
                      digest: manifest.digest,
                    }),
                    tool,
                  ],
                ]),
              ),
          };
          const rig = yield* useProgramRig(wrapped, program, null);
          const second = (yield* useProgramRig(writer.storage.executionStore, program, null))
            .journal;
          yield* rig.journal.advance({
            type: "execution.open-task",
            request: {
              ...rig.attach,
              manifest,
              turnId: "turn",
              attachmentId: "initial",
              audience: "acceptance",
            },
          });
          function* acquireOther(
            taskId = rig.attach.taskId,
            leaseDurationMs = 30000,
          ): Operation<Mandate> {
            const plan = yield* second.query({
              type: "forest.replay-plan",
              sessionId: rig.attach.sessionId,
            });
            const item = plan.replay.find((item) => item.address.taskId === taskId)!;
            const result = yield* second.advance({
              type: "execution.bind-mandate",
              request: {
                address: item.address,
                strand: item.strand,
                program: item.program,
                attachmentId: "successor",
                ownerId: "successor",
                leaseDurationMs,
                placement: {
                  route: { kind: "local", driverKind: "acceptance", route: rig.attach.route },
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
            expect(result.status).toBe("bound");
            if (result.status !== "bound") {
              throw new Error("successor bind failed");
            }
            record("successor", result.mandate);
            return result.mandate;
          }
          const real: JournalAuthorityContract = {
            command: rig.journal.advance.bind(rig.journal),
            query: rig.journal.query.bind(rig.journal),
          };
          let last: Mandate | undefined;
          let guarded = 0;
          const authority: JournalAuthorityContract = {
            *command(command) {
              record("command", command);
              if (command.type === "execution.force-orphan") {
                throw new Error("automatic force orphan forbidden");
              }
              if (command.type === "execution.orphan-if-current") {
                guarded++;
                expect(command.request.fence.executionEpoch).toBe(last!.lease.epoch);
                if (profile === "live-successor" || profile === "released-successor") {
                  competitor = yield* acquireOther();
                  if (profile === "released-successor") {
                    yield* second.advance({
                      type: "execution.release-mandate",
                      request: { mandate: competitor, reason: "scope_exit" },
                    });
                  }
                }
                if (profile === "orphan-error") {
                  record("secondary", String(secondary));
                  throw secondary;
                }
              }
              if (command.type === "execution.release-mandate" && profile === "release-error") {
                expect(command.request.mandate).toEqual(last);
                record("secondary", String(secondary));
                throw secondary;
              }
              const result = yield* real.command(command);
              if (
                command.type === "execution.bind-mandate" &&
                (result as { status?: string }).status === "bound"
              ) {
                last = (result as { mandate: Mandate }).mandate;
              }
              record("command-result", { type: command.type, result });
              return result;
            },
            *query(query) {
              const result = yield* real.query(query);
              if (
                query.type === "task.accepted-extension" &&
                !["success-shutdown", "guards"].includes(profile)
              ) {
                try {
                  yield* real.query({
                    type: "task.accepted-extension",
                    request: {
                      ...query.request,
                      anchor: { ...query.request.anchor, replayChainDigest: "0".repeat(64) },
                    },
                  });
                } catch (error) {
                  expect(error).toBeInstanceOf(CrankError);
                  primary = error as CrankError;
                  record("primary", { code: primary.code, message: primary.message });
                  throw primary;
                }
                throw new Error("corrupt anchor unexpectedly accepted");
              }
              return result;
            },
          };
          function* activate(): Operation<unknown> {
            return yield* scoped(function* () {
              const driver = program.createDriver();
              yield* ProgramPeer.around({
                *shutdown(args, next) {
                  shutdowns++;
                  record("shutdown", args[1]);
                  yield* next(...args);
                  if (["primary-shutdown", "success-shutdown", "ack-shutdown"].includes(profile)) {
                    record("secondary", String(secondary));
                    throw secondary;
                  }
                },
              });
              return yield* ProgramDriverRegistryContext.with(
                new Map([["acceptance", driver]]),
                function* () {
                  return yield* driveProgramDriverActivation({
                    authority,
                    driver,
                    attach: rig.attach,
                    advancement: {
                      effects: {
                        *route() {
                          return "host" as const;
                        },
                        *executeHost() {
                          attempts++;
                          return { status: "ok" as const, value: "canonical" };
                        },
                        *acknowledge() {
                          if (
                            ["ack-shutdown", "ack-code", "cold", "cold-retained"].includes(profile)
                          ) {
                            throw primary;
                          }
                        },
                      },
                    },
                  });
                },
              );
            });
          }
          let failure: unknown;
          if (profile === "release-error") {
            const query = authority.query;
            authority.query = function* (request) {
              if (request.type === "task.cancellation-state") {
                throw primary;
              }
              return yield* query(request);
            };
          }
          try {
            yield* activate();
          } catch (error) {
            failure = error;
          }
          expect(shutdowns).toBe(1);
          expect(disposals).toBe(1);
          expect(failure).toBe(
            profile === "success-shutdown" ? secondary : profile === "guards" ? undefined : primary,
          );
          const beforeRecovery = records(database);
          expect(guarded).toBe(
            [
              "success-shutdown",
              "ack-shutdown",
              "ack-code",
              "release-error",
              "guards",
              "cold",
              "cold-retained",
            ].includes(profile)
              ? 0
              : 1,
          );
          expect(beforeRecovery.some((entry) => entry.payload.type === "TaskOrphaned")).toBe(
            profile === "primary-shutdown",
          );
          expect(attempts).toBe(profile === "release-error" ? 0 : 1);
          record("snapshot", yield* rig.journal.exportSnapshot());
          if (competitor) {
            const current = (yield* second.exportSnapshot()).sessions[0][1].execution.tasks.find(
              (task) => task.taskId === "root",
            )!;
            expect(current.lifecycle.status).toBe("active");
            expect(current.execution.epoch).toBe(competitor.lease.epoch);
            expect(current.execution.attachmentId).toBe(competitor.attachment.attachmentId);
            expect(current.execution.liveLease?.ownerId).toBe(
              profile === "released-successor" ? undefined : "successor",
            );
            if (profile === "released-successor") {
              competitor = yield* acquireOther();
            }
            const completed = yield* second.advance({
              type: "execution.mandate-complete",
              request: { mandate: competitor, outcome: { status: "ok", value: "successor" } },
            });
            record("successor-action", completed);
            expect(completed.status).not.toBe("rejected");
          }
          if (["orphan-error", "ack-shutdown", "ack-code"].includes(profile)) {
            expect(yield* rig.advance()).toEqual({ state: "completed", value: "canonical" });
            expect(attempts).toBe(1);
            expect(records(database).slice(0, beforeRecovery.length)).toEqual(beforeRecovery);
          }
          if (profile === "guards") {
            const fence: OrphanFence = {
              address: last!.address,
              program: last!.program,
              executionEpoch: last!.lease.epoch,
              forkGroupRevision: last!.groupContext.groupRevision,
            };
            const before = records(database);
            expect(
              yield* real.command({
                type: "execution.orphan-if-current",
                request: { fence, reason: "replay_diverged" },
              }),
            ).toEqual({ status: "stale" });
            expect(records(database)).toEqual(before);
            // A separate active task exercises public stale guards and manual force semantics.
            yield* rig.journal.advance({
              type: "execution.open-task",
              request: {
                ...rig.attach,
                taskId: "guard",
                manifest,
                turnId: "turn",
                attachmentId: "guard",
                audience: "acceptance",
              },
            });
            const plan = yield* real.query({
              type: "forest.replay-plan",
              sessionId: rig.attach.sessionId,
            });
            const item = plan.replay.find((item) => item.address.taskId === "guard")!;
            const good: OrphanFence = {
              address: item.address,
              program: item.program,
              executionEpoch: item.executionEpoch,
              forkGroupRevision: item.groupContext.groupRevision,
            };
            const prefix = records(database);
            for (const stale of [
              { ...good, address: { ...good.address, taskId: "absent" } },
              { ...good, address: { ...good.address, sessionId: "absent" } },
              { ...good, address: { ...good.address, turnId: "wrong" } },
              { ...good, program: { ...good.program, digest: "0".repeat(64) } },
              { ...good, executionEpoch: good.executionEpoch + 1 },
              { ...good, forkGroupRevision: good.forkGroupRevision + 1 },
            ]) {
              expect(
                yield* real.command({
                  type: "execution.orphan-if-current",
                  request: { fence: stale, reason: "replay_diverged" },
                }),
              ).toEqual({ status: "stale" });
              expect(records(database)).toEqual(prefix);
            }
            const retained = yield* acquireOther("guard", 1);
            const retainedFence = { ...good, executionEpoch: retained.lease.epoch };
            const retainedPrefix = records(database);
            expect(
              yield* real.command({
                type: "execution.orphan-if-current",
                request: { fence: retainedFence, reason: "replay_diverged" },
              }),
            ).toEqual({ status: "stale" });
            yield* sleep(3);
            expect(
              yield* real.command({
                type: "execution.orphan-if-current",
                request: { fence: retainedFence, reason: "replay_diverged" },
              }),
            ).toEqual({ status: "stale" });
            expect(records(database)).toEqual(retainedPrefix);
            yield* real.command({
              type: "execution.release-mandate",
              request: { mandate: retained, reason: "scope_exit" },
            });
            const orphanPrefix = records(database);
            expect(
              yield* real.command({
                type: "execution.orphan-if-current",
                request: { fence: retainedFence, reason: "replay_diverged" },
              }),
            ).toEqual({ status: "orphaned" });
            const suffix = records(database).slice(orphanPrefix.length);
            expect(suffix.map((entry) => entry.payload.type)).toEqual([
              "CleanupSkipped",
              "TaskOrphaned",
            ]);
            expect(suffix.map((entry) => Number(entry.offset))).toEqual([
              orphanPrefix.length,
              orphanPrefix.length + 1,
            ]);
          }
          if (profile === "release-error") {
            const state = (yield* rig.journal.exportSnapshot()).sessions[0][1].execution.tasks[0];
            const fence: OrphanFence = {
              address: last!.address,
              program: last!.program,
              executionEpoch: last!.lease.epoch,
              forkGroupRevision: last!.groupContext.groupRevision,
            };
            expect(state.execution.liveLease).toBeDefined();
            expect(
              yield* real.command({
                type: "execution.orphan-if-current",
                request: { fence, reason: "replay_diverged" },
              }),
            ).toEqual({ status: "stale" });
            expect(records(database)).toEqual(beforeRecovery);
            yield* real.command({
              type: "execution.force-orphan",
              request: {
                sessionId: rig.attach.sessionId,
                taskId: rig.attach.taskId,
                reason: "cleanup_stuck",
              },
            });
            expect(records(database).some((entry) => entry.payload.type === "TaskOrphaned")).toBe(
              true,
            );
          }
          if (profile === "cold" || profile === "cold-retained") {
            let retained: Mandate | undefined;
            if (profile === "cold-retained") {
              retained = yield* acquireOther(rig.attach.taskId, 1);
              yield* sleep(3);
            }
            const prefix = records(database);
            diverge = true;
            let coldFailure: unknown;
            try {
              yield* rig.advance();
            } catch (error) {
              coldFailure = error;
            }
            expect(coldFailure).toMatchObject({ code: "replay_diverged" });
            expect(disposals).toBe(2);
            expect(attempts).toBe(1);
            expect(records(database).slice(0, prefix.length)).toEqual(prefix);
            expect(records(database).some((entry) => entry.payload.type === "TaskOrphaned")).toBe(
              profile === "cold",
            );
            if (retained) {
              expect(records(database)).toEqual(prefix);
              const current = (yield* rig.journal.exportSnapshot()).sessions[0][1].execution
                .tasks[0];
              expect(current.lifecycle.status).toBe("active");
              expect(current.execution.epoch).toBe(retained.lease.epoch);
              expect(current.execution.liveLease).toMatchObject({
                ownerId: retained.lease.ownerId,
                epoch: retained.lease.epoch,
                attachmentId: retained.attachment.attachmentId,
              });
            }
          }
          record("final-snapshot", yield* rig.journal.exportSnapshot());
        } finally {
          yield* writer.close();
          yield* storage.close();
        }
      });
    } finally {
      writeFileSync(resolve(directory, "trace.json"), JSON.stringify(trace, null, 2));
    }
  });
}
