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
import { each, run, sleep, spawn, type Operation } from "effection";
import { createWorkerToolSession } from "@sweatpants/tool-runtime-local";
import type { ToolSessionEvent } from "@sweatpants/framework/chat/mcp-tools";

const PROBE_WORKER_URL = new URL("./lib/worker-probe-bootstrap.mjs", import.meta.url);

interface ProbeResult {
  isMainThread: boolean;
  threadId: number;
  pid: number;
}

function* waitForProbeResult(
  session: Awaited<ReturnType<typeof createWorkerToolSession>> extends Operation<infer S>
    ? S
    : never,
  timeoutMs: number,
): Operation<ProbeResult> {
  const events: ToolSessionEvent[] = [];
  yield* spawn(function* () {
    for (const event of yield* each(session.events())) {
      events.push(event);
      yield* each.next();
    }
  });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const event of events) {
      if (event.type === "result") {
        return (event as { result: ProbeResult }).result;
      }
      if (event.type === "error") {
        throw new Error(
          `worker probe failed: ${(event as { message?: string }).message ?? "unknown"}`,
        );
      }
    }
    yield* sleep(25);
  }
  throw new Error("timed out waiting for worker probe result");
}

describe("outside-in worker boundary (Tier A)", () => {
  it("runs tool execute generators off the main thread in a genuine worker", async () => {
    await run(function* () {
      const session = yield* createWorkerToolSession({
        sessionId: "worker-probe-1",
        toolName: "worker_probe",
        params: {},
        workerUrl: PROBE_WORKER_URL,
      });

      const result = yield* waitForProbeResult(session, 20_000);

      // The whole point: this ran OFF the main thread.
      expect(result.isMainThread).toBe(false);
      expect(result.threadId).toBeGreaterThan(0);
      expect(result.pid).toBe(process.pid); // worker_threads share the pid
    });
  }, 30_000);
});
