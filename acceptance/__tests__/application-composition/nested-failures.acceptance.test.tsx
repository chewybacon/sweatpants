import { describe, expect, it } from "vitest";
import { withTestScenario } from "@sweatpants/test-rig";
import { createApplication } from "../../fixtures/application.ts";
import { bookTrip } from "../../fixtures/book-trip.ts";
import { tripPlugin } from "../../fixtures/trip-chat.tsx";
import { testToolRuntime } from "../../support/test-tool-runtime.ts";
import { useUI } from "../../support/ui.tsx";
import { waitForSnapshot } from "../../support/client.ts";

const options = {
  binding: "http" as const,
  createApplication: (context: Parameters<typeof createApplication>[0]) =>
    createApplication(context, { tools: [bookTrip], execution: testToolRuntime() }),
};

describe("nested tool failures", () => {
  for (const failure of ["throw_after_resume", "sample_failure", "final_failure"] as const) {
    it(`preserves call/result history and recovers from ${failure}`, async () => {
      await withTestScenario(options, function* (rig) {
        // Arrange: author an ordinary interactive tool and the real plugin.
        using ui = yield* useUI(rig, { plugins: [tripPlugin] });
        const send = yield* ui.waitForEnabledButton("Book trip");
        send.click();
        const request = yield* rig.model.request();
        yield* request.respond.toolCalls([
          {
            id: "nested-failure",
            name: "book_trip",
            arguments: {
              destination: "Oslo",
              behavior: failure === "throw_after_resume" ? failure : "complete",
            },
          },
        ]);

        // Act: complete two public plugin interactions before the failure boundary.
        const flight = yield* ui.waitForEnabledButton("FL-2");
        flight.click();
        const seat = yield* ui.waitForEnabledButton("2B");
        seat.click();
        if (failure !== "throw_after_resume") {
          const nested = yield* rig.model.request();
          expect(JSON.stringify(nested.body.input)).toContain("PRIVATE_TRAVEL_TIP");
          if (failure === "sample_failure") {
            yield* nested.respond.error({
              code: "nested_failed",
              message: "Planned nested failure",
              status: 503,
            });
          } else {
            yield* nested.respond.text("Nested sample succeeded");
          }
        }
        if (failure === "sample_failure") {
          yield* waitForSnapshot(ui.client, (state) => state.status === "error");
        } else {
          const final = yield* rig.model.request();
          expect(JSON.stringify(final.body.input)).toContain("nested-failure");
          if (failure === "final_failure") {
            expect(JSON.stringify(final.body.input)).toContain("booked");
            yield* final.respond.error({
              code: "final_failed",
              message: "Planned final failure",
              status: 503,
            });
            yield* waitForSnapshot(ui.client, (state) => state.status === "error");
          } else {
            expect(JSON.stringify(final.body.input)).toMatch(/error|fail/i);
            yield* final.respond.text("Tool failed after resume");
            yield* ui.waitForText("Tool failed after resume");
          }
        }

        // Act: send a successor through the same public hook.
        const again = yield* ui.waitForEnabledButton("Book trip");
        again.click();
        const recovery = yield* rig.model.request();
        const history = JSON.stringify(recovery.body.input);

        // Assert: successful results survive; private prompts and implementation paths do not.
        expect(history).toContain("nested-failure");
        if (failure === "final_failure") {
          expect(history).toContain("Nested sample succeeded");
        } else {
          expect(history).toMatch(/error|fail/i);
        }
        expect(history).not.toContain("PRIVATE_TRAVEL_TIP");
        expect(history).not.toContain("worker-tool-adapter.ts");
        yield* recovery.respond.text("Recovered nested turn");
        yield* ui.waitForText("Recovered nested turn");
        yield* ui.waitForEnabledButton("Book trip");
        expect(ui.client.getSnapshot().error).toBeNull();
      });
    });
  }
});
