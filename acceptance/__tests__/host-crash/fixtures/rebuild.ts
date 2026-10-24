import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { run, resource, sleep, spawn, suspend, withResolvers, type Operation } from "effection";
import { createDurableTool } from "@sweatpants/agent-sdk";
import {
  DurableProgramCancellation,
  exactProgramKey,
  ProgramPeer,
  ProgramDriverRegistryContext,
  type ProgramRestoreRequest,
} from "@sweatpants/durable-execution";
import {
  createWorkflowProgramDriver,
  driveProgramDriverActivation,
  createJournal,
  createCapabilityKeyring,
} from "@sweatpants/journal-authority";
import { openBetterSqliteStorage } from "@sweatpants/storage-sqlite/better-sqlite3";
import { createDurableSchemaRegistry } from "@sweatpants/journal-authority/schema-registry";
import { z } from "zod";
import { useProgramRig } from "../../../support/program.ts";

export function rebuildProgram(directory: string, mode = "original", trace: string[] = []) {
  const observe = (event: string) => {
    trace.push(event);
    appendFileSync(
      resolve(directory, "observations.jsonl"),
      JSON.stringify({ pid: process.pid, event }) + "\n",
    );
  };
  const tool = createDurableTool("rebuild")
    .description("Accepted reconstruction")
    .identity({ version: "1", digest: "a".repeat(64) })
    .parameters(z.object({}))
    .output(z.string())
    .elicits({ choose: { response: z.object({ accepted: z.boolean() }) } })
    .execute(function* (_, ctx) {
      observe("acquire");
      yield* resource(function* (provide) {
        try {
          yield* provide(undefined);
        } finally {
          yield* sleep(0);
          observe("release");
        }
      });
      const childReady = withResolvers<void>();
      yield* spawn(function* () {
        observe("child");
        childReady.resolve();
        try {
          yield* suspend();
        } finally {
          yield* sleep(0);
          observe("child-release");
        }
      });
      yield* childReady.operation;
      try {
        if (mode === "terminal") {
          return "premature";
        }
        const value = yield* ctx.record(
          { key: mode === "changed" ? "changed" : "recorded", retrySafety: { mode: "repeatable" } },
          function* () {
            appendFileSync(
              resolve(directory, "effects.jsonl"),
              JSON.stringify({ pid: process.pid, value: "accepted-value" }) + "\n",
            );
            return "accepted-value";
          },
        );
        observe(`continued:${value}`);
        const followup = yield* ctx.record(
          { key: "follow-up", retrySafety: { mode: "repeatable" } },
          function* () {
            observe("follow-up-attempt");
            return "continued-value";
          },
        );
        observe(`follow-up:${followup}`);
        yield* ctx.elicit("choose", { message: value });
        return value;
      } catch (error) {
        if (error instanceof DurableProgramCancellation) {
          observe("logical-cancel");
        }
        throw error;
      }
    });
  return {
    manifest: tool.manifest,
    schemas: tool.artifacts.catalog,
    createDriver: (detachedScope = false) =>
      createWorkflowProgramDriver(
        new Map([
          [
            exactProgramKey({
              id: tool.manifest.programId,
              version: tool.manifest.version,
              digest: tool.manifest.digest,
            }),
            tool,
          ],
        ]),
        { detachedScope },
      ),
  };
}

export function* withRebuildStore<T>(
  directory: string,
  body: (rig: AwaitedRig) => Operation<T>,
): Operation<T> {
  const storage = yield* openBetterSqliteStorage(resolve(directory, "authority.sqlite"), {
    initialize: true,
  });
  try {
    const program = rebuildProgram(directory);
    const rig = yield* useProgramRig(storage.storage.executionStore, program, {});
    const journal = yield* createJournal(storage.storage.executionStore, {
      journalId: "acceptance-program",
      keyring: createCapabilityKeyring("acceptance", [
        { keyId: "test", secret: "acceptance-program-secret-at-least-32-bytes" },
      ]),
      schemaRegistry: createDurableSchemaRegistry(program.schemas),
    });
    return yield* body({ ...rig, journal });
  } finally {
    yield* storage.close();
  }
}
type AwaitedRig =
  ReturnType<typeof useProgramRig> extends Generator<unknown, infer T, unknown> ? T : never;

