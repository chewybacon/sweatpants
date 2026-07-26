import { describe, expect, it } from "vitest";
import { withTestScenario, type TestApplication } from "./index.ts";

describe("causal scenario lifecycle vocabulary", () => {
  it("replaces only the Host generation while retaining scenario controls", async () => {
    const events: string[] = [];
    let generation = 0;

    await withTestScenario(
      {
        binding: "in-process",
        createApplication(): TestApplication {
          const id = ++generation;
          return {
            async handle() {
              return new Response(null, { status: 204 });
            },
            async close() {
              events.push(`close:${id}`);
            },
            scenario: {
              async gracefulShutdown({ graceMs }) {
                events.push(`shutdown:${id}:${graceMs}`);
              },
              async abandon() {
                events.push(`abandon:${id}`);
              },
              async armFault(point) {
                events.push(`arm:${id}:${point}`);
              },
              async waitForFault(point) {
                events.push(`reached:${id}:${point}`);
              },
              async readHistory(sessionId, cursor) {
                return { generation: id, sessionId, cursor: cursor ?? null };
              },
              async checkpointEvidence(executionId) {
                return { generation: id, executionId };
              },
              async storageMetrics() {
                return { generation: id, completedJournalReads: 0 };
              },
            },
          };
        },
      },
      function* (s) {
        yield* s.host.gracefulShutdown({ graceMs: 25 });
        yield* s.faults.arm("after_execution_terminal");
        yield* s.faults.reached("after_execution_terminal");
        expect(yield* s.history.page("session-1")).toEqual({
          generation: 1,
          sessionId: "session-1",
          cursor: null,
        });
        expect(yield* s.evidence.checkpoint("execution-1")).toEqual({
          generation: 1,
          executionId: "execution-1",
        });
        expect(yield* s.evidence.storageMetrics()).toEqual({
          generation: 1,
          completedJournalReads: 0,
        });

        yield* s.host.replace();
        expect(yield* s.history.page("session-2", "cursor-2")).toEqual({
          generation: 2,
          sessionId: "session-2",
          cursor: "cursor-2",
        });

        yield* s.host.abandon();
        expect(yield* s.evidence.storageMetrics()).toEqual({
          generation: 3,
          completedJournalReads: 0,
        });
      },
    );

    expect(events).toEqual([
      "shutdown:1:25",
      "arm:1:after_execution_terminal",
      "reached:1:after_execution_terminal",
      "close:1",
      "abandon:2",
      "close:3",
    ]);
  });
});
