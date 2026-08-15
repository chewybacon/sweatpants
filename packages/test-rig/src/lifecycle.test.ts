import { describe, expect, it } from "vitest";
import {
  createChatRuntime,
  withTestRig,
  type TestApplication,
  type TestRigOptions,
} from "./index.ts";

/**
 * Lifecycle tests run the rig against a minimal fake application. They do not
 * need the real framework: the guarantees under test are the rig's own
 * verification, poisoning, timeout, and cleanup semantics.
 */
function idleApplication(): TestApplication {
  return {
    handle: async () =>
      new Response(JSON.stringify({ type: "RUN_ERROR", message: "unused" }), {
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
    ).rejects.toThrow(/barrier_timeout|scenario_timeout|RUN_ERROR|unused|chat_transport_truncated/);
  });

  it("fails teardown when the application observed a checkpoint error", async () => {
    await expect(
      withTestRig(
        {
          ...baseOptions,
          createApplication: () => ({
            ...idleApplication(),
            scenario: {
              async checkpointErrors() {
                return [new Error("checkpoint drift")];
              },
            },
          }),
        },
        async () => "ok",
      ),
    ).rejects.toThrow(/Checkpoint persistence failed during scenario/);
  });

  it("injects scenario options into the strict native request without a legacy input envelope", async () => {
    let captured: Record<string, unknown> | undefined;
    const runtime = createChatRuntime({
      barrierTimeoutMs: 1_000,
      fetch: async (_input, init) => {
        captured = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const conversationId = String(captured["conversationId"]);
        const runId = String(captured["runId"]);
        const userMessage = captured["userMessage"] as {
          id: string;
          role: "user";
          content: string;
        };
        const frames = [
          { type: "RUN_STARTED", threadId: conversationId, runId },
          {
            type: "sweatpants.conversation-window.v1",
            conversationId,
            lineageId: `lineage:${conversationId}`,
            basisRevision: "1",
            windowToken: "window-token",
            windowMode: "reset",
            archiveFrontierOrdinal: "0",
            nextPublicPosition: "1",
            hotRoots: [
              {
                rootId: `message:${userMessage.id}`,
                position: "0",
                kind: "message",
                state: "sealed",
                attribution: {},
                message: userMessage,
                placement: { type: "root", sequence: 0 },
              },
            ],
            sealedCatchupRoots: [],
            applicationState: {},
            olderHistoryCursor: null,
          },
          {
            type: "sweatpants.conversation-authority.v1",
            authority: {
              conversationId,
              revision: "1",
              state: "running",
              activeLogicalTurnId: runId,
              activeExecutionId: `execution:${runId}`,
              latestCompletedExecutionId: null,
            },
          },
          {
            type: "sweatpants.conversation-authority.v1",
            authority: {
              conversationId,
              revision: "2",
              state: "idle",
              activeLogicalTurnId: null,
              activeExecutionId: null,
              latestCompletedExecutionId: `execution:${runId}`,
            },
          },
          { type: "RUN_FINISHED", threadId: conversationId, runId },
        ];
        return new Response(`${frames.map((frame) => JSON.stringify(frame)).join("\n")}\n`, {
          status: 200,
          headers: { "content-type": "application/x-ndjson" },
        });
      },
    });
    const conversation = runtime.handle.conversation({
      conversationId: "native-options",
      systemPrompt: "scenario system prompt",
      initialToolChoice: "required",
      streamOptions: { temperature: 0.25 },
    });
    await conversation.send("hello").complete();

    expect(captured).toMatchObject({
      conversationId: "native-options",
      systemPrompt: "scenario system prompt",
      initialToolChoice: "required",
      streamOptions: { temperature: 0.25 },
    });
    expect(captured).not.toHaveProperty("input");
    runtime.verify();
    await runtime.close();
  });

  it("closes cleanly when the body succeeds with no interactions", async () => {
    const result = await withTestRig(
      { ...baseOptions, createApplication: idleApplication },
      async () => "ok",
    );
    expect(result).toBe("ok");
  });
});
