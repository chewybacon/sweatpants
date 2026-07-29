import { CrankError } from "@sweatpants/durable-execution";
import { race, sleep, type Operation } from "effection";

import { type DurableJournalAuthorityService } from "@sweatpants/session-contract";
import { type ProgramRunResult } from "@sweatpants/durable-execution";

/** Host coordinator timer; deliberately outside the durable crank implementation. */
export function* runWithRenewedActivationLease(
  authority: DurableJournalAuthorityService,
  sessionId: string,
  ownerId: string,
  activate: (epoch: number, ownerId: string) => Operation<ProgramRunResult>,
  timing: { readonly leaseDurationMs?: number; readonly renewalIntervalMs?: number } = {},
): Operation<ProgramRunResult> {
  const leaseDurationMs = timing.leaseDurationMs ?? 30_000;
  const renewalIntervalMs = timing.renewalIntervalMs ?? 10_000;
  const claim = yield* authority.claimActivation({
    sessionId,
    ownerId,
    leaseDurationMs,
  });
  if (claim.status === "busy") {
    throw new CrankError("activation_busy", "Durable activation is owned by another host");
  }
  if (claim.status === "not_runnable") {
    throw new CrankError("activation_busy", "Durable task has no runnable command");
  }
  let reason: "parked" | "terminal" | "failed" | "lease_lost" = "failed";
  try {
    const outcome = yield* race([
      (function* (): Operation<ProgramRunResult> {
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
      (function* (): Operation<ProgramRunResult> {
        while (true) {
          yield* sleep(renewalIntervalMs);
          const renewed = yield* authority.renewActivation({
            sessionId,
            ownerId,
            epoch: claim.epoch,
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
  } finally {
    yield* authority.releaseActivation({
      sessionId,
      ownerId,
      epoch: claim.epoch,
      reason,
    });
  }
}
