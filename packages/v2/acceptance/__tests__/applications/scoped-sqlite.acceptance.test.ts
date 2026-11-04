import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { describe, expect, expectTypeOf, it } from "vitest";
import { createSqliteJournalStore, type SqliteConnection } from "@sweatpan.ts/storage-sqlite";
import { createNodeSqliteConnection, v8Serializer } from "@sweatpan.ts/storage-sqlite/node";
import { createScopedSqlite, decorateSqlite } from "../../examples/scoped-sqlite.ts";
import { forEachRuntime } from "../runtime/assembly.ts";

forEachRuntime((runtime) => {
  describe(`${runtime.name}: SQLite acquisition decoration`, () => {
    function journal(connection: SqliteConnection, id: string) {
      return createSqliteJournalStore({
        connection,
        id,
        program: "scoped-sqlite:v1",
        equals: isDeepStrictEqual,
        serialization: {
          *resolve() {
            return v8Serializer;
          },
        },
      }).open();
    }

    it("captures scoped drivers and policy at acquisition, preserving generic transactions and wrapper state", async () => {
      const database = new DatabaseSync(":memory:");
      const childDatabase = new DatabaseSync(":memory:");
      try {
        const base = createNodeSqliteConnection(database);
        const childBase = createNodeSqliteConnection(childDatabase);
        const api = createScopedSqlite(runtime.composition, base);
        let builds = 0;
        const counts: number[] = [];
        const trace: string[] = [];
        await runtime.start(function* () {
          yield* api.around({
            *acquire(args, next) {
              const connection = yield* next(...args);
              return decorateSqlite(connection, {
                run: (next) => {
                  builds++;
                  let calls = 0;
                  return (...args) => {
                    counts.push(++calls);
                    return next(...args);
                  };
                },
                transaction: (next) =>
                  function <T>(work: () => T): T {
                    return next(work);
                  },
              });
            },
          });
          const parent = yield* api.operations.acquire();
          const value = parent.transaction(() => ({ accepted: true as const }));
          expectTypeOf(value).toEqualTypeOf<{ accepted: true }>();
          expect(value).toEqual({ accepted: true });
          yield* journal(parent, "parent").admit("scoped-sqlite:v1", "input");
          expect(builds).toBe(1);
          expect(counts.length).toBeGreaterThan(1);
          expect(counts).toEqual(counts.map((_, index) => index + 1));

          yield* api.around({
            *acquire(args, next) {
              return decorateSqlite(yield* next(...args), {
                run:
                  (next) =>
                  (...args) => {
                    trace.push("late");
                    return next(...args);
                  },
              });
            },
          });
          // Already acquired handles do not change when new policy is installed.
          yield* journal(parent, "parent-late").admit("scoped-sqlite:v1", "input");
          expect(trace).toEqual([]);
          const refreshed = yield* api.operations.acquire();
          yield* journal(refreshed, "refreshed").admit("scoped-sqlite:v1", "input");
          expect(trace).toContain("late");

          yield* runtime.composition.scoped(function* () {
            yield* api.install({
              *acquire() {
                return childBase;
              },
            });
            const child = yield* api.operations.acquire();
            yield* journal(child, "child").admit("scoped-sqlite:v1", "input");
            yield* journal(parent, "retained-parent").admit("scoped-sqlite:v1", "input");
          });
          const restored = yield* api.operations.acquire();
          yield* journal(restored, "restored").admit("scoped-sqlite:v1", "input");
        }).result;
        expect(base.all("SELECT id FROM sweatpants_executions")).toHaveLength(5);
        expect(childBase.all("SELECT id FROM sweatpants_executions")).toHaveLength(1);
        const previousBuilds = builds;
        await runtime.start(function* () {
          const fresh = yield* api.operations.acquire();
          expect(fresh).toBe(base);
        }).result;
        expect(builds).toBe(previousBuilds);
      } finally {
        childDatabase.close();
        database.close();
      }
    });

    it("rolls back a statement-policy failure inside journal admission and permits fresh acquisition", async () => {
      const database = new DatabaseSync(":memory:");
      try {
        const base = createNodeSqliteConnection(database);
        const api = createScopedSqlite(runtime.composition, base);
        let writes = 0;
        await expect(
          runtime.start(function* () {
            yield* api.around({
              *acquire(args, next) {
                return decorateSqlite(yield* next(...args), {
                  run:
                    (next) =>
                    (...args) => {
                      next(...args);
                      writes++;
                      throw new Error("SQL policy failure");
                    },
                });
              },
            });
            const connection = yield* api.operations.acquire();
            yield* journal(connection, "rollback").admit("scoped-sqlite:v1", "input");
          }).result,
        ).rejects.toThrow("SQL policy failure");
        expect(writes).toBeGreaterThan(0);
        expect(base.all("SELECT * FROM sweatpants_executions")).toEqual([]);
        expect(base.all("SELECT * FROM sweatpants_activations")).toEqual([]);
        await runtime.start(function* () {
          const connection = yield* api.operations.acquire();
          const recovered = journal(connection, "rollback");
          yield* recovered.admit("scoped-sqlite:v1", "input");
          expect((yield* recovered.read()).status).toBe("running");
        }).result;
      } finally {
        database.close();
      }
    });
  });
});
