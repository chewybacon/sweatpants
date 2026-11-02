import { journalHandler } from "./journal-api.ts";
import type { Journal } from "@sweatpants/foundation/journal";
import { driveJournal } from "../../packages/primitive-journal/src/driver.ts";
import { createPayments } from "./payments.ts";
import type { Composition } from "@sweatpants/standard-durability";

/** Callable scaffold using the existing journal loop. The caller owns storage.
 * Use a fresh journal/identity for different account/amount inputs.
 */
export function paymentWork<Y>(
  composition: Composition<Y>,
  journal: Journal,
  account: string,
  amount: number,
  log: (event: string) => void,
) {
  const { Payments, purchase, installExample } = createPayments(composition);
  return () =>
    composition.scoped(function* () {
      yield* installExample(log);
      return yield* driveJournal(
        () => purchase(account, amount),
        journal,
        journalHandler(Payments.host),
      );
    });
}
