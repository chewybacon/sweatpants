import { z } from "zod";
import { defineApi, operation } from "@sweatpants/standard-durability";
import { bindApi, createHost, type ApiRequest } from "./api-bindings.ts";
import type { Composition, Operation } from "@sweatpants/standard-durability";

/** One runtime-independent declaration shared by guest and host views. */
export const PaymentDefinition = defineApi("example.payments", {
  charge: operation({
    version: "1",
    retrySafety: "unsafe",
    input: z.strictObject({ account: z.string(), amount: z.number().int().positive() }),
    success: z.strictObject({ receipt: z.string() }),
    failure: z.strictObject({ code: z.literal("declined"), message: z.string() }),
  }),
  lookup: operation({
    version: "1",
    retrySafety: "repeatable",
    input: z.strictObject({ receipt: z.string() }),
    success: z.strictObject({ settled: z.boolean() }),
    failure: z.strictObject({ code: z.literal("missing") }),
  }),
});

export type PurchaseResult =
  | { readonly status: "paid"; readonly receipt: string }
  | { readonly status: "declined"; readonly message: string };

/** The facade is assembled once; every installation/operation resolves its executing scope. */
export function createPayments<Y>(composition: Composition<Y>) {
  const host = createHost(composition);
  const Payments = bindApi(PaymentDefinition, host);

  function* purchase(account: string, amount: number): Operation<PurchaseResult, ApiRequest> {
    const outcome = yield* Payments.operations.charge({ account, amount });
    if (!outcome.ok) {
      return { status: "declined", message: outcome.error.message };
    }
    return { status: "paid", receipt: outcome.value.receipt };
  }

  // Illustrative provider, not a payment integration. Method-specific input and
  // outcome types are inferred without annotations, casts or runtime imports.
  function* installExample(log: (event: string) => void) {
    yield* Payments.host.install({
      *charge({ account, amount }) {
        if (amount > 100) {
          return { ok: false, error: { code: "declined", message: "Example limit exceeded" } };
        }
        return { ok: true, value: { receipt: `${account}:${amount}` } };
      },
      *lookup({ receipt }) {
        return receipt.length > 0
          ? { ok: true, value: { settled: true } }
          : { ok: false, error: { code: "missing" } };
      },
    });
    yield* Payments.host.around({
      *charge(args, next) {
        const outcome = yield* next(...args);
        log(outcome.ok ? `charged:${outcome.value.receipt}` : `declined:${outcome.error.message}`);
        return outcome;
      },
    });
  }
  return { Payments, purchase, installExample };
}
