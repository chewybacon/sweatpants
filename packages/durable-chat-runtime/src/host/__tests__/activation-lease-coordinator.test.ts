import { run, sleep, createScope, suspend, withResolvers } from "effection";
import { describe, expect, it } from "vitest";

import type { JournalAuthorityContract } from "@sweatpants/journal-authority";
import { runWithRenewedActivationLease } from "../activation-lease-coordinator.ts";

describe("activation lease coordinator", () => {
  it("releases asynchronously on host loss without resuming the cancelled caller", async () => {
    const [scope, destroy] = createScope();
    const started = withResolvers<void>();
    let released = false;
    let continued = false;
    const authority = {
      *command(command: { type: string }) {
        if (command.type === "control.claim-activation") {
          return { status: "claimed", epoch: 1 };
        }
        if (command.type === "control.release-activation") {
          // Persistent adapters suspend while committing release during teardown.
          yield* sleep(1);
          released = true;
          return { status: "released", runnable: true };
        }
        throw new Error("unexpected renewal");
      },
    } as unknown as JournalAuthorityContract;
    const task = scope.run(function* () {
      yield* runWithRenewedActivationLease(authority, "session", "owner", function* () {
        started.resolve();
        yield* suspend();
        return { state: "completed", value: null };
      });
      continued = true;
    });
    // The host destroys the operation; no unhandled promise is left behind.
    void task.catch(() => undefined);
    await run(() => started.operation);
    await destroy();
    expect(released).toBe(true);
    expect(continued).toBe(false);
  });

  it("finishes the lease release before returning a completed activation", async () => {
    const events: string[] = [];
    const authority = {
      *command(command: { type: string }) {
        if (command.type === "control.claim-activation") {
          return { status: "claimed", epoch: 1 };
        }
        if (command.type === "control.release-activation") {
          yield* sleep(1);
          events.push("released");
          return { status: "released", runnable: false };
        }
        throw new Error("unexpected renewal");
      },
    } as unknown as JournalAuthorityContract;
    await run(function* () {
      const outcome = yield* runWithRenewedActivationLease(
        authority,
        "session",
        "owner",
        function* () {
          events.push("activated");
          return { state: "completed", value: null };
        },
      );
      expect(outcome).toEqual({ state: "completed", value: null });
      events.push("presented");
    });
    expect(events).toEqual(["activated", "released", "presented"]);
  });

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

it("republishes parked input after host loss without executing or releasing an unclaimed lease", async () => {
  const commands: string[] = [];
  const authority = {
    *command(command: { type: string }) {
      commands.push(command.type);
      return { status: "not_runnable" };
    },
    *query(query: { type: string }) {
      expect(query.type).toBe("forest.replay-plan");
      return {
        rows: [
          {
            classification: "terminal",
            address: { taskId: "old" },
            parked: { pullId: "old", reason: "elicit" },
          },
          {
            classification: "structurally_blocked",
            address: { taskId: "root" },
            parked: { pullId: "child", reason: "child" },
          },
          {
            classification: "replayable",
            address: { taskId: "root.0" },
            parked: { pullId: "reply", reason: "elicit" },
          },
        ],
      };
    },
  } as unknown as JournalAuthorityContract;
  const result = await run(() =>
    runWithRenewedActivationLease(authority, "session", "owner", function* () {
      throw new Error("A parked input must not execute");
    }),
  );
  expect(result).toEqual({
    state: "parked",
    pullId: "reply",
    reason: "elicit",
    slots: [{ taskId: "root.0", pullId: "reply", reason: "elicit" }],
  });
  expect(commands).toEqual(["control.claim-activation"]);
});
