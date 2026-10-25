// @vitest-environment node
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resource, run, scoped, type Operation } from "effection";
import { expect, it } from "vitest";
import {
  ANY_JSON_SCHEMA_DESCRIPTOR as schema,
  createPinnedDurableProgram,
  exactProgramKey,
  ProgramPeer,
  ProgramDriverRegistryContext,
  type ReplayEntry,
  type DurableProgramManifest,
} from "@sweatpants/durable-execution";
import {
  createWorkflowProgramDriver,
  driveProgramDriverActivation,
  type JournalAuthorityContract,
  type EffectRouter,
} from "@sweatpants/journal-authority";
import type { AcceptedExtensionObservation } from "../../../packages/journal-authority/src/contract/authority-contract.ts";
import { RetryableEffectAcknowledgement } from "../../../packages/journal-authority/src/workflow/advancement-ports.ts";
import { openBetterSqliteStorage } from "@sweatpants/storage-sqlite/better-sqlite3";
import {
  digestCanonicalJson,
  encodeCanonicalJson,
  sha256,
  type Json,
} from "@sweatpants/foundation";
import { useProgramRig } from "../../support/program.ts";

const root = resolve("../.artifacts/journal-rebuild/loop-3/candidate-advancement");
mkdirSync(root, { recursive: true });
const effect = {
  name: "observe",
  version: "1",
  inputSchema: schema,
  outputSchema: schema,
  retrySafety: { mode: "repeatable" as const },
};
const manifest: DurableProgramManifest = {
  programId: "advancement",
  version: "1",
  digest: "b".repeat(64),
  inputSchema: schema,
  outputSchema: schema,
  effects: { observe: effect },
  elicits: {},
  capabilities: { durableEmissions: true, structuredChildren: false, replay: "strict" },
};
const faults = [
  "none",
  "reject",
  "delivery",
  "ack-error",
  "ack-retry",
  "chain",
  "frontier",
  "skip-operation",
  "bind",
  "normalized",
] as const;

function rechained(
  item: AcceptedExtensionObservation,
  entries: ReplayEntry[],
): AcceptedExtensionObservation {
  let previous = item.anchor.replayChainDigest;
  const replay = entries.map((entry) => {
    const { entryDigest: _, ...body } = { ...entry, previousEntryDigest: previous };
    const entryDigest = sha256(
      encodeCanonicalJson({
        replayChainSeed: item.anchor.replayChainSeed,
        previousEntryDigest: previous,
        entryWithoutEntryDigest: body as unknown as Json,
      }),
    );
    previous = entryDigest;
    return { ...body, entryDigest };
  });
  return { ...item, entries: replay, replayChainDigest: previous };
}

