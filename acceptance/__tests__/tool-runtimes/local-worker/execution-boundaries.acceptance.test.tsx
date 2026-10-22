import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { call, spawn } from "effection";
import { describe, expect, it } from "vitest";
import { local, type LocalToolInvocationResourceFactory } from "@sweatpants/tool-runtime-local";
import type { ToolExecutionAdapter } from "@sweatpants/tool-session/execution";
import { withTestScenario } from "@sweatpants/test-rig";
import { createApplication } from "../../../fixtures/application.ts";
import { bookTrip } from "../../../fixtures/book-trip.ts";
import { tripPlugin } from "../../../fixtures/trip-chat.tsx";
import { useUI } from "../../../support/ui.tsx";

// Preserve public resource lifecycle observations in addition to client behavior.
function observedOrdinaryExecution() {
  const placement = local({
    worker: resolve("__tests__/tool-runtimes/local-worker/fixtures/tool-worker.mjs"),
  });
  let resources: LocalToolInvocationResourceFactory | undefined;
  const execution: ToolExecutionAdapter = {
    prepare(tools, routeId) {
      const prepared = placement.prepare(tools, routeId);
      const createResources = prepared.createResources!;
      return {
        ...prepared,
        createResources: function* () {
          const factory = yield* createResources();
          resources = factory as LocalToolInvocationResourceFactory;
          return factory;
        },
      };
    },
  };
  return {
    execution,
    resources() {
      if (!resources) {
        throw new Error("Local factory was not installed");
      }
      return resources;
    },
  };
}

describe("ordinary worker exchange failure boundaries", () => {
  for (const mode of [
    "second-question-reconnect",
    "nested-cancel",
    "unacknowledged-loss",
  ] as const) {
    it(`preserves execution ownership through ${mode}`, async () => {
      const directory = await mkdtemp(join(tmpdir(), "acceptance-worker-boundary-"));
      const evidence = join(directory, "attempts.txt");
      const observed = observedOrdinaryExecution();
      try {
        await withTestScenario(
          {
            binding: "http",
            createApplication: (context) =>
              createApplication(context, { tools: [bookTrip], execution: observed.execution }),
          },
          function* (rig) {
            // Arrange / Act: run one real worker through the first typed choice.
            const options = { plugins: [tripPlugin], threadId: "boundary" };
            using first = yield* useUI(rig, options);
            const send = yield* first.waitForEnabledButton("Book trip");
            send.click();
            const outer = yield* rig.model.request();
            yield* outer.respond.toolCalls([
              {
                id: "booking",
                name: "book_trip",
                arguments: {
                  destination: "Oslo",
                  behavior: mode === "unacknowledged-loss" ? "crash_after_resume" : "complete",
                  crashEvidencePath: evidence,
                },
              },
            ]);
            const flight = yield* first.waitForEnabledButton("FL-1");
            flight.click();
            const originalSeat = yield* first.waitForEnabledButton("2B");
            let ui = first;

            // Act: reload at the second choice without repeating the first accepted reply.
            if (mode === "second-question-reconnect") {
              const id = originalSeat.closest("[data-elicit-id]")?.getAttribute("data-elicit-id");
              first[Symbol.dispose]();
              yield* call(() => first.client.close());
              ui = yield* useUI(rig, options);
              yield* call(() => ui.client.reconnect());
              const restored = yield* ui.waitForEnabledButton("2B");
              expect(restored.closest("[data-elicit-id]")?.getAttribute("data-elicit-id")).toBe(id);
              expect(rig.model.requests()).toHaveLength(1);
            }
            const seat = yield* ui.waitForEnabledButton("2B");
            seat.click();
            if (mode !== "unacknowledged-loss") {
              const nested = yield* rig.model.request();
              expect(JSON.stringify(nested.body.input)).toContain("PRIVATE_TRAVEL_TIP");
              if (mode === "nested-cancel") {
                // Act / Assert: stop the real provider request and await worker resource drainage.
                const aborted = yield* spawn(() => nested.respond.awaitAbort());
                yield* call(() => ui.client.stop());
                yield* aborted;
                yield* observed.resources().drained();
                expect(observed.resources().activeIds()).toEqual([]);
              } else {
                yield* nested.respond.text("Bring a book");
              }
            }
            if (mode !== "nested-cancel") {
              const final = yield* rig.model.request();
              if (mode === "unacknowledged-loss") {
                expect(JSON.stringify(final.body.input)).toContain("operation outcome is unknown");
              } else {
                expect(JSON.stringify(final.body.input)).toContain("FL-1");
                expect(JSON.stringify(final.body.input)).toContain("2B");
                expect(JSON.stringify(final.body.input)).toContain("Bring a book");
              }
              yield* final.respond.text("Boundary settled");
              yield* ui.waitForText("Boundary settled");
            }

            // Act / Assert: the same conversation accepts another task after recovery or cancellation.
            const again = yield* ui.waitForEnabledButton("Book trip");
            again.click();
            const next = yield* rig.model.request();
            yield* next.respond.text("Continue safely");
            yield* ui.waitForText("Continue safely");
            yield* ui.waitForEnabledButton("Book trip");
            expect(rig.model.requests()).toHaveLength(mode === "second-question-reconnect" ? 4 : 3);
          },
        );
        if (mode === "unacknowledged-loss") {
          expect(await readFile(evidence, "utf8")).toBe("booking-attempt\n");
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
});
