import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "effection";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { SqliteJournal } from "@sweatpants/primitive-journal/sqlite";
import { driveJournal } from "@sweatpants/primitive-journal";
import { assertJson } from "@sweatpants/foundation";
import {
  createPayments,
  PaymentDefinition,
} from "../../../experiments/standard-durability/payments.ts";
import { paymentWork } from "../../../experiments/standard-durability/payments-journal.ts";
import { guest, type ApiRequest } from "../../../experiments/standard-durability/api-bindings.ts";
import {
  defineApi,
  type OutcomeOf,
} from "../../../experiments/standard-durability/api-definition.ts";
import {
  effect,
  effectProgram,
  type EffectYield,
} from "../../../experiments/standard-durability/effect.ts";
import {
  effection,
  type EffectionYield,
} from "../../../experiments/standard-durability/effection.ts";
import type { Composition, Work } from "../../../experiments/standard-durability/contracts.ts";

interface Host<Y> {
  composition: Composition<Y>;
  run<T>(work: Work<T, Y>): Promise<T>;
}
function identity(amount: number) {
  return {
    executionId: "payment-1",
    program: { id: "typed-payment", version: "1", digest: "typed-payment-v1" },
    input: { account: "acme", amount },
  };
}
const request: ApiRequest = {
  kind: "api",
  api: PaymentDefinition.id,
  method: "charge",
  version: "1",
  input: { account: "acme", amount: 10 },
  retrySafety: { mode: "unsafe" },
};
function scenarios<Y>(name: string, host: Host<Y>) {
  describe(`typed API facade: ${name}`, () => {
    it("delivers success and decline as typed values and routes a second operation independently", async () => {
      for (const amount of [10, 200]) {
        const journal = new SqliteJournal(":memory:", identity(amount));
        const trace: string[] = [];
        try {
          const result = await host.run(
            paymentWork(host.composition, journal, "acme", amount, (event) => trace.push(event)),
          );
          const domain =
            amount === 10
              ? { ok: true, value: { receipt: "acme:10" } }
              : { ok: false, error: { code: "declined", message: "Example limit exceeded" } };
          expect(result).toEqual(
            amount === 10
              ? { status: "paid", receipt: "acme:10" }
              : { status: "declined", message: "Example limit exceeded" },
          );
          expect(journal.readAccepted(0)?.outcome).toEqual({ ok: true, value: domain });
          expect(journal.read().status).toBe("completed");
          expect(trace).toEqual([
            amount === 10 ? "charged:acme:10" : "declined:Example limit exceeded",
          ]);
          // Replaying the completed workflow bypasses provider and middleware.
          expect(
            await host.run(
              paymentWork(host.composition, journal, "acme", amount, (event) => trace.push(event)),
            ),
          ).toEqual(result);
          expect(trace).toHaveLength(1);
        } finally {
          journal.close();
        }
      }
      const journal = new SqliteJournal(":memory:", identity(10));
      const { Payments, installExample } = createPayments(host.composition);
      const explicit = guest.use(PaymentDefinition);
      try {
        const result = await host.run(function* () {
          yield* installExample(() => {});
          return yield* driveJournal(
            function* () {
              const first = yield* Payments.operations.lookup({ receipt: "acme:10" });
              const second = yield* explicit.lookup({ receipt: "" });
              return assertJson([first, second]);
            },
            journal,
            (pending) => Payments.host.handle(pending),
          );
        });
        expect(result).toEqual([
          { ok: true, value: { settled: true } },
          { ok: false, error: { code: "missing" } },
        ]);
        expect(journal.read().entries.map((entry) => entry.request)).toEqual([
          {
            ...request,
            method: "lookup",
            input: { receipt: "acme:10" },
            retrySafety: { mode: "repeatable" },
          },
          {
            ...request,
            method: "lookup",
            input: { receipt: "" },
            retrySafety: { mode: "repeatable" },
          },
        ]);
      } finally {
        journal.close();
      }
    });

    it("reopens SQLite after acceptance-before-delivery and does not repeat an unsafe charge or middleware", async () => {
      const directory = await mkdtemp(join(tmpdir(), "typed-api-"));
      const database = join(directory, "payments.sqlite");
      let journal = new SqliteJournal(database, identity(10));
      let calls = 0;
      let middlewareCalls = 0;
      let deliveries = 0;
      let cleanups = 0;
      function activate(interrupt: boolean) {
        // Fresh bindings; only persisted history survives this reattachment.
        const { Payments, purchase } = createPayments(host.composition);
        return host.run(function* () {
          yield* Payments.host.install({
            *charge() {
              calls++;
              if (!interrupt) {
                throw new Error("Replay called the payment provider");
              }
              yield* host.composition.ensure(function* () {
                cleanups++;
              });
              return { ok: true, value: { receipt: "provider-receipt" } };
            },
            *lookup() {
              throw new Error("Unexpected lookup");
            },
          });
          yield* Payments.host.around({
            *charge(args, next) {
              middlewareCalls++;
              const outcome = yield* next(...args);
              return outcome.ok
                ? { ok: true, value: { receipt: `wrapped:${outcome.value.receipt}` } }
                : outcome;
            },
          });
          return yield* driveJournal(
            function* () {
              const value = yield* purchase("acme", 10);
              deliveries++;
              return value;
            },
            journal,
            (pending) => Payments.host.handle(pending),
            [],
            () => {
              if (interrupt) {
                throw new Error("Lost attachment before delivery");
              }
            },
          );
        });
      }
      try {
        await expect(activate(true)).rejects.toThrow("Lost attachment before delivery");
        expect(deliveries).toBe(0);
        expect(cleanups).toBe(1);
        expect(journal.read().status).toBe("running");
        expect(journal.readAccepted(0)?.outcome).toEqual({
          ok: true,
          value: {
            ok: true,
            value: { receipt: "wrapped:provider-receipt" },
          },
        });
        journal.close();
        journal = new SqliteJournal(database, identity(10));
        expect(await activate(false)).toEqual({
          status: "paid",
          receipt: "wrapped:provider-receipt",
        });
        expect(calls).toBe(1);
        expect(middlewareCalls).toBe(1);
        expect(deliveries).toBe(1);
        expect(journal.read().attempts).toHaveLength(1);
        expect(journal.read().status).toBe("completed");
      } finally {
        journal.close();
        await rm(directory, { recursive: true, force: true });
      }
    });

    it("rejects wrong versions and malformed live/replayed outcomes before authored delivery", async () => {
      for (const invalid of ["version", "live-success", "live-failure", "replay"] as const) {
        const journal = new SqliteJournal(":memory:", identity(10));
        const { Payments, purchase } = createPayments(host.composition);
        let calls = 0;
        let deliveries = 0;
        // Deliberately malformed data: a remote/JavaScript implementation can bypass TS.
        const malformed =
          invalid === "live-failure"
            ? { ok: false, error: { code: "missing" } }
            : { ok: true, value: { receipt: 42 } };
        if (invalid === "replay") {
          journal.begin(0, request, "unsafe");
          journal.accept(0, request, { ok: true, value: assertJson(malformed) });
        }
        try {
          await expect(
            host.run(function* () {
              yield* Payments.host.install({
                *charge() {
                  calls++;
                  return { ok: true, value: { receipt: "valid" } };
                },
                *lookup() {
                  throw new Error("Unexpected lookup");
                },
              });
              yield* Payments.host.around({
                *charge(args, next) {
                  yield* next(...args);
                  return malformed as unknown as OutcomeOf<
                    typeof PaymentDefinition.operations.charge
                  >;
                },
              });
              return yield* driveJournal(
                function* () {
                  const value = yield* purchase("acme", 10);
                  deliveries++;
                  return value;
                },
                journal,
                (pending) =>
                  Payments.host.handle(
                    invalid === "version" ? { ...pending, version: "wrong" } : pending,
                  ),
              );
            }),
          ).rejects.toThrow(
            invalid === "version"
              ? "API request identity, version or retry policy mismatch"
              : "API schema validation failed",
          );
          expect(deliveries).toBe(0);
          expect(calls).toBe(invalid === "live-success" || invalid === "live-failure" ? 1 : 0);
          expect(journal.read().entries).toHaveLength(invalid === "replay" ? 1 : 0);
          expect(journal.read().status).toBe("running");
        } finally {
          journal.close();
        }
      }

      const mutating = defineApi("mutating-payments", {
        charge: {
          ...PaymentDefinition.operations.charge,
          input: z.custom<{ account: string; amount: number }>().transform((value) => {
            value.amount += 1;
            return value;
          }),
        },
      });
      const input = { account: "acme", amount: 10 };
      expect(() => guest.use(mutating).charge(input)[Symbol.iterator]().next()).toThrow(
        "Transforming schemas require an explicit wire codec",
      );
      expect(input.amount).toBe(10);
    });
  });
}
scenarios<EffectionYield>("Effection", {
  composition: effection,
  run: (work) => Promise.resolve(run(work)),
});
scenarios<EffectYield>("Effect", {
  composition: effect,
  run: (work) => Effect.runPromise(effectProgram(work)),
});
