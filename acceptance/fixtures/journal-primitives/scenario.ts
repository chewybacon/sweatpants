import { deepStrictEqual } from "node:assert";
import type { Mandate } from "@sweatpants/durable-execution";
import { BetterSqliteDatabase } from "@sweatpants/storage-sqlite/better-sqlite3";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import type {
  AuthorityCommand,
  JournalAuthorityContract,
  RecordRecoveryObservation,
} from "../../../packages/journal-authority/src/contract/authority-contract.ts";
import { openBetterSqliteStorageForTest } from "../../../packages/storage-sqlite/src/better-sqlite3.ts";
import { run } from "effection";
import { openBetterSqliteStorage } from "@sweatpants/storage-sqlite/better-sqlite3";
import { createJournal } from "../../../packages/journal-authority/src/shell/journal.ts";
import {
  signCapability,
  verifyResolutionCapability,
  createCapabilityKeyring,
} from "../../../packages/journal-authority/src/contract/capabilities.ts";
import { createDurableSchemaRegistry } from "@sweatpants/journal-authority/schema-registry";
import { createSchemaFixture, stringGuard } from "@sweatpants/journal-authority/testing";
import { createWorkflowProgramDriver } from "../../../packages/journal-authority/src/workflow/program-driver.ts";
import { driveProgramDriverActivation } from "../../../packages/journal-authority/src/workflow/driver-drive.ts";
import {
  driveSequentialJournal,
  type Computation,
} from "../../../packages/journal-authority/src/experimental/sequential-journal.ts";
import {
  createPinnedDurableProgram,
  createDurableToolRegistry,
  ProgramDriverRegistryContext,
  stableProgramAttachmentId,
  type DurableProgramManifest,
  type ForestReplayPlan,
} from "@sweatpants/durable-execution";

export type Engine = "candidate" | "reference" | "inspect";

class AcceptedBoundary extends Error {
  readonly status = 73;
}

/** A new journal, clock, driver and SQLite handle for every invocation.
 * Only the accepted-boundary hook can stop locally: it runs outside the engine's
 * failure cleanup. Unknown-outcome/permission loss MUST terminate a real process.
 */
