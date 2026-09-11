/**
 * Worker boundary coverage (design R8 / G3 / C4).
 *
 * Proves that Tier A's worker-backed tool runtime actually executes tool
 * `execute` generators OFF the main thread, in a genuine worker spawned from a
 * `.ts` entry via tsx. A worker-only marker (`isMainThread`) is asserted so an
 * in-process fallback masquerading as a worker cannot pass silently.
 *
 * This test needs NO model and NO server — it is the fast, first-class regression
 * guard for the just-restored worker serialization boundary.
 */
import { describe, expect, it } from "vitest";
import { run } from "effection";
import { z } from "zod";
import { createTool } from "@sweatpants/agent-sdk";
import {
  createLocalToolInvocationRuntime,
  createToolInvocationEphemeralEffectRegistrations,
} from "@sweatpants/tool-runtime-local";
import { ToolInvocationHostPort } from "@sweatpants/tool-session";
import { calculator } from "@/tools/calculator";
import { yoChatToolSessionWorkerConfig } from "@/server/tool-worker-config";

const PROBE_WORKER_URL = new URL("../lib/worker-probe-bootstrap.mjs", import.meta.url);

const probeResultSchema = z
  .object({
    isMainThread: z.boolean(),
    threadId: z.number().int(),
    pid: z.number().int(),
  })
  .strict();

type ProbeResult = z.infer<typeof probeResultSchema>;

const workerProbe = createTool("worker_probe")
  .description("Report the worker-thread identity")
  .parameters(z.object({}))
  .execute(function* () {
    throw new Error("worker probe must execute in the configured worker");
  });

describe("outside-in worker boundary (Tier A)", () => {
  it("executes the generated calculator tool in the real worker", async () => {
    await run(function* () {
      yield* createLocalToolInvocationRuntime({
        worker: yoChatToolSessionWorkerConfig,
      });
      const [start] = createToolInvocationEphemeralEffectRegistrations({
        tools: new Map([[calculator.name, calculator]]),
      });
      const disposition = yield* start.handler(
        {
          driver: "tool-session",
          tool: calculator.name,
          input: { expression: "2+2" },
          durability: "ephemeral_handle",
        },
        {
          sessionId: "calculator-ephemeral-smoke",
          taskId: "turn-0/root.0",
          pullId: "pull-calculator",
          attemptId: "attempt-calculator",
          cancellation: new AbortController().signal,
          resolver: { audience: "ephemeral:tool-session" },
        },
      );
      expect(disposition).toMatchObject({
        status: "ok",
        value: {
          type: "completed",
          result: { result: 4, error: null },
        },
      });
    });
  }, 30_000);

  it("runs tool execute generators off the main thread in a genuine worker", async () => {
    await run(function* () {
      yield* createLocalToolInvocationRuntime({
        worker: { workerUrl: PROBE_WORKER_URL },
      });
      const host = yield* ToolInvocationHostPort.use();
      yield* host.start({
        invocationId: "worker-probe-1",
        tool: workerProbe,
        input: {},
      });
      const turn = yield* host.turn({
        invocationId: "worker-probe-1",
        commandId: "worker-probe:start",
        cursor: 0,
      });
      if (turn.type !== "completed") {
        throw new Error(`worker probe did not complete: ${turn.type}`);
      }
      const result: ProbeResult = probeResultSchema.parse(turn.result);

      // The whole point: this ran OFF the main thread.
      expect(result.isMainThread).toBe(false);
      expect(result.threadId).toBeGreaterThan(0);
      expect(result.pid).toBe(process.pid); // worker_threads share the pid
    });
  }, 30_000);
});
