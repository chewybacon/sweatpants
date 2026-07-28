import { CrankError } from "@sweatpants/durable-execution";
import { race, sleep, type Operation } from "effection";

import {
  type ClaimActivationResult,
  type DurableJournalAuthorityService,
  type ReleaseActivationRequest,
} from "@sweatpants/session-contract";

export interface AgentCoreActivationCoordinatorOptions {
  readonly authority: DurableJournalAuthorityService;
  readonly ownerId: string;
  readonly leaseDurationMs?: number;
  readonly renewalIntervalMs?: number;
}

export type CoordinatedActivationResult<T> =
  | { readonly status: "completed"; readonly epoch: number; readonly value: T }
  | Exclude<ClaimActivationResult, { status: "claimed" }>;

/**
 * Fenced coordinator ownership. Renewal runs outside the crank operation; a
 * failed renewal cancels the run branch, which triggers ProgramRuntime socket
 * shutdown through structured scope exit before stale work can continue.
 */
export function createAgentCoreActivationCoordinator(
  options: AgentCoreActivationCoordinatorOptions,
): {
  activate<T>(
    sessionId: string,
    runActivation: (epoch: number) => Operation<T>,
    releaseReason?: (value: T) => ReleaseActivationRequest["reason"],
  ): Operation<CoordinatedActivationResult<T>>;
} {
  const leaseDurationMs = options.leaseDurationMs ?? 30_000;
  const renewalIntervalMs = options.renewalIntervalMs ?? 10_000;
  if (
    renewalIntervalMs <= 0 ||
    renewalIntervalMs > 10_000 ||
    renewalIntervalMs >= leaseDurationMs
  ) {
    throw new CrankError(
      "invalid_command",
      "Activation renewal cadence must be positive, <=10s, and faster than expiry",
    );
  }
  return {
    *activate<T>(
      sessionId: string,
      runActivation: (epoch: number) => Operation<T>,
      releaseReason?: (value: T) => ReleaseActivationRequest["reason"],
    ): Operation<CoordinatedActivationResult<T>> {
      const claim = yield* options.authority.claimActivation({
        sessionId,
        ownerId: options.ownerId,
        leaseDurationMs,
      });
      if (claim.status !== "claimed") {
        return claim;
      }
      let reason: ReleaseActivationRequest["reason"] = "scope_exit";
      try {
        const winner = yield* race([
          (function* (): Operation<{ kind: "activation"; value: T }> {
            return { kind: "activation", value: yield* runActivation(claim.epoch) };
          })(),
          (function* (): Operation<never> {
            while (true) {
              yield* sleep(renewalIntervalMs);
              const renewed = yield* options.authority.renewActivation({
                sessionId,
                ownerId: options.ownerId,
                epoch: claim.epoch,
              });
              if (renewed.status !== "renewed") {
                throw new CrankError("stale_activation", "Activation lease renewal was lost");
              }
            }
          })(),
        ]);
        reason = releaseReason?.(winner.value) ?? "parked";
        return { status: "completed", epoch: claim.epoch, value: winner.value };
      } catch (error) {
        reason =
          error instanceof CrankError && error.code === "stale_activation"
            ? "lease_lost"
            : "failed";
        throw error;
      } finally {
        yield* options.authority.releaseActivation({
          sessionId,
          ownerId: options.ownerId,
          epoch: claim.epoch,
          reason,
        });
      }
    },
  };
}