export async function runScenario({
  engine,
  path,
  stop = -1,
  variant = "normal",
  recoverPending = false,
  interrupt = (status: number): never => {
    if (status !== 73) {
      throw new Error("Process-loss scenarios require the worker CLI");
    }
    throw new AcceptedBoundary();
  },
}: {
  engine: Engine;
  path: string;
  stop?: number;
  variant?: string;
  recoverPending?: boolean;
  interrupt?: (status: number) => never;
}): Promise<number> {
  const input = createSchemaFixture(
    "sequence/input",
    "program_input",
    { type: "string" },
    stringGuard,
  );
  const output = createSchemaFixture(
    "sequence/output",
    "program_output",
    { type: "string" },
    stringGuard,
  );
  const manifest: DurableProgramManifest = {
    programId: "sequence",
    version: "1",
    digest: "c".repeat(64),
    inputSchema: input.descriptor,
    outputSchema: output.descriptor,
    elicits: {},
    effects: {},
    capabilities: { durableEmissions: false, structuredChildren: false, replay: "strict" },
  };
  const attach = {
    sessionId: "session",
    taskId: "root",
    input: "hello",
    program: { id: manifest.programId, version: manifest.version, digest: manifest.digest },
    route: { driverKind: "program" },
    executionEpoch: 1,
  };
  let now = existsSync(`${path}.clock.json`)
    ? Number(readFileSync(`${path}.clock.json`, "utf8"))
    : 1000;
  const options = {
    journalId: "sequence-journal",
    journalIncarnation: "1",
    now: () => now,
    keyring: createCapabilityKeyring("fixture", [{ keyId: "fixture", secret: "x".repeat(32) }]),
    schemaRegistry: createDurableSchemaRegistry([input.entry, output.entry]),
  };
  type Retained = { mandate: Mandate; capability: string; legacy: string; pullId: string };
  function retained(): Retained[] {
    return readFileSync(`${path}.capabilities.jsonl`, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Retained);
  }
  function databaseState() {
    const database = new BetterSqliteDatabase(path!, { readonly: true });
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
  function record() {
    const ledger = `${path}.calls.jsonl`;
    const count = existsSync(ledger) ? readFileSync(ledger, "utf8").trim().split("\n").length : 0;
    const value = `hello:recorded:${count + 1}`;
    appendFileSync(
      ledger,
      `${JSON.stringify({ occurrence: count, key: "same", input: "hello", value })}\n`,
    );
    return value;
  }
  function trace(event: unknown) {
    appendFileSync(`${path}.guest.jsonl`, `${JSON.stringify({ pid: process.pid, event })}\n`);
  }
  const work: Computation = function* () {
    trace({ type: "attached" });
    if (variant === "extra-history") {
      return "early";
    }
    const first = yield {
      kind: "record",
      key: variant === "divergent" ? "changed" : "same",
      retrySafety: { mode: variant === "unsafe" ? "unsafe" : "repeatable" },
    };
    trace({ type: "delivered", occurrence: 0, value: first });
    if (variant === "pending-completed") {
      return "early";
    }
    const second = yield {
      kind: "record",
      key: variant === "pending-divergent" ? "changed" : "same",
      retrySafety: { mode: "repeatable" },
    };
    trace({ type: "delivered", occurrence: 1, value: second });
    if (typeof first !== "string" || typeof second !== "string") {
      throw new Error("Expected string outcomes");
    }
    return `${first}|${second}:done`;
  };
  const programs = createDurableToolRegistry([
    createPinnedDurableProgram(manifest, function* (_value, context) {
      const first = yield* context.record({ key: "same" }, function* () {
        return record();
      });
      const second = yield* context.record({ key: "same" }, function* () {
        return record();
      });
      return `${first}|${second}:done`;
    }),
  ]);
  const driver = createWorkflowProgramDriver(programs);
  const handle = await run(() => openBetterSqliteStorage(path, { initialize: true, wal: false }));
  try {
    const report = await run(function* () {
      const journal = yield* createJournal(handle.storage.executionStore, options);
      const state = yield* journal.query({
        type: "task.recovery-state",
        sessionId: attach.sessionId,
        taskId: attach.taskId,
      });
      if (state.status === "not_found") {
        yield* journal.advance({
          type: "execution.open-task",
          request: {
            ...attach,
            turnId: "turn",
            manifest,
            attachmentId: stableProgramAttachmentId(attach),
            audience: "program-host",
          },
        });
      }
      if (variant === "seed-second-root") {
        yield* journal.advance({
          type: "execution.open-task",
          request: {
            ...attach,
            taskId: "other-root",
            turnId: "turn",
            manifest,
            attachmentId: "other-root",
            audience: "program-host",
          },
        });
        return { records: yield* journal.readSession(attach.sessionId) };
      }
      if (variant === "seed-unsafe") {
        const active = yield* journal.query({
          type: "task.recovery-state",
          sessionId: attach.sessionId,
          taskId: attach.taskId,
        });
        if (active.status !== "active") {
          throw new Error("Expected active fixture");
        }
        const current = active.activeTasks[0]!;
        const bound = yield* journal.advance({
          type: "execution.bind-attachment",
          request: { sessionId: attach.sessionId, ...current },
        });
        yield* journal.advance({
          type: "execution.reserve-pull",
          request: {
            sessionId: attach.sessionId,
            turnId: "turn",
            taskId: attach.taskId,
            actionIndex: 0,
            pullIndex: 0,
            programCapability: bound.programCapability,
            descriptor: { kind: "record", key: "same", retrySafety: { mode: "unsafe" } },
          },
        });
        return { records: yield* journal.readSession(attach.sessionId) };
      }
      if (variant === "probe-retained" || variant === "probe-retained-second") {
        const capabilities = retained();
        const occurrence = variant === "probe-retained-second" ? 1 : 0;
        const old =
          occurrence === 0
            ? capabilities[0]!
            : capabilities.find((entry) => entry.pullId !== capabilities[0]!.pullId)!;
        const before = databaseState();
        const results: unknown[] = [];
        for (const value of [
          occurrence === 0 ? "hello:recorded:3" : "hello:recorded:6",
          "late-changed",
        ]) {
          for (const [capability, code] of [
            [old.capability, "capability_revoked"],
            [old.legacy, "invalid_resolution_capability"],
          ]) {
            const result = yield* journal.advance({
              type: "execution.resolve-pull",
              request: {
                capability: capability!,
                audience: "program-execution",
                outcome: { status: "ok", value },
              },
            });
            deepStrictEqual(result, { status: "rejected", code });
            deepStrictEqual(databaseState(), before);
            results.push(result);
          }
        }
        let code;
        try {
          yield* journal.advance({
            type: "execution.reserve-pull",
            request: {
              ...old.mandate.address,
              actionIndex: occurrence,
              pullIndex: occurrence,
              programCapability: old.mandate.programCapability,
              descriptor: { kind: "record", key: "same", retrySafety: { mode: "repeatable" } },
            },
          });
        } catch (error) {
          code = (error as { code: string }).code;
        }
        deepStrictEqual(code, "stale_program_capability");
        deepStrictEqual(databaseState(), before);
        const release = yield* journal.advance({
          type: "execution.release-mandate",
          request: { mandate: old.mandate, reason: "failed" },
        });
        deepStrictEqual(release, { status: "stale" });
        deepStrictEqual(databaseState(), before);
        return { results, code, release, records: yield* journal.readSession(attach.sessionId) };
      }
      if (engine === "inspect") {
        return {
          state,
          plan: yield* journal.query({ type: "forest.replay-plan", sessionId: attach.sessionId }),
          records: yield* journal.readSession(attach.sessionId),
        };
      }
      let currentMandate: Mandate | undefined;
      let lastBind: Extract<AuthorityCommand, { type: "execution.bind-mandate" }> | undefined;
      const authority: JournalAuthorityContract = {
        *command(command) {
          trace({ type: "command", command: command.type });
          if (command.type === "execution.mandate-reserve" && variant === "reserve-error") {
            throw new Error("fixture reserve failure");
          }
          if (command.type === "execution.bind-mandate") {
            lastBind = command;
          }
          if (command.type === "execution.release-mandate" && variant === "cleanup-error") {
            throw new Error("fixture cleanup failure");
          }
          if (
            command.type === "execution.mandate-reserve" &&
            variant === "replaced-reserve" &&
            lastBind
          ) {
            yield* journal.advance({
              type: "execution.release-mandate",
              request: { mandate: command.request.mandate, reason: "scope_exit" },
            });
            const replacement = yield* journal.advance({
              ...lastBind,
              request: {
                ...lastBind.request,
                ownerId: "competitor",
                attachmentId: "competitor",
                expected: {
                  ...lastBind.request.expected,
                  leaseEpoch: command.request.mandate.lease.epoch,
                },
              },
            });
            if (replacement.status !== "bound") {
              throw new Error("fixture replacement failed");
            }
          }
          if (command.type === "execution.bind-mandate" && variant === "stale-bind") {
            // Commit a real competing bind after the candidate read its plan.
            yield* journal.advance({
              ...command,
              request: { ...command.request, ownerId: "competitor", attachmentId: "competitor" },
            });
          }
          if (
            (command.type === "execution.mandate-reserve" && variant === "expired-reserve") ||
            (command.type === "execution.mandate-complete" && variant === "expired-complete")
          ) {
            now += 30001;
          }
          if (command.type === "execution.resolve-pull") {
            if (variant === "rejected-resolution") {
              return yield* journal.advance({
                ...command,
                request: { ...command.request, capability: "invalid-capability" },
              });
            }
            if (variant === "rollback") {
              const fault = yield* openBetterSqliteStorageForTest(path, {
                wal: false,
                faultInjection: "execution-before-commit",
              });
              try {
                const faultJournal = yield* createJournal(fault.storage.executionStore, options);
                return yield* faultJournal.advance(command);
              } finally {
                yield* fault.close();
              }
            }
          }
          if (command.type === "execution.recover-record" && variant === "old-settlement-wins") {
            const accepted = yield* journal.advance({
              type: "execution.resolve-pull",
              request: {
                capability: retained()[0]!.capability,
                audience: "program-execution",
                outcome: { status: "ok", value: "old-winner" },
              },
            });
            deepStrictEqual(accepted.status, "accepted");
            writeFileSync(`${path}.winner-state.json`, JSON.stringify(databaseState()));
          }
          const result = yield* journal.advance(command);
          if (command.type === "execution.bind-mandate") {
            const bound = result as { status: string; mandate: Mandate };
            if (bound.status === "bound") {
              currentMandate = bound.mandate;
            }
          }
          if (
            command.type === "execution.mandate-reserve" ||
            command.type === "execution.recover-record"
          ) {
            const reservation = result as {
              status: string;
              resolutionCapability: string;
              pullId: string;
              mandate?: Mandate;
            };
            currentMandate = reservation.mandate ?? currentMandate;
            if (reservation.status === "authorized" && currentMandate) {
              const {
                version: _version,
                issuer: _issuer,
                keyId: _keyId,
                ...claims
              } = verifyResolutionCapability(
                reservation.resolutionCapability,
                options.keyring,
                "program-execution",
              );
              // Host-signed compatibility fixture with the old attemptless claim shape.
              // It is retained before takeover; normal authority issuance never uses this route.
              const legacy = signCapability({ ...claims, attemptId: "none" }, options.keyring);
              appendFileSync(
                `${path}.capabilities.jsonl`,
                `${JSON.stringify({ mandate: currentMandate, capability: reservation.resolutionCapability, legacy, pullId: reservation.pullId })}\n`,
              );
            }
          }
          if (command.type === "execution.recover-record" && variant === "loss-after-permission") {
            trace({ type: "permission-committed" });
            interrupt(75);
          }
          return result;
        },
        *query(query) {
          const result = yield* journal.query(query);
          if (query.type === "task.record-recovery-observation") {
            const observation = result as RecordRecoveryObservation;
            const item = observation.item;
            const entries = item.replay as Array<(typeof item.replay)[number]>;
            if (variant === "truncated") {
              entries.pop();
            }
            if (variant === "digest-invalid" && entries[0]) {
              entries[0] = { ...entries[0], entryDigest: "0".repeat(64) };
            }
            if (variant === "wrong-head") {
              (item as { plannedHead: typeof item.plannedHead }).plannedHead = {
                ...item.plannedHead,
                digest: "0".repeat(64),
              };
            }
          }
          if (query.type === "forest.replay-plan") {
            const plan = result as ForestReplayPlan;
            const item = plan.replay.at(0);
            if (item) {
              // Corrupt only the query copy, retaining the independently planned head.
              const entries = item.replay as Array<(typeof item.replay)[number]>;
              if (variant === "truncated") {
                entries.pop();
              }
              if (variant === "reordered") {
                entries.reverse();
              }
              if (variant === "duplicate" && entries[0]) {
                entries[1] = entries[0];
              }
              if (variant === "digest-invalid" && entries[0]) {
                entries[0] = { ...entries[0], entryDigest: "0".repeat(64) };
              }
            }
          }
          return result;
        },
      };
      const result =
        engine === "candidate"
          ? yield* driveSequentialJournal({
              authority,
              recoverPending,
              attach:
                variant === "changed-input"
                  ? { ...attach, input: "changed" }
                  : variant === "changed-program"
                    ? { ...attach, program: { ...attach.program, digest: "d".repeat(64) } }
                    : variant === "unsupported-driver"
                      ? { ...attach, route: { driverKind: "remote" } }
                      : variant === "affinity"
                        ? { ...attach, affinity: { kind: "workspace", key: "elsewhere" } }
                        : attach,
              work,
              *handler() {
                if (variant === "handler-error" || variant === "cleanup-error") {
                  throw new Error("fixture handler failure");
                }
                if (recoverPending) {
                  const current = retained().at(-1)!;
                  const claims = verifyResolutionCapability(
                    current.capability,
                    options.keyring,
                    "program-execution",
                  );
                  trace({ type: "dispatch", pullId: claims.pullId, attemptId: claims.attemptId });
                }
                const value = record();
                if (variant === "loss-before-acceptance") {
                  trace({ type: "external-completed", value });
                  interrupt(74);
                }
                return { status: "ok", value };
              },
              afterAccepted(index) {
                if (index === stop) {
                  interrupt(73);
                }
              },
            })
          : yield* ProgramDriverRegistryContext.with(new Map([["program", driver]]), () =>
              driveProgramDriverActivation({
                authority,
                driver,
                attach,
                activationOwnerId: "reference",
                advancement: {},
              }),
            );
      const records = yield* journal.readSession(attach.sessionId);
      return { result, records };
    });
    writeFileSync(`${path}.report.json`, JSON.stringify(report, null, 2));
  } catch (error) {
    if (error instanceof AcceptedBoundary) {
      return error.status;
    }
    writeFileSync(
      `${path}.error.json`,
      JSON.stringify({
        code: (error as { code?: string }).code ?? null,
        message: (error as Error).message,
      }),
    );
    throw error;
  } finally {
    await run(() => handle.close());
  }

  return 0;
}
