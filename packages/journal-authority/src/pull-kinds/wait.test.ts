import { run } from "effection";
import { describe, expect, it } from "vitest";

import { createWaitPullResolver } from "./wait.ts";

const placement = {
  program: { id: "wait-program", version: "1", digest: "a".repeat(64) },
  route: { driverKind: "workflow" },
  driverKind: "workflow",
  executionEpoch: 1,
};

describe("wait pull resolver", () => {
  it("delays until the accepted deadline and returns the scheduler settlement", async () => {
    const delays: number[] = [];
    const resolver = createWaitPullResolver({
      now: () => 1_000,
      *delay(durationMs) {
        delays.push(durationMs);
      },
    });

    const outcome = await run(function* () {
      return yield* resolver.perform(
        { sessionId: "wait-session", taskId: "turn-0/root", pullId: "wait-pull", placement },
        { kind: "wait", key: "brief-pause", notBefore: new Date(1_250).toISOString() },
      );
    });

    expect(delays).toEqual([250]);
    expect(resolver.audience({ kind: "wait" })).toBe("scheduler");
    expect(outcome).toEqual({ status: "ok", value: null });
  });

  it("does not delay after the deadline", async () => {
    let delayed = false;
    const resolver = createWaitPullResolver({
      now: () => 2_000,
      *delay() {
        delayed = true;
      },
    });

    await run(function* () {
      yield* resolver.perform(
        { sessionId: "wait-session", taskId: "turn-0/root", pullId: "wait-pull", placement },
        { kind: "wait", key: "already-due", notBefore: new Date(1_000).toISOString() },
      );
    });

    expect(delayed).toBe(false);
  });
});