for (const fault of faults) {
  it(`advances real SQLite accepted boundaries with ${fault}`, async () => {
    const directory = mkdtempSync(resolve(root, `${fault}-`));
    const trace: { event: string; value: unknown }[] = [];
    const record = (event: string, value: unknown = null) => trace.push({ event, value });
    const events = (event: string) => trace.filter((entry) => entry.event === event);
    const database = resolve(directory, "authority.sqlite");
    const sqlRecords = () => {
      const sql = new DatabaseSync(database, { readOnly: true });
      try {
        expect(sql.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
        return sql
          .prepare("SELECT entries_json FROM sp_execution_journal_segments ORDER BY first_sequence")
          .all()
          .flatMap((row) => JSON.parse(String(row.entries_json))) as {
          offset: string;
          payload: { type: string; outcome?: unknown; outcomeDigest?: string };
        }[];
      } finally {
        sql.close();
      }
    };
    try {
      await run(function* () {
        const storage = yield* openBetterSqliteStorage(database, { initialize: true });
        try {
          const tool = createPinnedDurableProgram(manifest, function* (_, context) {
            record("acquire");
            yield* resource(function* (provide) {
              try {
                yield* provide(undefined);
              } finally {
                record("release");
              }
            });
            yield* context.emit("before", { value: 0 });
            const value =
              fault.startsWith("ack") || fault === "normalized"
                ? yield* context.effect(effect, null, { audience: "program-execution" })
                : yield* context.record(
                    { key: "value", retrySafety: { mode: "repeatable" } },
                    function* () {
                      record("attempt");
                      return "canonical-value";
                    },
                  );
            record("continued", value);
            yield* context.emit("after", { value });
            try {
              yield* context.record(
                { key: "failure", retrySafety: { mode: "repeatable" } },
                function* () {
                  record("failure-attempt");
                  throw new Error("authored-error");
                },
              );
            } catch (error) {
              record("caught", error instanceof Error ? error.message : String(error));
            }
            const last = yield* context.record(
              { key: "last", retrySafety: { mode: "repeatable" } },
              function* () {
                record("last-attempt");
                return "done";
              },
            );
            return last;
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
          const rig = yield* useProgramRig(storage.storage.executionStore, program, null);
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
          let injected = false;
          let binds = 0;
          const real: JournalAuthorityContract = {
            command: rig.journal.advance.bind(rig.journal),
            query: rig.journal.query.bind(rig.journal),
          };
          const authority: JournalAuthorityContract = {
            *command(command) {
              record("command", command);
              if (command.type === "execution.bind-mandate" && ++binds === 2 && fault === "bind") {
                injected = true;
                command = {
                  ...command,
                  request: {
                    ...command.request,
                    expected: { ...command.request.expected, strandHeadDigest: "0".repeat(64) },
                  },
                };
              }
              if (command.type === "execution.resolve-pull" && fault === "reject" && !injected) {
                injected = true;
                command = {
                  ...command,
                  request: { ...command.request, audience: "wrong-audience" },
                };
              }
              const result = yield* real.command(command);
              record("committed", { command: command.type, result });
              return result;
            },
            *query(query) {
              if (query.type !== "task.accepted-extension") {
                return yield* real.query(query);
              }
              const result = yield* real.query({
                type: "task.accepted-extension",
                request: query.request,
              });
              record("query", { query, result });
              if (
                query.type === "task.accepted-extension" &&
                "entries" in result &&
                !injected &&
                result.entries.length
              ) {
                const item = result;
                let changed = item;
                if (fault === "chain") {
                  changed = { ...item, replayChainDigest: "0".repeat(64) };
                } else if (fault === "frontier") {
                  changed = rechained(
                    item,
                    item.entries.map((entry) =>
                      entry.type === "operation"
                        ? { ...entry, descriptorDigest: "0".repeat(64) }
                        : entry,
                    ),
                  );
                } else if (fault === "skip-operation") {
                  const operation = item.entries.find((entry) => entry.type === "operation")!;
                  changed = rechained(
                    item,
                    item.entries.map((entry, index) =>
                      index === 0 ? { ...operation, actionIndex: entry.actionIndex } : entry,
                    ),
                  );
                }
                if (changed !== item) {
                  injected = true;
                  return changed as never;
                }
              }
              return result as never;
            },
          };
          const effects: EffectRouter = {
            *route() {
              return "host";
            },
            *executeHost() {
              record("attempt");
              return fault === "normalized"
                ? { status: "cancelled", partial: "discard-me" }
                : { status: "ok", value: "canonical-value" };
            },
            *acknowledge(request) {
              const persisted = sqlRecords();
              expect(persisted.some((entry) => entry.payload.type === "PullResolved")).toBe(true);
              expect(events("resume")).toHaveLength(0);
              record("ack", request);
              if (!injected) {
                if (fault === "ack-error") {
                  injected = true;
                  throw new Error("ordinary-ack-error");
                }
                if (fault === "ack-retry") {
                  injected = true;
                  throw new RetryableEffectAcknowledgement();
                }
              }
            },
          };
          function* activate(
            observed: JournalAuthorityContract,
            interrupt: boolean,
          ): Operation<unknown> {
            return yield* scoped(function* () {
              const driver = program.createDriver();
              yield* ProgramPeer.around({
                *step([attachment, command], next) {
                  record("step", { attachmentId: attachment.attachmentId, command });
                  if (command.type === "resume") {
                    const persisted = sqlRecords();
                    const accepted = persisted.find(
                      (entry) => entry.offset === command.receipt.resolutionOffset,
                    );
                    expect(accepted?.payload.type).toBe("PullResolved");
                    expect(accepted?.payload.outcomeDigest).toBe(command.receipt.outcomeDigest);
                    expect(digestCanonicalJson(command.outcome)).toBe(
                      command.receipt.outcomeDigest,
                    );
                    record("resume", command);
                    if (fault === "normalized") {
                      expect(command.outcome).toEqual({ status: "cancelled" });
                    }
                    if (interrupt && fault === "delivery" && !injected) {
                      injected = true;
                      throw new Error("delivery-interrupted");
                    }
                  }
                  const step = yield* next(attachment, command);
                  record("frontier", step);
                  return step;
                },
                *shutdown([attachment, reason], next) {
                  record("shutdown", { attachmentId: attachment.attachmentId, reason });
                  return yield* next(attachment, reason);
                },
              });
              return yield* ProgramDriverRegistryContext.with(
                new Map([["acceptance", driver]]),
                function* () {
                  return yield* driveProgramDriverActivation({
                    authority: observed,
                    driver,
                    attach: rig.attach,
                    advancement: { effects },
                  });
                },
              );
            });
          }
          let result: unknown;
          let failure: unknown;
          try {
            result = yield* activate(authority, true);
          } catch (error) {
            failure = error;
            record("error", { message: String(error), code: (error as { code?: string }).code });
          }
          record("result", result);
          const firstRecords = sqlRecords();
          writeFileSync(
            resolve(directory, "first-records.json"),
            JSON.stringify(firstRecords, null, 2),
          );
          if (["none", "ack-retry"].includes(fault)) {
            expect(failure).toBeUndefined();
            expect(result).toEqual({ state: "completed", value: "done" });
            expect(events("acquire")).toHaveLength(1);
            expect(events("attempt")).toHaveLength(1);
            expect(events("continued").map((entry) => entry.value)).toEqual(["canonical-value"]);
            expect(events("caught")).toHaveLength(1);
            expect(events("last-attempt")).toHaveLength(1);
            const deliveries = events("step")
              .map(
                (entry) =>
                  (entry.value as { command: { type: string; actionIndex: number } }).command,
              )
              .filter((command) => command.type === "resume" || command.type === "ack_emission");
            expect(deliveries.map((command) => command.actionIndex)).toEqual([0, 1, 2, 3, 4]);
            expect(
              events("resume").map((entry) => (entry.value as { replayed: boolean }).replayed),
            ).toEqual([fault === "ack-retry", false, false]);
          } else if (fault === "normalized") {
            expect(failure).toBeUndefined();
            expect(result).toEqual({ state: "cancelled" });
            expect(events("attempt")).toHaveLength(1);
            expect(events("resume")).toHaveLength(1);
            expect(events("continued")).toHaveLength(0);
          } else {
            expect(failure).toBeDefined();
            expect(events("attempt")).toHaveLength(1);
            expect(events("last-attempt")).toHaveLength(0);
            expect(events("continued")).toHaveLength(fault === "bind" ? 1 : 0);
            if (["chain", "frontier", "skip-operation"].includes(fault)) {
              expect(failure).toMatchObject({ code: "replay_diverged" });
              expect(firstRecords.some((entry) => entry.payload.type === "TaskOrphaned")).toBe(
                true,
              );
            }
            if (fault === "bind") {
              expect(failure).toMatchObject({ code: "stale_activation" });
            }
            if (fault === "reject") {
              expect(
                firstRecords.filter((entry) => entry.payload.type === "PullResolved"),
              ).toHaveLength(0);
              expect(events("resume")).toHaveLength(0);
            }
            if (fault === "delivery" || fault === "ack-error") {
              expect(
                firstRecords.filter((entry) => entry.payload.type === "PullResolved"),
              ).toHaveLength(1);
              expect(events("release")).toHaveLength(1);
              expect(events("resume")).toHaveLength(fault === "delivery" ? 1 : 0);
              const recovered = yield* activate(real, false);
              expect(recovered).toEqual({ state: "completed", value: "done" });
              expect(events("attempt")).toHaveLength(1);
              expect(events("continued").map((entry) => entry.value)).toEqual(["canonical-value"]);
              expect(sqlRecords().slice(0, firstRecords.length)).toEqual(firstRecords);
            }
          }
          expect(events("release")).toHaveLength(events("acquire").length);
          expect(events("shutdown")).toHaveLength(events("acquire").length);
        } finally {
          yield* storage.close();
        }
      });
    } finally {
      writeFileSync(resolve(directory, "trace.json"), JSON.stringify(trace, null, 2));
    }
  });
}
