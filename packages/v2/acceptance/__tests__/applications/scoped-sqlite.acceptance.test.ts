import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { describe, expect, expectTypeOf, it } from "vitest";
import { createSqliteJournalStore, type SqliteConnection } from "@sweatpan.ts/storage-sqlite";
import { createNodeSqliteConnection, v8Serializer } from "@sweatpan.ts/storage-sqlite/node";
import { createLatch } from "@sweatpan.ts/testing";
import { createScopedSqlite } from "../../examples/scoped-sqlite.ts";
import { forEachRuntime } from "../runtime/assembly.ts";
forEachRuntime((runtime) => {
  describe(`${runtime.name}: scoped synchronous SQLite acquisition`, () => {
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
    it("selects scoped SQL decorators and drivers before journal transactions, with bounded handles", async () => {
      const database = new DatabaseSync(":memory:");
      const childDatabase = new DatabaseSync(":memory:");
      try {
        const base = createNodeSqliteConnection(database);
        const childBase = createNodeSqliteConnection(childDatabase);
        const access = createScopedSqlite(runtime.composition, base);
        const trace: string[] = [];
        let escaped: SqliteConnection | undefined;
        await runtime.start(function* () {
          for (const [name, at] of [
            ["max1", "max"],
            ["min1", "min"],
            ["max2", "max"],
            ["min2", "min"],
          ] as const) {
            yield* access.around(
              {
                sync: {
                  run: (next) =>
                    function (...args) {
                      trace.push(`${name}:in`);
                      const result = next(...args);
                      expectTypeOf(result).toEqualTypeOf<{
                        readonly changes: number;
                      }>();
                      trace.push(`${name}:out`);
                      return result;
                    },
                },
              },
              { at },
            );
          }
          let transactions = 0;
          yield* access.around({
            sync: {
              transaction: (next) =>
                function <T>(work: () => T): T {
                  transactions++;
                  return next(work);
                },
            },
          });
          const parent = yield* access;
          const value = parent.transaction(() => ({ accepted: true as const }));
          expectTypeOf(value).toEqualTypeOf<{ accepted: true }>();
          expect(value).toEqual({ accepted: true });
          expect(transactions).toBe(1);
          yield* journal(parent, "parent").admit("scoped-sqlite:v1", "parent-input");
          expect(trace.length).toBeGreaterThan(0);
          const order = [
            "max1:in",
            "max2:in",
            "min2:in",
            "min1:in",
            "min1:out",
            "min2:out",
            "max2:out",
            "max1:out",
          ];
          for (let index = 0; index < trace.length; index += order.length) {
            expect(trace.slice(index, index + order.length)).toEqual(order);
          }
          yield* runtime.composition.scoped(function* () {
            yield* access.install({ sync: childBase });
            yield* access.around({
              sync: {
                run: (next) =>
                  function (...args) {
                    trace.push("child");
                    return next(...args);
                  },
              },
            });
            escaped = yield* access;
            trace.length = 0;
            yield* journal(escaped, "child").admit("scoped-sqlite:v1", "child-input");
            expect(trace).toContain("child");
            // An already bound parent handle deliberately retains parent selection.
            trace.length = 0;
            yield* journal(parent, "parent-in-child").admit("scoped-sqlite:v1", "retained");
            expect(trace).not.toContain("child");
          });
          expect(() => escaped!.get("SELECT 1")).toThrow("access scope is closed");
          trace.length = 0;
          const restored = yield* access;
          yield* journal(restored, "restored").admit("scoped-sqlite:v1", "restored");
          expect(trace).not.toContain("child");
          escaped = parent;
        }).result;
        expect(() => escaped!.get("SELECT 1")).toThrow("access scope is closed");
        expect(base.all("SELECT id FROM sweatpants_executions ORDER BY id")).toHaveLength(3);
        expect(childBase.all("SELECT id FROM sweatpants_executions")).toHaveLength(1);
        // A new root does not inherit any of the previous root's SQL layers.
        trace.length = 0;
        await runtime.start(function* () {
          const connection = yield* access;
          yield* journal(connection, "fresh").admit("scoped-sqlite:v1", "fresh");
        }).result;
        expect(trace).toEqual([]);
      } finally {
        childDatabase.close();
        database.close();
      }
    });
    it("revokes a retained connection when its owning execution is cancelled", async () => {
      const database = new DatabaseSync(":memory:");
      const ready = createLatch<SqliteConnection>();
      const parked = createLatch<void>();
      const access = createScopedSqlite(runtime.composition, createNodeSqliteConnection(database));
      const execution = runtime.start(function* () {
        const connection = yield* access;
        yield* journal(connection, "cancel").admit("scoped-sqlite:v1", "input");
        ready.resolve(connection);
        yield* runtime.fromPromise(() => parked.promise);
      });
      void execution.result.catch(() => undefined);
      try {
        const connection = await ready.promise;
        expect(connection.get("SELECT 1 AS alive")).toEqual({ alive: 1 });
        await execution.cancel();
        expect(() => connection.get("SELECT 1")).toThrow("access scope is closed");
        expect(database.prepare("SELECT * FROM sweatpants_executions").all()).toHaveLength(1);
      } finally {
        parked.resolve();
        await execution.cancel();
        database.close();
      }
    });
    for (const fault of ["throw", "promise", "operation"] as const) {
      it(`rolls back journal admission when SQL middleware returns ${fault}`, async () => {
        const database = new DatabaseSync(":memory:");
        try {
          const base = createNodeSqliteConnection(database);
          const access = createScopedSqlite(runtime.composition, base);
          let writes = 0;
          await expect(
            runtime.start(function* () {
              yield* access.around({
                sync: {
                  run: (next) =>
                    function (...args) {
                      const result = next(...args);
                      writes++;
                      if (fault === "throw") {
                        throw new Error("SQL policy failure");
                      }
                      // Simulate an untyped plugin violating the synchronous contract.
                      return (fault === "promise"
                        ? Promise.resolve(result)
                        : runtime.sleep(0)) as unknown as typeof result;
                    },
                },
              });
              const connection = yield* access;
              yield* journal(connection, "rollback").admit("scoped-sqlite:v1", "input");
            }).result,
          ).rejects.toThrow(fault === "throw" ? "SQL policy failure" : "Synchronous API member");
          expect(writes).toBeGreaterThan(0);
          expect(base.all("SELECT * FROM sweatpants_executions")).toEqual([]);
          expect(base.all("SELECT * FROM sweatpants_activations")).toEqual([]);
          // The driver remains usable; rejection did not leave an open transaction.
          await runtime.start(function* () {
            const connection = yield* access;
            const recovered = journal(connection, "rollback");
            yield* recovered.admit("scoped-sqlite:v1", "input");
            expect((yield* recovered.read()).status).toBe("running");
          }).result;
        } finally {
          database.close();
        }
      });
    }
  });
});
