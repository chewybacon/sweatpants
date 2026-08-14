// @vitest-environment jsdom
import { EventType } from "@ag-ui/core";
import { call, createQueue, resource, spawn, type Operation } from "effection";
import { describe, expect, it } from "vitest";
import { withTestScenario, type TestRigOptions } from "@sweatpants/test-rig";
import { type ReactSchedulerDriver } from "../src/index.ts";
import { discardReactChatClient, mountReactChat } from "./react-scenario.ts";
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

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function createControlledScheduler(): {
  readonly driver: ReactSchedulerDriver;
  readonly pullCount: number;
  readonly releasedTickCount: number;
  reached(count: number): Operation<void>;
  release(): Operation<void>;
} {
  const ticks = createQueue<void, never>();
  const reached = new Map<Deferred, number>();
  let pulls = 0;
  let releasedTicks = 0;
  return {
    driver: {
      clock: () =>
        resource(function* (provide) {
          yield* provide({
            *next() {
              pulls += 1;
              for (const [waiter, count] of reached) {
                if (pulls >= count) {
                  waiter.resolve();
                  reached.delete(waiter);
                }
              }
              return yield* ticks.next();
            },
          });
        }),
    },
    get pullCount() {
      return pulls;
    },
    get releasedTickCount() {
      return releasedTicks;
    },
    *reached(count): Operation<void> {
      if (pulls < count) {
        const waiter = deferred();
        reached.set(waiter, count);
        yield* call(() => waiter.promise);
      }
    },
    *release(): Operation<void> {
      if (pulls <= releasedTicks) {
        throw new Error("No clock pull is waiting for a tick");
      }
      releasedTicks += 1;
      ticks.add(undefined);
    },
  };
}

