// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { withTestScenario, type TestRigOptions } from "@sweatpants/test-rig";
import { mountReactChat } from "./react-scenario.ts";
import {
  REACT_BOOKING_RESULT_MARKER,
  REACT_BOOKING_TOOL_NAME,
} from "./fixtures/react-booking.tool.ts";
import { reactBookingPlugin } from "./fixtures/react-booking.plugin.tsx";
import {
  createReactAcceptanceApplication,
  REACT_ACCEPTANCE_MODEL_ID,
} from "./react-acceptance-app.ts";

type Binding = TestRigOptions["binding"];

async function runHookProjection(binding: Binding): Promise<void> {
  await withTestScenario(
    {
      binding,
      modelId: REACT_ACCEPTANCE_MODEL_ID,
      createApplication: createReactAcceptanceApplication,
      scenarioTimeoutMs: 30_000,
    },
    function* (s) {
      const ui = yield* mountReactChat(s, {
        plugins: [reactBookingPlugin],
        initialToolChoice: "required",
        pipeline: "markdown",
      });

      yield* ui.send("Book the React acceptance route");
      const outer = yield* s.model.request({ model: REACT_ACCEPTANCE_MODEL_ID });
      expect(JSON.stringify(outer.body.tools)).toContain(REACT_BOOKING_TOOL_NAME);
      yield* outer.respond.toolCalls([
        {
          id: "react-booking-call-1",
          name: REACT_BOOKING_TOOL_NAME,
          arguments: { route: "NYC-LAX" },
        },
      ]);

      const emission = yield* ui.emission({
        toolName: REACT_BOOKING_TOOL_NAME,
        componentKey: "FlightChoice",
        status: "pending",
      });
      expect(emission.props).toMatchObject({
        flights: ["FL-REACT-1", "FL-REACT-2"],
        message: "Choose a flight for NYC-LAX",
      });
      yield* emission.respond({ flightId: "FL-REACT-1" });

      const completedEmission = yield* ui.emission({
        toolName: REACT_BOOKING_TOOL_NAME,
        componentKey: "FlightChoice",
        status: "complete",
      });
      expect(completedEmission.id).toBe(emission.id);

      const final = yield* s.model.request({ model: REACT_ACCEPTANCE_MODEL_ID });
      const serialized = JSON.stringify(final.body.input);
      expect(serialized).toContain("react-booking-call-1");
      expect(serialized).toContain(REACT_BOOKING_RESULT_MARKER);
      expect(serialized).toContain("FL-REACT-1");
      yield* final.respond.text("**React booking complete.**");

      const message = yield* ui.message({
        role: "assistant",
        containing: "React booking complete.",
      });
      expect(message.html).toContain("<strong>React booking complete.</strong>");

      const snapshot = yield* ui.settled();
      expect(snapshot.isStreaming).toBe(false);
      expect(snapshot.error).toBeNull();
      expect(snapshot.session.state.pendingElicits).toEqual({});
      expect(ui.events().some((entry) => entry.event.type === "TEXT_MESSAGE_CONTENT")).toBe(true);
    },
  );
}

async function runRemountProjection(binding: Binding): Promise<void> {
  await withTestScenario(
    {
      binding,
      modelId: REACT_ACCEPTANCE_MODEL_ID,
      createApplication: createReactAcceptanceApplication,
      scenarioTimeoutMs: 30_000,
    },
    function* (s) {
      const options = {
        conversationId: "react-remount-conversation",
        plugins: [reactBookingPlugin],
        initialToolChoice: "required" as const,
        pipeline: "markdown" as const,
      };
      const firstUi = yield* mountReactChat(s, options);
      yield* firstUi.send("Book before React remount");
      const outer = yield* s.model.request({ model: REACT_ACCEPTANCE_MODEL_ID });
      yield* outer.respond.toolCalls([
        {
          id: "react-remount-call-1",
          name: REACT_BOOKING_TOOL_NAME,
          arguments: { route: "SFO-SEA" },
        },
      ]);
      const staleEmission = yield* firstUi.emission({
        componentKey: "FlightChoice",
        status: "pending",
      });
      yield* firstUi.unmount();
      try {
        yield* staleEmission.respond({ flightId: "FL-REACT-1" });
        throw new Error("stale React emission responder unexpectedly succeeded");
      } catch (error) {
        expect(error instanceof Error ? error.message : String(error)).toMatch(/harness is closed/);
      }

      const resumedUi = yield* mountReactChat(s, options);
      const resumedEmission = yield* resumedUi.emission({
        componentKey: "FlightChoice",
        status: "pending",
      });
      expect(resumedEmission.id).toBe(staleEmission.id);
      expect(
        resumedUi.events().filter((entry) => entry.event.type === "RUN_FINISHED"),
      ).toHaveLength(1);
      yield* resumedEmission.respond({ flightId: "FL-REACT-2" });

      const final = yield* s.model.request({ model: REACT_ACCEPTANCE_MODEL_ID });
      expect(JSON.stringify(final.body.input)).toContain("FL-REACT-2");
      yield* final.respond.text("Remounted React session completed.");
      const message = yield* resumedUi.message({
        role: "assistant",
        containing: "Remounted React session completed.",
      });
      expect(message.text).toBe("Remounted React session completed.");
      const settled = yield* resumedUi.settled();
      expect(settled.session.toolEmissions.flatMap((tracking) => tracking.emissions)).toHaveLength(
        1,
      );
    },
  );
}

describe.each<Binding>(["in-process", "http"])(
  "React hook-state projection through the %s binding",
  (binding) => {
    it("projects AG-UI, executes the plugin, resumes the tool, and renders the result", async () => {
      await runHookProjection(binding);
    }, 30_000);

    it("restores a parked plugin emission after remount without retaining a stale responder", async () => {
      await runRemountProjection(binding);
    }, 30_000);
  },
);
