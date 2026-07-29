import { run, sleep } from "effection";
import { describe, expect, it } from "vitest";

import type { DurableJournalAuthorityService } from "@sweatpants/journal-authority";
import {
  createHostRecoveryCoordinator,
  recoverKnownWorkOnStartup,
} from "./host-recovery-coordinator.ts";

describe("host recovery coordinator", () => {
  it("performs a bounded readable startup sweep and isolates failures", async () => {
    const authority = {
      *recoverableSessions() {
        return [
          { sessionId: "expired", reason: "expired_activation" as const },
          { sessionId: "runnable", reason: "runnable" as const },
        ];
      },
    } as unknown as DurableJournalAuthorityService;
    const result = await run(() =>
      recoverKnownWorkOnStartup(authority, {
        *activate(session) {
          if (session.sessionId === "expired") {
            throw new Error("placement unavailable");
          }
        },
      }),
    );
    expect(result).toEqual({
      attempted: ["expired", "runnable"],
      failed: ["expired"],
    });
  });

  it("stops admission and aborts active Effection scopes on warm shutdown", async () => {
    const coordinator = createHostRecoveryCoordinator();
    let finalized = false;
    const running = run(() =>
      coordinator.run(
        "session",
        (function* () {
          try {
            yield* sleep(10_000);
            return "finished";
          } finally {
            finalized = true;
          }
        })(),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    const shutdown = await run(() => coordinator.shutdown());
    expect(shutdown).toEqual({ unfinishedSessionIds: ["session"] });
    await expect(running).rejects.toMatchObject({ code: "host_shutting_down" });
    expect(finalized).toBe(true);
    expect(coordinator.accepting()).toBe(false);
  });
});
