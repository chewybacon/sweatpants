import type { Operation } from "@standard-durability/core";
import type { ActivationIntents } from "@sweatpan.ts/durable";
import type { HostedResult } from "@sweatpan.ts/hosting";
import type { ActivationReconciliation } from "./contracts.ts";

/** One pass; concurrent writes are protected by token comparison in the store. */
export function* reconcileActivation<R, Q, Y>(
  intents: ActivationIntents<Y>,
  run: () => Operation<HostedResult<R, Q>, Y>,
): Operation<ActivationReconciliation<R, Q>, Y> {
  const observed = yield* intents.read();
  if (!observed) {
    return { state: "idle" };
  }
  const result = yield* run();
  // Only a terminal root or a known participant wait is quiescent. Occupied,
  // invalidated and opaque child results must remain discoverable, including when
  // another pass is delivering work that can still fail without a journal write.
  const quiescent =
    result.state === "completed" ||
    result.state === "cancelled" ||
    result.state === "waiting" ||
    (result.state === "child" && result.reason === "waiting");
  const acknowledged = quiescent ? yield* intents.acknowledge(observed) : false;
  return { state: "driven", result, acknowledged };
}