if (process.argv[2] === "rebuild-worker") {
  const directory = resolve(process.argv[3]!);
  const mode = process.argv[4];
  mkdirSync(directory, { recursive: true });
  const deadline = setTimeout(() => process.exit(124), 20_000);
  run(function* () {
    return yield* withRebuildStore(directory, function* (rig) {
      const program = rebuildProgram(directory);
      const driver = program.createDriver();
      if (mode === "seed") {
        yield* rig.journal.advance({
          type: "execution.open-task",
          request: {
            ...rig.attach,
            turnId: "turn",
            manifest: program.manifest,
            attachmentId: "unattached",
            audience: "acceptance",
          },
        });
      }
      yield* ProgramPeer.around({
        *step([attachment, command], next) {
          if (mode === "seed" && command.type === "resume" && command.actionIndex === 0) {
            const records = yield* rig.journal.readSession(rig.attach.sessionId);
            if (!records.some((record) => record.payload.type === "PullResolved")) {
              throw new Error("No committed resolution");
            }
            const sql = new DatabaseSync(resolve(directory, "authority.sqlite"), {
              readOnly: true,
            });
            try {
              const rows = sql
                .prepare(
                  "SELECT entries_json FROM sp_execution_journal_segments ORDER BY first_sequence",
                )
                .all();
              const persisted: typeof records = rows.flatMap((row) =>
                JSON.parse(String(row.entries_json)),
              );
              if (
                !persisted.some(
                  (record) =>
                    record.offset === command.receipt.resolutionOffset &&
                    record.payload.type === "PullResolved" &&
                    record.payload.outcomeDigest === command.receipt.outcomeDigest,
                )
              ) {
                throw new Error("Receipt missing from independent SQLite reader");
              }
              writeFileSync(
                resolve(directory, "committed-sqlite.json"),
                JSON.stringify(
                  { integrity: sql.prepare("PRAGMA integrity_check").get(), records: persisted },
                  null,
                  2,
                ),
              );
            } finally {
              sql.close();
            }

            writeFileSync(
              resolve(directory, "committed.json"),
              JSON.stringify({ pid: process.pid, command, records }, null, 2),
            );
            process.send?.({ committed: true, pid: process.pid });
            yield* suspend();
          }
          if (mode === "recover" && command.type === "resume" && command.actionIndex === 1) {
            writeFileSync(
              resolve(directory, "follow-up-delivery.json"),
              JSON.stringify(command, null, 2),
            );
          }
          return yield* next(attachment, command);
        },
        *restore([request], next) {
          if (mode === "recover") {
            writeFileSync(
              resolve(directory, "recovery-request.json"),
              JSON.stringify(request satisfies ProgramRestoreRequest, null, 2),
            );
          }
          return yield* next(request);
        },
      });
      const result = yield* ProgramDriverRegistryContext.with(
        new Map([["acceptance", driver]]),
        () =>
          driveProgramDriverActivation({
            authority: {
              command: rig.journal.advance.bind(rig.journal),
              query: rig.journal.query.bind(rig.journal),
            },
            driver,
            attach: rig.attach,
            advancement: {},
          }),
      );
      const records = yield* rig.journal.readSession(rig.attach.sessionId);
      writeFileSync(
        resolve(directory, "recovered.json"),
        JSON.stringify({ pid: process.pid, result, records }, null, 2),
      );
      return result;
    });
  }).then(
    (result) => {
      clearTimeout(deadline);
      process.send?.({ result, pid: process.pid });
      process.disconnect();
      return;
    },
    (error) => {
      clearTimeout(deadline);
      console.error(error);
      process.exitCode = 1;
      process.disconnect();
      return;
    },
  );
}
