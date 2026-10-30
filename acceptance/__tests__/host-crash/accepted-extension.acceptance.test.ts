// @vitest-environment node
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createQueue, resource, run, scoped, sleep, spawn, type Operation } from "effection";
import { expect, it } from "vitest";
import {
  ANY_JSON_SCHEMA_DESCRIPTOR as schema,
  createPinnedDurableProgram,
  exactProgramKey,
  ProgramPeer,
  ProgramDriverRegistryContext,
  type DurableProgramManifest,
  type ReplayItem,
  type Mandate,
} from "@sweatpants/durable-execution";
import {
  createWorkflowProgramDriver,
  driveProgramDriverActivation,
  type JournalAuthorityContract,
  type EffectRouter,
} from "@sweatpants/journal-authority";
import type {
  AcceptedExtensionRequest,
  AcceptedExtensionObservation,
} from "../../../packages/journal-authority/src/contract/authority-contract.ts";
import type { ExecutionStore } from "@sweatpants/journal-authority/store";
import { openBetterSqliteStorage } from "@sweatpants/storage-sqlite/better-sqlite3";
import { digestCanonicalJson } from "@sweatpants/foundation";
import { useProgramRig } from "../../support/program.ts";

const root = resolve("../.artifacts/journal-rebuild/loop-4/extension-runs");
mkdirSync(root, { recursive: true });
const effect = {
  name: "observe",
  version: "1",
  inputSchema: schema,
  outputSchema: schema,
  retrySafety: { mode: "repeatable" as const },
};
const manifest: DurableProgramManifest = {
  programId: "accepted-extension",
  version: "1",
  digest: "c".repeat(64),
  inputSchema: schema,
  outputSchema: schema,
  effects: { observe: effect },
  elicits: {},
  capabilities: { durableEmissions: true, structuredChildren: true, replay: "strict" },
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
      payload: { type: string; outcomeDigest?: string; taskId?: string };
    }[];
  } finally {
    sql.close();
  }
}
function save(database: string, destination: string) {
  const sql = new DatabaseSync(database, { readOnly: true });
  try {
    sql.exec(`VACUUM INTO '${destination.replaceAll("'", "''")}'`);
  } finally {
    sql.close();
  }
}
const raceProfiles = [
  "normal",
  "duplicate",
  "cancel-ack",
  "terminal-ack",
  "owner-ack",
  "epoch",
  "group",
  "owner-after",
  "conflict",
  "precommit",
] as const;
const corruptionProfiles = ["anchor-digest", "anchor-identity", "gap", "receipt"] as const;
for (const profile of [...raceProfiles, ...corruptionProfiles]) {
  it(`${(raceProfiles as readonly string[]).includes(profile) ? "post-ack" : "extension"} SQLite ${profile}`, async () => {
    const directory = mkdtempSync(resolve(root, `${profile}-`));
    const database = resolve(directory, "authority.sqlite");
    const trace: { event: string; value: unknown }[] = [];
    const record = (event: string, value: unknown = null) => trace.push({ event, value });
    const events = (event: string) => trace.filter((entry) => entry.event === event);
    try {
      await run(function* () {
        const storage = yield* openBetterSqliteStorage(database, { initialize: true });
        const writer = yield* openBetterSqliteStorage(database);
        try {
          const store = storage.storage.executionStore;
          let injectCommit = false;
          let conflicted = false;
          let losingOffset: string | undefined;
          const wrapped: ExecutionStore = {
            ...store,
            *commitExecution(request) {
              if (
                injectCommit &&
                !conflicted &&
                (profile === "conflict" || profile === "precommit")
              ) {
                conflicted = true;
                record("draft", request);
                expect(
                  records(database).filter((row) => row.payload.type === "PullResolved"),
                ).toHaveLength(0);
                if (profile === "precommit") {
                  throw new Error("before-settlement-commit");
                }
                const draft = request.journalSegments
                  ?.flatMap((segment) => segment.entries)
                  .find(
                    (entry) =>
                      (entry as { payload?: { type?: string } }).payload?.type === "PullResolved",
                  );
                losingOffset = (draft as { offset: string }).offset;
                yield* second.advance({
                  type: "execution.open-task",
                  request: {
                    sessionId: "acceptance-program",
                    taskId: "conflict-sibling",
                    manifest,
                    input: null,
                    executionEpoch: 1,
                    turnId: "turn",
                    attachmentId: "second",
                    audience: "acceptance",
                  },
                });
                const losing = yield* store.commitExecution(request);
                record("losing", losing);
                expect(losing.status).toBe("control_conflict");
                expect(
                  records(database).filter((row) => row.payload.type === "PullResolved"),
                ).toHaveLength(0);
                return losing;
              }
              const result = yield* store.commitExecution(request);
              record("store", { request, result });
              return result;
            },
          };
          const tool = createPinnedDurableProgram(manifest, function* (_, context) {
            record("acquire");
            yield* resource(function* (provide) {
              try {
                yield* provide(undefined);
              } finally {
                record("release");
              }
            });
            yield* context.emit("before", null);
            const value = yield* context.effect(effect, null, { audience: "program-execution" });
            record("continued", value);
            if (profile !== "cancel-ack") {
              yield* context.emit("after", null);
            }
            return yield* context.record(
              { key: "last", retrySafety: { mode: "repeatable" } },
              function* () {
                record("last-attempt");
                return "done";
              },
            );
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
          const secondRig = yield* useProgramRig(writer.storage.executionStore, program, null);
          const second = secondRig.journal;
          yield* rig.journal.advance({
            type: "execution.open-task",
            request: {
              ...rig.attach,
              manifest,
              turnId: "turn",
              attachmentId: "unattached",
              audience: "acceptance",
            },
          });
          const real: JournalAuthorityContract = {
            command: rig.journal.advance.bind(rig.journal),
            query: rig.journal.query.bind(rig.journal),
          };
          let binds = 0;
          let settled = 0;
          let queries = 0;
          let lastMandate: Mandate | undefined;
          let competingMandate: Mandate | undefined;
          let firstRequest: AcceptedExtensionRequest | undefined;
          const acknowledged = createQueue<void, void>();
          const resumeAck = createQueue<void, void>();
          function* acquireOther(): Operation<Mandate> {
            const plan = yield* second.query({
              type: "forest.replay-plan",
              sessionId: rig.attach.sessionId,
            });
            const item = plan.replay.find(
              (candidate) => candidate.address.taskId === rig.attach.taskId,
            )!;
            expect(item).toBeDefined();
            const bound = yield* second.advance({
              type: "execution.bind-mandate",
              request: {
                address: item.address,
                strand: item.strand,
                program: item.program,
                attachmentId: "other",
                ownerId: "other",
                leaseDurationMs: 30000,
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
            record("other-bind", bound);
            expect(bound.status).toBe("bound");
            if (bound.status !== "bound") {
              throw new Error("other owner did not bind");
            }
            return bound.mandate;
          }
          const authority: JournalAuthorityContract = {
            *command(command) {
              if (command.type === "execution.bind-mandate") {
                binds++;
                if (binds === 2 && (profile === "epoch" || profile === "group")) {
                  command = {
                    ...command,
                    request: {
                      ...command.request,
                      expected: {
                        ...command.request.expected,
                        leaseEpoch:
                          command.request.expected.leaseEpoch + (profile === "epoch" ? 1 : 0),
                        forkGroupRevision:
                          command.request.expected.forkGroupRevision +
                          (profile === "group" ? 1 : 0),
                      },
                    },
                  };
                }
              }
              if (command.type === "execution.resolve-pull") {
                injectCommit = true;
              }
              let result;
              try {
                result = yield* real.command(command);
              } finally {
                injectCommit = false;
              }
              record("command", { command, result });
              if (command.type === "execution.bind-mandate" && "status" in (result as object)) {
                const bound = result as { status: string; mandate: Mandate };
                if (bound.status === "bound") {
                  lastMandate = bound.mandate;
                }
              }
              if (command.type === "execution.resolve-pull") {
                settled++;
                if (profile === "duplicate" && settled === 1) {
                  const duplicate = yield* real.command({
                    type: "execution.resolve-pull",
                    request: command.request,
                  });
                  record("duplicate", { first: result, second: duplicate });
                  expect(duplicate.status).toBe("duplicate");
                  if (duplicate.status !== "rejected") {
                    expect(duplicate.receipt.status).toBe("duplicate");
                  }
                  return duplicate as never;
                }
              }
              return result;
            },
            *query(query) {
              // The old boundary is observed only for the separately frozen baseline run.
              const warm =
                query.type === "task.accepted-extension" ||
                (query.type === "forest.replay-plan" && settled > 0);
              if (!warm) {
                return yield* real.query(query);
              }
              queries++;
              expect(events("ack-exit")).toHaveLength(1);
              record("observe-start", query);
              if (query.type === "task.accepted-extension") {
                firstRequest ??= structuredClone(query.request);
                writeFileSync(
                  resolve(directory, `request-${queries}.json`),
                  JSON.stringify(query.request),
                );
                save(database, resolve(directory, `observation-${queries}.sqlite`));
              }
              let result;
              try {
                result = yield* real.query(query);
              } catch (error) {
                record("observation-error", { code: (error as { code?: string }).code });
                throw error;
              }
              record("observed", result);
              if (profile === "owner-after" && queries === 1) {
                yield* acquireOther();
              }
              if (query.type !== "task.accepted-extension") {
                return result;
              }
              const extension = result as AcceptedExtensionObservation;
              if (queries === 1) {
                if (profile === "anchor-digest") {
                  return {
                    ...extension,
                    anchor: { ...extension.anchor, replayChainDigest: "0".repeat(64) },
                  } as never;
                }
                if (profile === "anchor-identity") {
                  return {
                    ...extension,
                    anchor: {
                      ...extension.anchor,
                      address: { ...extension.anchor.address, turnId: "other" },
                    },
                  } as never;
                }
                if (profile === "gap") {
                  return { ...extension, entries: extension.entries.toReversed() } as never;
                }
                if (profile === "receipt") {
                  return {
                    ...extension,
                    entries: extension.entries.map((entry) =>
                      entry.type === "operation"
                        ? { ...entry, receipt: { ...entry.receipt, resolutionOffset: "wrong" } }
                        : entry,
                    ),
                  } as never;
                }
              }
              return result;
            },
          };
          const effects: EffectRouter = {
            *route() {
              return "host";
            },
            *executeHost() {
              record("attempt");
              return profile === "duplicate"
                ? { status: "cancelled", partial: "discard" }
                : { status: "ok", value: "canonical" };
            },
            *acknowledge() {
              expect(
                records(database).filter((row) => row.payload.type === "PullResolved"),
              ).toHaveLength(1);
              expect(events("resume")).toHaveLength(0);
              record("ack-enter");
              acknowledged.add(undefined);
              yield* resumeAck.next();
              expect(events("resume")).toHaveLength(0);
              record("ack-exit");
            },
          };
          const mutator = yield* spawn(function* () {
            yield* acknowledged.next();
            yield* sleep(1);
            expect(events("observe-start")).toHaveLength(0);
            if (profile === "cancel-ack") {
              record(
                "mutation",
                yield* second.advance({
                  type: "execution.request-cancellation",
                  request: { sessionId: rig.attach.sessionId, taskId: rig.attach.taskId },
                }),
              );
            } else if (profile === "terminal-ack") {
              const other = yield* acquireOther();
              record(
                "mutation",
                yield* second.advance({
                  type: "execution.complete-task",
                  request: {
                    sessionId: rig.attach.sessionId,
                    taskId: rig.attach.taskId,
                    actionIndex: 2,
                    programCapability: other.programCapability,
                    outcome: { status: "ok", value: "other" },
                  },
                }),
              );
            } else if (profile === "owner-ack") {
              competingMandate = yield* acquireOther();
            }
            resumeAck.add(undefined);
          });
          let result: unknown;
          let failure: unknown;
          try {
            result = yield* scoped(function* () {
              const driver = program.createDriver();
              yield* ProgramPeer.around({
                *step([attachment, command], next) {
                  if (command.type === "resume") {
                    const committed = records(database).find(
                      (row) => row.offset === command.receipt.resolutionOffset,
                    );
                    expect(committed?.payload.type).toBe("PullResolved");
                    expect(committed?.payload.outcomeDigest).toBe(
                      digestCanonicalJson(command.outcome),
                    );
                    expect(command.receipt.status).toBe("accepted");
                    if (profile === "duplicate") {
                      expect(command.outcome).toEqual({ status: "cancelled" });
                    }
                    record("resume", command);
                  }
                  const step = yield* next(attachment, command);
                  record("frontier", step);
                  return step;
                },
                *shutdown([attachment, reason], next) {
                  record("shutdown", reason);
                  return yield* next(attachment, reason);
                },
              });
              return yield* ProgramDriverRegistryContext.with(
                new Map([["acceptance", driver]]),
                function* () {
                  return yield* driveProgramDriverActivation({
                    authority,
                    driver,
                    attach: rig.attach,
                    advancement: { effects },
                  });
                },
              );
            });
          } catch (error) {
            failure = error;
            record("error", { code: (error as { code?: string }).code, message: String(error) });
          } finally {
            yield* mutator.halt();
          }
          record("result", result);
          expect(events("attempt")).toHaveLength(1);
          expect(events("release")).toHaveLength(1);
          expect(events("shutdown")).toHaveLength(1);
          const persisted = records(database);
          if (profile === "normal" || profile === "conflict") {
            expect(failure).toBeUndefined();
            expect(result).toEqual({ state: "completed", value: "done" });
            expect(events("resume")).toHaveLength(2);
            expect(events("last-attempt")).toHaveLength(1);
            if (firstRequest) {
              const observations = events("observed").map(
                (event) => event.value as AcceptedExtensionObservation,
              );
              expect(observations[1].anchor.throughActionIndex).toBe(1);
              expect(observations[1].entries.map((entry) => entry.actionIndex)).toEqual([2, 3]);
            }
          } else if (profile === "duplicate" || profile === "cancel-ack") {
            expect(failure).toBeUndefined();
            expect(result).toEqual({ state: "cancelled" });
            expect(events("resume")).toHaveLength(1);
            expect(events("last-attempt")).toHaveLength(0);
            expect(persisted.filter((row) => row.payload.type === "PullResolved")).toHaveLength(1);
          } else {
            expect(failure).toBeDefined();
            expect(events("last-attempt")).toHaveLength(0);
            if (profile === "precommit") {
              expect(String(failure)).toContain("before-settlement-commit");
              expect(persisted.filter((row) => row.payload.type === "PullResolved")).toHaveLength(
                0,
              );
              expect(events("observe-start")).toHaveLength(0);
              expect(events("resume")).toHaveLength(0);
              expect(events("ack-enter")).toHaveLength(0);
            } else if (["epoch", "group", "owner-after"].includes(profile)) {
              expect(failure).toMatchObject({ code: "stale_activation" });
              expect(events("resume")).toHaveLength(1);
            } else if (profile === "terminal-ack") {
              expect(failure).toMatchObject({ code: "replay_diverged" });
              expect(events("resume")).toHaveLength(0);
              expect(persisted.some((row) => row.payload.type === "TaskClosed")).toBe(true);
              expect(persisted.some((row) => row.payload.type === "TaskOrphaned")).toBe(false);
              if (firstRequest) {
                expect(events("observation-error")[0].value).toEqual({ code: "replay_diverged" });
              }
            } else {
              expect(failure).toMatchObject({ code: "replay_diverged" });
              expect(events("resume")).toHaveLength(0);
              record(
                "inherited-orphan",
                persisted.filter((row) => row.payload.type === "TaskOrphaned"),
              );
              if (profile === "owner-ack") {
                expect(persisted.some((row) => row.payload.type === "TaskOrphaned")).toBe(false);
                const current = (yield* rig.journal.exportSnapshot()).sessions
                  .find(([id]) => id === rig.attach.sessionId)![1]
                  .execution.tasks.find((task) => task.taskId === rig.attach.taskId)!;
                expect(current.lifecycle.status).toBe("active");
                expect(current.execution.epoch).toBe(competingMandate!.lease.epoch);
                expect(current.execution.attachmentId).toBe(
                  competingMandate!.attachment.attachmentId,
                );
                expect(current.execution.liveLease).toMatchObject({
                  ownerId: competingMandate!.lease.ownerId,
                  epoch: competingMandate!.lease.epoch,
                  attachmentId: competingMandate!.attachment.attachmentId,
                });
              } else {
                expect(persisted.some((row) => row.payload.type === "TaskOrphaned")).toBe(true);
              }
            }
          }
          if (profile === "conflict") {
            expect(events("losing")).toHaveLength(1);
            expect(losingOffset).toBeDefined();
            expect(persisted.find((row) => row.offset === losingOffset)?.payload.type).toBe(
              "TaskOpened",
            );
            expect(
              events("resume").every(
                (event) =>
                  (event.value as { receipt: { resolutionOffset: string } }).receipt
                    .resolutionOffset !== losingOffset,
              ),
            ).toBe(true);
            expect(persisted.filter((row) => row.payload.type === "PullResolved")).toHaveLength(2);
          }
          expect(lastMandate).toBeDefined();
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

it("authenticates SQLite prefixes, stored receipts and multi-operation suffixes with an unchanged sibling", async () => {
  const directory = mkdtempSync(resolve(root, "query-"));
  const database = resolve(directory, "authority.sqlite");
  await run(function* () {
    const storage = yield* openBetterSqliteStorage(database, { initialize: true });
    try {
      const program = { manifest, createDriver: () => createWorkflowProgramDriver(new Map()) };
      const rig = yield* useProgramRig(storage.storage.executionStore, program, null);
      const journal = rig.journal;
      const sessionId = rig.attach.sessionId;
      const empty = new Map<string, ReplayItem>();
      for (const taskId of ["root", "sibling"]) {
        const opened = yield* journal.advance({
          type: "execution.open-task",
          request: {
            ...rig.attach,
            taskId,
            manifest,
            turnId: "turn",
            attachmentId: taskId,
            audience: "acceptance",
          },
        });
        const initial = yield* journal.query({ type: "forest.replay-plan", sessionId });
        empty.set(taskId, initial.replay.find((candidate) => candidate.address.taskId === taskId)!);
        for (let actionIndex = 0; actionIndex < 3; actionIndex++) {
          const reserved = yield* journal.advance({
            type: "execution.reserve-pull",
            request: {
              sessionId,
              taskId,
              turnId: "turn",
              actionIndex,
              pullIndex: actionIndex,
              descriptor: {
                kind: "record",
                key: `value-${actionIndex}`,
                retrySafety: { mode: "repeatable" },
              },
              programCapability: opened.programCapability,
            },
          });
          expect(reserved.status).toBe("authorized");
          if (reserved.status !== "authorized") {
            throw new Error("record not authorized");
          }
          const resolution = yield* journal.advance({
            type: "execution.resolve-pull",
            request: {
              capability: reserved.resolutionCapability,
              audience: "program-execution",
              outcome: { status: "ok", value: { taskId, actionIndex } },
            },
          });
          expect(resolution.status).toBe("accepted");
        }
      }
      const full = yield* journal.query({ type: "forest.replay-plan", sessionId });
      const item = full.replay.find((candidate) => candidate.address.taskId === "root")!;
      const seed = empty.get("root")!;
      const operation = item.replay[2];
      if (operation.type !== "operation") {
        throw new Error("expected real operation");
      }
      const request: AcceptedExtensionRequest = {
        anchor: {
          address: seed.address,
          strand: seed.strand,
          program: seed.program,
          replayChainSeed: seed.replayChainSeed,
          throughActionIndex: -1,
          replayChainDigest: seed.replayChainSeed,
        },
        settled: { actionIndex: 2, receipt: operation.receipt },
      };
      const before = records(database);
      const extension = yield* journal.query({ type: "task.accepted-extension", request });
      expect(extension.entries).toEqual(item.replay);
      expect(extension.plannedHead).toEqual(item.plannedHead);
      expect(extension.executionEpoch).toBe(item.executionEpoch);
      expect(extension.groupContext).toEqual(item.groupContext);
      const partial = {
        ...request,
        anchor: {
          ...request.anchor,
          throughActionIndex: 0,
          replayChainDigest: item.replay[0].entryDigest,
        },
      };
      const suffix = yield* journal.query({ type: "task.accepted-extension", request: partial });
      expect(suffix.entries).toEqual(item.replay.slice(1));
      for (const invalid of [
        { ...partial, anchor: { ...partial.anchor, replayChainDigest: "0".repeat(64) } },
        {
          ...partial,
          anchor: { ...partial.anchor, address: { ...partial.anchor.address, turnId: "wrong" } },
        },
        { ...partial, settled: { ...partial.settled, actionIndex: 1 } },
        {
          ...partial,
          settled: {
            ...partial.settled,
            receipt: { ...operation.receipt, resolutionOffset: "wrong" },
          },
        },
      ]) {
        let failure: unknown;
        try {
          yield* journal.query({ type: "task.accepted-extension", request: invalid });
        } catch (error) {
          failure = error;
        }
        expect(failure).toMatchObject({ code: "replay_diverged" });
      }
      expect(records(database)).toEqual(before);
      expect(yield* journal.query({ type: "forest.replay-plan", sessionId })).toEqual(full);
      writeFileSync(
        resolve(directory, "oracle.json"),
        JSON.stringify({ full, request, extension, partial, suffix }),
      );
      writeFileSync(
        resolve(directory, "snapshot.json"),
        JSON.stringify(yield* journal.exportSnapshot()),
      );
      save(database, resolve(directory, "fixed.sqlite"));
    } finally {
      yield* storage.close();
    }
  });
});

it("observes real structured fork revisions and rejects an unresolved parent", async () => {
  const directory = mkdtempSync(resolve(root, "fork-"));
  const database = resolve(directory, "authority.sqlite");
  await run(function* () {
    const storage = yield* openBetterSqliteStorage(database, { initialize: true });
    try {
      const childManifest = { ...manifest, programId: "extension-child", digest: "e".repeat(64) };
      const child = {
        id: childManifest.programId,
        version: "1",
        digest: childManifest.digest,
        input: null,
      };
      const parent = createPinnedDurableProgram(manifest, function* (_, context) {
        return yield* context.pull({
          kind: "all",
          supervision: "one_for_all",
          children: [child, child],
          expiry: { kind: "after", durationMs: 30000 },
        });
      });
      const childTool = createPinnedDurableProgram(childManifest, function* (_, context) {
        return yield* context.record(
          { key: "child", retrySafety: { mode: "repeatable" } },
          function* () {
            return "child";
          },
        );
      });
      const program = {
        manifest,
        createDriver: () =>
          createWorkflowProgramDriver(
            new Map([
              [
                exactProgramKey({ id: manifest.programId, version: "1", digest: manifest.digest }),
                parent,
              ],
              [exactProgramKey(child), childTool],
            ]),
          ),
      };
      const rig = yield* useProgramRig(storage.storage.executionStore, program, null);
      const journal = rig.journal;
      const sessionId = rig.attach.sessionId;
      yield* journal.advance({
        type: "execution.open-task",
        request: {
          ...rig.attach,
          manifest,
          turnId: "turn",
          attachmentId: "parent",
          audience: "acceptance",
        },
      });
      const initial = (yield* journal.query({ type: "forest.replay-plan", sessionId })).replay[0];
      const parked = yield* rig.advance();
      expect(parked.state).toBe("parked");
      if (parked.state !== "parked") {
        throw new Error("parent not parked");
      }
      const group = yield* journal.advance({
        type: "execution.open-fork-group",
        request: {
          sessionId,
          turnId: "turn",
          parentTaskId: "root",
          parentPullId: parked.pullId,
          members: [
            { child, manifest: childManifest, route: rig.attach.route },
            { child, manifest: childManifest, route: rig.attach.route },
          ],
          executionEpoch: 1,
          audience: "acceptance",
        },
      });
      expect(group.status).toBe("opened");
      const observed: AcceptedExtensionObservation[] = [];
      const authority: JournalAuthorityContract = {
        command: journal.advance.bind(journal),
        *query(query) {
          const result = yield* journal.query(query);
          if (query.type === "task.accepted-extension") {
            observed.push(result as AcceptedExtensionObservation);
          }
          return result;
        },
      };
      for (const taskId of group.memberTaskIds) {
        const driver = program.createDriver();
        const result = yield* ProgramDriverRegistryContext.with(
          new Map([["acceptance", driver]]),
          function* () {
            return yield* driveProgramDriverActivation({
              authority,
              driver,
              attach: { ...rig.attach, taskId, program: child },
              advancement: {},
            });
          },
        );
        expect(result).toEqual({ state: "completed", value: "child" });
        if (observed.length === 1) {
          const receipt = observed[0].entries.find((entry) => entry.type === "operation")!;
          if (receipt.type !== "operation") {
            throw new Error("missing operation");
          }
          let failure: unknown;
          try {
            yield* journal.query({
              type: "task.accepted-extension",
              request: {
                anchor: {
                  address: initial.address,
                  strand: initial.strand,
                  program: initial.program,
                  replayChainSeed: initial.replayChainSeed,
                  throughActionIndex: -1,
                  replayChainDigest: initial.replayChainSeed,
                },
                settled: { actionIndex: 0, receipt: receipt.receipt },
              },
            });
          } catch (error) {
            failure = error;
          }
          expect(failure).toMatchObject({ code: "replay_diverged" });
          writeFileSync(
            resolve(directory, "unresolved-snapshot.json"),
            JSON.stringify(yield* journal.exportSnapshot()),
          );
        }
      }
      expect(observed).toHaveLength(2);
      expect(observed[0].groupContext).toEqual({
        groupId: group.groupId,
        groupRevision: 1,
        parentTaskId: "root",
      });
      expect(observed[1].groupContext.groupRevision).toBeGreaterThan(1);
      const full = yield* journal.query({ type: "forest.replay-plan", sessionId });
      const parentItem = full.replay.find((candidate) => candidate.address.taskId === "root")!;
      const entry = parentItem.replay[0];
      if (entry.type !== "operation") {
        throw new Error("group did not settle");
      }
      const request: AcceptedExtensionRequest = {
        anchor: {
          address: initial.address,
          strand: initial.strand,
          program: initial.program,
          replayChainSeed: initial.replayChainSeed,
          throughActionIndex: -1,
          replayChainDigest: initial.replayChainSeed,
        },
        settled: { actionIndex: 0, receipt: entry.receipt },
      };
      const extension = yield* journal.query({ type: "task.accepted-extension", request });
      expect(extension.entries).toEqual(parentItem.replay);
      expect(extension.groupContext).toEqual(parentItem.groupContext);
      expect(extension.groupContext.groupRevision).toBeGreaterThan(
        observed[1].groupContext.groupRevision,
      );
      writeFileSync(
        resolve(directory, "oracle.json"),
        JSON.stringify({ full, request, extension, observed }),
      );
      writeFileSync(
        resolve(directory, "snapshot.json"),
        JSON.stringify(yield* journal.exportSnapshot()),
      );
    } finally {
      yield* storage.close();
    }
  });
});
