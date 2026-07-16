import { run, sleep } from "effection";
import { describe, expect, it } from "vitest";

import type { DurableJournalAuthorityService } from "@sweatpants/session-contract";
import { runWithRenewedActivationLease } from "../activation-lease-coordinator.ts";

describe("activation lease coordinator", () => {
  it("renews outside the crank and cancels the activation scope when renewal is lost", async () => {
    let renewals = 0;
    let activationClosed = false;
    let releasedReason: string | undefined;
    const authority = {
      *claimActivation() {
        return {
          status: "claimed" as const,
          epoch: 7,
          expiresAtMs: 100,
          taskRevision: 1,
          journalHeadDigest: "a".repeat(64),
        };
      },
      *renewActivation() {
        renewals += 1;
        return renewals === 1
          ? { status: "renewed" as const, expiresAtMs: 100 }
          : { status: "stale_activation" as const };
      },
      *releaseActivation(request: { reason: string }) {
        releasedReason = request.reason;
        return { status: "released" as const, runnable: true };
      },
    } as unknown as DurableJournalAuthorityService;

    await expect(
      run(() =>
        runWithRenewedActivationLease(
          authority,
          "session",
          "owner",
          function* () {
            try {
              yield* sleep(100);
              return { state: "completed" as const, value: null };
            } finally {
              activationClosed = true;
            }
          },
          { leaseDurationMs: 30, renewalIntervalMs: 5 },
        ),
      ),
    ).rejects.toMatchObject({ code: "stale_activation" });
    expect(renewals).toBe(2);
    expect(activationClosed).toBe(true);
    expect(releasedReason).toBe("lease_lost");
  });
});
