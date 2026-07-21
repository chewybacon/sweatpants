import { describe, expect, it } from "vitest";
import { withTestRig, type TestApplication, type TestRigOptions } from "./index.ts";

/**
 * Lifecycle tests run the rig against a minimal fake application. They do not
 * need the real framework: the guarantees under test are the rig's own
 * verification, poisoning, timeout, and cleanup semantics.
 */
function idleApplication(): TestApplication {
  return {
    handle: async () =>
      new Response(JSON.stringify({ lsn: 0, event: { type: "RUN_ERROR", message: "unused" } }), {
        status: 200,
      }),
    close: async () => {},
  };
}

const baseOptions: Omit<TestRigOptions, "createApplication"> = {
  binding: "in-process",
  barrierTimeoutMs: 300,
  scenarioTimeoutMs: 2_000,
  cancellationTimeoutMs: 1_000,
};

describe("withTestRig lifecycle", () => {
  it("fails a successful body that leaves an unclaimed model expectation", async () => {
    await expect(
      withTestRig({ ...baseOptions, createApplication: idleApplication }, async (rig) => {
        // Register but never satisfy; swallow its rejection so the leak is the
        // only signal.
        rig.model.expectRequest({ model: "never" }).catch(() => undefined);
        // Body "passes" without waiting on anything.
        await new Promise((resolve) => setTimeout(resolve, 50));
      }),
    ).rejects.toThrow(/unclaimed model expectation/);
  });

  it("poisons the rig on scenario timeout and rejects late handle use", async () => {
    let leaked: (() => unknown) | undefined;
    await expect(
      withTestRig(
        { ...baseOptions, scenarioTimeoutMs: 200, createApplication: idleApplication },
        async (rig) => {
          leaked = () => rig.model;
          // Never resolves: force the scenario timeout to fire.
          await new Promise(() => {});
        },
      ),
    ).rejects.toThrow(/scenario_timeout/);
    expect(leaked).toBeDefined();
    expect(() => leaked!()).toThrow(/scenario_timeout/);
  });

  it("preserves the body error as primary when cleanup also finds leaks", async () => {
    const sentinel = new Error("SENTINEL_BODY_FAILURE");
    await expect(
      withTestRig({ ...baseOptions, createApplication: idleApplication }, async (rig) => {
        rig.model.expectRequest({ model: "never" }).catch(() => undefined);
        throw sentinel;
      }),
    ).rejects.toBe(sentinel);
  });

  it("times out an unmatched model barrier with a poisoned diagnostic", async () => {
    await expect(
      withTestRig({ ...baseOptions, createApplication: idleApplication }, async (rig) => {
        await rig.model.expectRequest({ model: "never-arrives" });
      }),
    ).rejects.toThrow(/barrier_timeout/);
  });

  it("rejects conversation turn completion when the scenario is poisoned", async () => {
    await expect(
      withTestRig(
        { ...baseOptions, scenarioTimeoutMs: 300, createApplication: idleApplication },
        async (rig) => {
          const conversation = rig.chat.conversation();
          const turn = conversation.send("hello");
          await turn.complete();
        },
      ),
    ).rejects.toThrow(/barrier_timeout|scenario_timeout|RUN_ERROR|unused/);
  });

  it("closes cleanly when the body succeeds with no interactions", async () => {
    const result = await withTestRig(
      { ...baseOptions, createApplication: idleApplication },
      async () => "ok",
    );
    expect(result).toBe("ok");
  });
});