async function runHookProjection(binding: Binding): Promise<void> {
  await withTestScenario(
    {
      binding,
      modelId: REACT_ACCEPTANCE_MODEL_ID,
      createApplication: createReactAcceptanceApplication,
      scenarioTimeoutMs: 30_000,
      // jsdom mount plus React act() dominates the first barrier in this suite.
      // Measured loaded latency is seconds, so the inner backstop must not fire
      // before the declared scenario budget it is supposed to protect.
      barrierTimeoutMs: 20_000,
    },
    function* (s) {
      const aguiStart = s.agui.mark();
      const privateSystemPrompt = "__REACT_PRIVATE_SYSTEM_PROMPT__";
      const ui = yield* mountReactChat(s, {
        threadId: "react-hook-projection",
        plugins: [reactBookingPlugin],
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

      const render = yield* ui.render({
        toolName: REACT_BOOKING_TOOL_NAME,
        componentKey: "FlightChoice",
        status: "pending",
      });
      expect(render.props).toMatchObject({
        flights: ["FL-REACT-1", "FL-REACT-2"],
        message: "Choose a flight for NYC-LAX",
      });
      yield* render.respond({ flightId: "FL-REACT-1" });
      const afterRender = yield* ui.snapshot();
      expect(() => JSON.stringify(afterRender.client.getServerSnapshot())).not.toThrow();
      expect(JSON.stringify(afterRender.client.getServerSnapshot())).not.toContain(
        '"type":"render"',
      );

      const completedRender = yield* ui.render({
        toolName: REACT_BOOKING_TOOL_NAME,
        componentKey: "FlightChoice",
        status: "complete",
      });
      expect(completedRender.id).toBe(render.id);
      const pendingAfterLocalRender = yield* ui.snapshot();
      expect(JSON.stringify(pendingAfterLocalRender.messages)).toContain('"state":"pending"');
      const confirmation = yield* ui.render({
        toolName: REACT_BOOKING_TOOL_NAME,
        componentKey: "ConfirmationChoice",
        status: "pending",
      });
      expect(confirmation.props).toMatchObject({ message: "Confirm FL-REACT-1" });
      yield* confirmation.respond({ confirmed: true });
      const completedConfirmation = yield* ui.render({
        componentKey: "ConfirmationChoice",
        status: "complete",
      });
      expect(completedConfirmation.id).toBe(confirmation.id);

      const final = yield* s.model.request({ model: REACT_ACCEPTANCE_MODEL_ID });
      const awaitingFinal = yield* ui.snapshot();
      expect(["submitted", "streaming"]).toContain(awaitingFinal.status);
      expect(awaitingFinal.canSendMessage).toBe(false);
      const finalRun = s.agui.mark();
      const serialized = JSON.stringify(final.body.input);
      expect(serialized).toContain("react-booking-call-1");
      expect(serialized).toContain(REACT_BOOKING_RESULT_MARKER);
      expect(serialized).toContain("FL-REACT-1");
      expect(serialized).toContain("normalized");
      yield* final.respond.text("**React booking complete.**");

      const message = yield* ui.message({
        role: "assistant",
        containing: "React booking complete.",
      });
      expect(message.text).toContain("React booking complete.");

      const snapshot = yield* ui.settled();
      expect(snapshot.status).toBe("ready");
      expect(snapshot.error).toBeNull();
      expect(JSON.stringify(snapshot.messages)).not.toContain('"state":"pending"');
      expect(JSON.stringify(snapshot.messages)).toContain('"state":"completed"');
      yield* s.agui.event("RUN_FINISHED", { after: finalRun });
      s.agui.assertConformant({ after: aguiStart });
      const emitted = s.agui.events(aguiStart);
      expect(JSON.stringify(emitted)).not.toContain(privateSystemPrompt);
      expect(
        emitted
          .filter((event) => event.type === EventType.MESSAGES_SNAPSHOT)
          .some((event) =>
            Array.isArray(event["messages"])
              ? event["messages"].some(
                  (message) =>
                    typeof message === "object" &&
                    message !== null &&
                    (message as { role?: unknown }).role === "system",
                )
              : false,
          ),
      ).toBe(false);
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
      // jsdom mount plus React act() dominates the first barrier in this suite.
      // Measured loaded latency is seconds, so the inner backstop must not fire
      // before the declared scenario budget it is supposed to protect.
      barrierTimeoutMs: 20_000,
    },
    function* (s) {
      const options = {
        threadId: "react-remount-conversation",
        plugins: [reactBookingPlugin],
        pipeline: "markdown" as const,
      };
      const aguiStart = s.agui.mark();
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
      const staleRender = yield* firstUi.render({
        componentKey: "FlightChoice",
        status: "pending",
      });
      yield* firstUi.unmount();
      yield* discardReactChatClient(s, options.threadId);
      try {
        yield* staleRender.respond({ flightId: "FL-REACT-1" });
        throw new Error("stale React render responder unexpectedly succeeded");
      } catch (error) {
        expect(error instanceof Error ? error.message : String(error)).toMatch(/harness is closed/);
      }

      const resumedUi = yield* mountReactChat(s, options);
      const resumedRender = yield* resumedUi.render({
        componentKey: "FlightChoice",
        status: "pending",
      });
      expect(resumedRender.id).toBe(staleRender.id);
      expect(resumedRender.status).toBe("pending");
      yield* resumedRender.respond({ flightId: "FL-REACT-2" });
      const resumedConfirmation = yield* resumedUi.render({
        componentKey: "ConfirmationChoice",
        status: "pending",
      });
      yield* resumedConfirmation.respond({ confirmed: true });

      const final = yield* s.model.request({ model: REACT_ACCEPTANCE_MODEL_ID });
      const awaitingFinal = yield* resumedUi.snapshot();
      expect(["submitted", "streaming"]).toContain(awaitingFinal.status);
      expect(awaitingFinal.canSendMessage).toBe(false);
      const finalRun = s.agui.mark();
      expect(JSON.stringify(final.body.input)).toContain("FL-REACT-2");
      yield* final.respond.text("Remounted React session completed.");
      const message = yield* resumedUi.message({
        role: "assistant",
        containing: "Remounted React session completed.",
      });
      expect(message.text).toBe("Remounted React session completed.");
      const settled = yield* resumedUi.settled();
      expect(JSON.stringify(settled.messages)).not.toContain('"state":"pending"');
      yield* s.agui.event("RUN_FINISHED", { after: finalRun });
      s.agui.assertConformant({ after: aguiStart });

      const successor = yield* spawn(() => resumedUi.send("Book again after remount"));
      const next = yield* s.model.request({ model: REACT_ACCEPTANCE_MODEL_ID });
      expect(JSON.stringify(next.body.input)).toContain("Book again after remount");
      yield* next.respond.text("Post-remount booking started.");
      yield* resumedUi.message({ role: "assistant", containing: "Post-remount booking started" });
      yield* successor;
      yield* resumedUi.unmount();
    },
  );
}

async function runParkedInterruptSuccessor(binding: Binding): Promise<void> {
  await withTestScenario(
    {
      binding,
      modelId: REACT_ACCEPTANCE_MODEL_ID,
      createApplication: createReactAcceptanceApplication,
      scenarioTimeoutMs: 15_000,
      barrierTimeoutMs: 5_000,
    },
    function* (s) {
      const ui = yield* mountReactChat(s, {
        threadId: "react-parked-interrupt-successor",
        plugins: [reactBookingPlugin],
        pipeline: "markdown",
        queue: "interrupt",
      });
      yield* ui.send("Book before replacing the parked turn");
      const outer = yield* s.model.request({ model: REACT_ACCEPTANCE_MODEL_ID });
      yield* outer.respond.toolCalls([
        {
          id: "react-parked-interrupt-call",
          name: REACT_BOOKING_TOOL_NAME,
          arguments: { route: "SFO-SEA" },
        },
      ]);
      yield* ui.render({ componentKey: "FlightChoice", status: "pending" });

      const cancellationStart = s.agui.mark();
      // Real overlap: the replacement stays local while the interrupt policy
      // terminalizes the authoritative parked Turn.
      const successor = yield* spawn(() => ui.send("Start a replacement booking"));
      const cancellation = yield* s.agui.event(EventType.RUN_ERROR, {
        after: cancellationStart,
      });
      expect(cancellation).toMatchObject({ code: "PROGRAM_CANCELLED" });
      expect(JSON.stringify(s.agui.events(cancellationStart))).not.toContain(
        "Start a replacement booking",
      );

      const replacement = yield* s.model.request({ model: REACT_ACCEPTANCE_MODEL_ID });
      expect(JSON.stringify(replacement.body.input)).toContain("Start a replacement booking");
      yield* replacement.respond.text("Replacement booking started.");
      yield* ui.message({ role: "assistant", containing: "Replacement booking started" });
      yield* successor;
      yield* ui.unmount();
    },
  );
}

async function runCompletedSuccessor(binding: Binding): Promise<void> {
  await withTestScenario(
    {
      binding,
      modelId: REACT_ACCEPTANCE_MODEL_ID,
      createApplication: createReactAcceptanceApplication,
      scenarioTimeoutMs: 15_000,
      barrierTimeoutMs: 5_000,
    },
    function* (s) {
      const ui = yield* mountReactChat(s, {
        threadId: "react-completed-successor",
        plugins: [reactBookingPlugin],
        pipeline: "markdown",
      });
      yield* ui.send("Book before starting another turn");
      const outer = yield* s.model.request({ model: REACT_ACCEPTANCE_MODEL_ID });
      yield* outer.respond.toolCalls([
        {
          id: "react-completed-successor-call",
          name: REACT_BOOKING_TOOL_NAME,
          arguments: { route: "SFO-SEA" },
        },
      ]);
      const flight = yield* ui.render({ componentKey: "FlightChoice", status: "pending" });
      yield* flight.respond({ flightId: "FL-REACT-2" });
      const confirmation = yield* ui.render({
        componentKey: "ConfirmationChoice",
        status: "pending",
      });
      yield* confirmation.respond({ confirmed: true });
      const final = yield* s.model.request({ model: REACT_ACCEPTANCE_MODEL_ID });
      const awaitingFinal = yield* ui.snapshot();
      expect(["submitted", "streaming"]).toContain(awaitingFinal.status);
      expect(awaitingFinal.canSendMessage).toBe(false);
      yield* final.respond.text("First booking completed.");
      yield* ui.message({ role: "assistant", containing: "First booking completed" });
      const completed = yield* ui.settled();
      expect(completed.canSendMessage).toBe(true);
      expect(completed.authority?.state).toBe("idle");

      const successor = yield* spawn(() => ui.send("Start another booking"));
      const next = yield* s.model.request({ model: REACT_ACCEPTANCE_MODEL_ID });
      expect(JSON.stringify(next.body.input)).toContain("Start another booking");
      yield* next.respond.text("Second booking started.");
      yield* ui.message({ role: "assistant", containing: "Second booking started" });
      yield* successor;
      yield* ui.unmount();
    },
  );
}

describe.each<Binding>(["in-process", "http"])(
  "completed successor through the %s binding",
  (binding) => {
    it("accepts a new message after an elicited tool turn completes", async () => {
      await runCompletedSuccessor(binding);
    }, 20_000);
  },
);

describe.each<Binding>(["in-process", "http"])(
  "parked interrupt successor through the %s binding",
  (binding) => {
    it("terminalizes the parked turn before submitting the local successor", async () => {
      await runParkedInterruptSuccessor(binding);
    }, 20_000);
  },
);

describe("React client live compaction", () => {
  it("buffers simulator tokens until one controlled client pull", async () => {
    const scheduler = createControlledScheduler();
    await withTestScenario(
      {
        binding: "in-process",
        modelId: REACT_ACCEPTANCE_MODEL_ID,
        createApplication: createReactAcceptanceApplication,
        scenarioTimeoutMs: 30_000,
        barrierTimeoutMs: 20_000,
      },
      function* (s) {
        const ui = yield* mountReactChat(s, {
          threadId: "react-live-compaction",
          scheduler: scheduler.driver,
          pipeline: "markdown",
        });
        yield* ui.send("Stream into a slow client pull");
        const request = yield* s.model.request({ model: REACT_ACCEPTANCE_MODEL_ID });
        const stream = yield* request.respond.textStream(["BUFFERED_", "TOKEN_", "BATCH"]);

        for (const expected of ["BUFFERED_", "TOKEN_", "BATCH"]) {
          const after = s.agui.mark();
          yield* stream.releaseNext();
          yield* s.agui.event(EventType.TEXT_MESSAGE_CONTENT, { after });
          expect(
            s.agui
              .events(after)
              .some(
                (event) =>
                  event.type === EventType.TEXT_MESSAGE_CONTENT && event.delta === expected,
              ),
          ).toBe(true);
        }

        yield* scheduler.reached(1);
        expect(scheduler.pullCount).toBe(1);
        const beforePull = yield* ui.snapshot();
        expect(JSON.stringify(beforePull.messages)).not.toContain("BUFFERED_TOKEN_BATCH");

        yield* scheduler.release();
        const compacted = yield* ui.message({
          role: "assistant",
          containing: "BUFFERED_TOKEN_BATCH",
        });
        expect(compacted.text).toBe("BUFFERED_TOKEN_BATCH");
        expect(scheduler.releasedTickCount).toBe(1);

        const terminal = s.agui.mark();
        yield* stream.finish();
        yield* s.agui.event(EventType.RUN_FINISHED, { after: terminal });
        yield* scheduler.reached(2);
        yield* scheduler.release();
        const settled = yield* ui.settled();
        expect(settled.status).toBe("ready");
      },
    );
  }, 30_000);
});

describe.each<Binding>(["in-process", "http"])(
  "React hook-state projection through the %s binding",
  (binding) => {
    it("projects AG-UI, executes the plugin, resumes the tool, and renders the result", async () => {
      await runHookProjection(binding);
    }, 30_000);

    it("restores a parked render in a fresh client without retaining a stale responder", async () => {
      await runRemountProjection(binding);
    }, 30_000);
  },
);
