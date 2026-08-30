import { describe, expect, it } from "vitest";
import { run } from "effection";
import { createDurableEffectRegistration } from "../authoring.ts";
import {
  DurableEffectRegistryContext,
  createDurableEffectRegistry,
  effectContractDigest,
  hasLiveDurablePull,
  registerLiveDurablePull,
  signalLiveDurablePull,
  useDurableEffectRegistry,
} from "../runtime.ts";

describe("durable effect runtime", () => {
  it("commits every effect-contract field into a stable digest", () => {
    const descriptor = (digest: string, role: "effect_input" | "effect_output") => ({
      identity: `test.${digest}`,
      role,
      version: "1",
      vendor: "test",
      inputProjection: {},
      outputProjection: {},
      fidelity: { input: "explicit" as const, output: "explicit" as const },
      digest,
    });
    const base = {
      name: "test.effect",
      version: "1",
      inputSchema: descriptor("input", "effect_input"),
      outputSchema: descriptor("output", "effect_output"),
      retrySafety: { mode: "repeatable" as const },
    };

    expect(effectContractDigest(base)).toBe(effectContractDigest({ ...base }));
    expect(effectContractDigest(base)).not.toBe(
      effectContractDigest({ ...base, retrySafety: { mode: "unsafe" } }),
    );
  });

  it("owns the exact scoped registration registry identity", async () => {
    const definition = {
      name: "test.registry",
      version: "1",
      inputSchema: {
        identity: "test.registry/input",
        role: "effect_input" as const,
        version: "1",
        vendor: "test",
        inputProjection: true,
        outputProjection: true,
        fidelity: { input: "explicit" as const, output: "explicit" as const },
        digest: "input",
      },
      outputSchema: {
        identity: "test.registry/output",
        role: "effect_output" as const,
        version: "1",
        vendor: "test",
        inputProjection: true,
        outputProjection: true,
        fidelity: { input: "explicit" as const, output: "explicit" as const },
        digest: "output",
      },
      retrySafety: { mode: "repeatable" as const },
    };
    const registration = createDurableEffectRegistration(
      definition,
      definition.retrySafety,
      function* () {
        return { status: "ok", value: null };
      },
    );
    const registry = createDurableEffectRegistry([registration], [definition]);
    await expect(
      run(function* () {
        return yield* DurableEffectRegistryContext.with(registry, useDurableEffectRegistry);
      }),
    ).resolves.toBe(registry);
  });

  it("scopes cancellation registration to one effect attempt", () => {
    const reasons: Array<string | undefined> = [];
    const release = registerLiveDurablePull("session", "task", "pull", "attempt", (reason) => {
      reasons.push(reason);
    });

    expect(hasLiveDurablePull("session", "task", "pull")).toBe(true);
    expect(signalLiveDurablePull("session", "task", "pull", "cancelled")).toBe(true);
    expect(reasons).toEqual(["cancelled"]);

    release();
    expect(hasLiveDurablePull("session", "task", "pull")).toBe(false);
  });
});
