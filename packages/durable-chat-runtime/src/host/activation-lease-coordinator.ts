import { CrankError, type AdvancementResult } from "@sweatpants/durable-execution";
import { ensure, race, scoped, sleep, type Operation } from "effection";

import type { JournalAuthorityContract } from "@sweatpants/journal-authority";

/** Host coordinator timer; deliberately outside the durable crank implementation. */
export function* runWithRenewedActivationLease(
  authority: JournalAuthorityContract,
  sessionId: string,
  ownerId: string,
  activate: (epoch: number, ownerId: string) => Operation<AdvancementResult>,
  timing: { readonly leaseDurationMs?: number; readonly renewalIntervalMs?: number } = {},
): Operation<AdvancementResult> {
  return yield* scoped(function* () {
    const leaseDurationMs = timing.leaseDurationMs ?? 30_000;
    const renewalIntervalMs = timing.renewalIntervalMs ?? 10_000;
    const claim = yield* authority.command({
      type: "control.claim-activation",
      request: { sessionId, ownerId, leaseDurationMs },
    });
    if (claim.status === "busy") {
      throw new CrankError("activation_busy", "Durable activation is owned by another host");
    }
    if (claim.status === "not_runnable") {
      // Recovery may need to publish an already parked input after its writer
      // disappeared. Read the authority frontier; no executor or lease is needed.
      const plan = yield* authority.query({ type: "forest.replay-plan", sessionId });
      const slots = plan.rows.flatMap((row) =>
        row.classification !== "terminal" && row.parked?.reason === "elicit"
          ? [{ taskId: row.address.taskId, pullId: row.parked.pullId, reason: "elicit" }]
          : [],
      );
      if (slots.length > 0) {
        return { state: "parked", pullId: slots[0]!.pullId, reason: "elicit", slots };
      }
      throw new CrankError("activation_busy", "Durable task has no runnable command");
    }
    let reason: "parked" | "terminal" | "failed" | "lease_lost" = "failed";
    // Cleanup belongs to this activation scope. A yielding delegated finally
    // can resume a cancelled caller with undefined; ensure keeps unwind structural.
    yield* ensure(function* () {
      yield* authority.command({
        type: "control.release-activation",
        request: { sessionId, ownerId, epoch: claim.epoch, reason },
      });
    });
    const outcome = yield* race([
      (function* (): Operation<AdvancementResult> {
        // Retries stay inside the same fenced activation epoch. On the third
        // consecutive stale restore the authority deletes that lease; the next
        // attempt therefore fails stale_activation and exits instead of bypassing backoff.
        for (let attempt = 0; ; attempt += 1) {
          try {
            return yield* activate(claim.epoch, ownerId);
          } catch (error) {
            if (!(error instanceof CrankError) || error.code !== "restore_stale" || attempt >= 2) {
              throw error;
            }
          }
        }
      })(),
      (function* (): Operation<AdvancementResult> {
        while (true) {
          yield* sleep(renewalIntervalMs);
          const renewed = yield* authority.command({
            type: "control.renew-activation",
            request: { sessionId, ownerId, epoch: claim.epoch },
          });
          if (renewed.status !== "renewed") {
            reason = "lease_lost";
            throw new CrankError("stale_activation", "Activation lease renewal was lost");
          }
        }
      })(),
    ]);
    reason = outcome.state === "parked" ? "parked" : "terminal";
    return outcome;
  });
}
