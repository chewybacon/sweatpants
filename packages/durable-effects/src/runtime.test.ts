import { describe, expect, it } from "vitest";
import {
  effectContractDigest,
  hasLiveDurableEffect,
  registerLiveDurableEffect,
  signalLiveDurableEffect,
} from "./runtime.ts";

describe("durable effect runtime", () => {
  it("commits every effect-contract field into a stable digest", () => {
    const base = {
      name: "test.effect",
      version: "1",
      inputSchema: { digest: "input" },
      outputSchema: { digest: "output" },
      retrySafety: { mode: "repeatable" as const },
    };

    expect(effectContractDigest(base)).toBe(effectContractDigest({ ...base }));
    expect(effectContractDigest(base)).not.toBe(
      effectContractDigest({ ...base, retrySafety: { mode: "unsafe" } }),
    );
  });

  it("scopes cancellation registration to one effect attempt", () => {
    const reasons: Array<string | undefined> = [];
    const release = registerLiveDurableEffect("session", "task", "pull", "attempt", (reason) => {
      reasons.push(reason);
    });

    expect(hasLiveDurableEffect("session", "task", "pull")).toBe(true);
    expect(signalLiveDurableEffect("session", "task", "pull", "cancelled")).toBe(true);
    expect(reasons).toEqual(["cancelled"]);

    release();
    expect(hasLiveDurableEffect("session", "task", "pull")).toBe(false);
  });
});
