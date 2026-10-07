import { run, sleep } from "effection";
import { describe, expect, it } from "vitest";

import type { JournalAuthorityContract } from "@sweatpants/journal-authority";
import { runWithRenewedActivationLease } from "../activation-lease-coordinator.ts";

describe("activation lease coordinator", () => {
  it("renews outside the crank and cancels the activation scope when renewal is lost", async () => {
    let renewals = 0;
    let activationClosed = false;
    let releasedReason: string | undefined;
    const authority = {
      *command(command: { type: string; request: { reason?: string } }) {
        if (command.type === "control.claim-activation") {
          return {
            status: "claimed" as const,
            epoch: 7,
            expiresAtMs: 100,
            taskRevision: 1,
            journalHeadId: "a".repeat(64),
          };
        }
        if (command.type === "control.renew-activation") {
          renewals += 1;
          return renewals === 1
            ? { status: "renewed" as const, expiresAtMs: 100 }
            : { status: "stale_activation" as const };
        }
        releasedReason = command.request.reason;
        return { status: "released" as const, runnable: true };
      },
    } as unknown as JournalAuthorityContract;

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
