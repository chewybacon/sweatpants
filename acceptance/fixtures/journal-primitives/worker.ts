import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import type {
  AuthorityCommand,
  JournalAuthorityContract,
} from "../../../packages/journal-authority/src/contract/authority-contract.ts";
import { openBetterSqliteStorageForTest } from "../../../packages/storage-sqlite/src/better-sqlite3.ts";
import { run } from "effection";
import { openBetterSqliteStorage } from "@sweatpants/storage-sqlite/better-sqlite3";
import { createJournal } from "../../../packages/journal-authority/src/shell/journal.ts";
import { createCapabilityKeyring } from "../../../packages/journal-authority/src/contract/capabilities.ts";
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

const [engine, path, stopText = "-1", variant = "normal"] = process.argv.slice(2);
if (!path || (engine !== "candidate" && engine !== "reference" && engine !== "inspect")) {
  throw new Error("worker engine database [stop index]");
}
const stop = Number(stopText);
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
let now = 1000;
const options = {
  journalId: "sequence-journal",
  journalIncarnation: "1",
  now: () => now,
  keyring: createCapabilityKeyring("fixture", [{ keyId: "fixture", secret: "x".repeat(32) }]),
  schemaRegistry: createDurableSchemaRegistry([input.entry, output.entry]),
};
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
  const second = yield { kind: "record", key: "same", retrySafety: { mode: "repeatable" } };
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
    if (engine === "inspect") {
      return {
        state,
        plan: yield* journal.query({ type: "forest.replay-plan", sessionId: attach.sessionId }),
        records: yield* journal.readSession(attach.sessionId),
      };
    }
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
        return yield* journal.advance(command);
      },
      *query(query) {
        const result = yield* journal.query(query);
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
            attach:
              variant === "changed-input"
                ? { ...attach, input: "changed" }
                : variant === "changed-program"
                  ? { ...attach, program: { ...attach.program, digest: "d".repeat(64) } }
                  : attach,
            work,
            *handler() {
              if (variant === "handler-error" || variant === "cleanup-error") {
                throw new Error("fixture handler failure");
              }
              return { status: "ok", value: record() };
            },
            afterAccepted(index) {
              if (index === stop) {
                process.exit(73);
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
} finally {
  await run(() => handle.close());
}
