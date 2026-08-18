import { action, createQueue, run, spawn } from "effection";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createTool } from "@sweatpants/agent-sdk";
import { createLocalToolInvocationRuntime, ToolInvocationHostPort } from "../index.ts";

const bookingTool = createTool("invocation_host_booking")
  .description("Invocation host fixture")
  .parameters(z.object({ destination: z.string() }))
  .elicits({
    flight: {
      response: z.object({ flight: z.string() }),
    },
  })
  .execute(function* ({ destination }, context) {
    const selection = yield* context.elicit("flight", {
      message: `Choose a flight to ${destination}`,
    });
    return selection.action === "accept" ? selection.content : { flight: "declined" };
  });

describe("ToolInvocationHost", () => {
  it("couples response delivery with the next crank", async () => {
    const result = await run(function* () {
      yield* createLocalToolInvocationRuntime({});
      const host = yield* ToolInvocationHostPort.use();
      const invocationId = "foreign:session:turn-0/root";

      yield* host.start({
        invocationId,
        tool: bookingTool,
        input: { destination: "NYC" },
      });

      const parked = yield* host.turn({
        invocationId,
        commandId: "pull-0",
        cursor: 0,
      });
      expect(parked).toMatchObject({
        type: "parked",
        ask: { kind: "elicit", key: "flight" },
      });
      if (parked.type !== "parked") throw new Error("expected parked invocation");

      const completed = yield* host.turn({
        invocationId,
        commandId: "pull-1",
        cursor: parked.cursor,
        resume: {
          kind: "elicit",
          requestId: parked.ask.requestId,
          response: { action: "accept", content: { flight: "UA-100" } },
        },
      });
      expect(completed).toEqual({
        type: "completed",
        result: { flight: "UA-100" },
      });

      // A retry of the same crank returns the recorded result and cannot
      // deliver the elicitation response a second time.
      const retried = yield* host.turn({
        invocationId,
        commandId: "pull-1",
        cursor: parked.cursor,
        resume: {
          kind: "elicit",
          requestId: parked.ask.requestId,
          response: { action: "accept", content: { flight: "UA-100" } },
        },
      });
      expect(retried).toEqual(completed);

      yield* host.dispose(invocationId);
      return completed;
    });

    expect(result).toEqual({ type: "completed", result: { flight: "UA-100" } });
  });

  it("routes every control operation through the Style F port", async () => {
    const observed: string[] = [];
    await run(function* () {
      yield* createLocalToolInvocationRuntime({});
      yield* ToolInvocationHostPort.api.around({
        *start([request], next) {
          observed.push(`start:${request.invocationId}`);
          return yield* next(request);
        },
        *turn([request], next) {
          observed.push(`turn:${request.commandId}`);
          return yield* next(request);
        },
        *dispose([invocationId], next) {
          observed.push(`dispose:${invocationId}`);
          return yield* next(invocationId);
        },
      });

      const facade = yield* ToolInvocationHostPort.use();
      const invocationId = "foreign:session:port";
      yield* facade.start({ invocationId, tool: bookingTool, input: { destination: "LHR" } });
      const parked = yield* facade.turn({ invocationId, commandId: "pull-0", cursor: 0 });
      if (parked.type !== "parked") throw new Error("expected parked invocation");
      yield* facade.turn({
        invocationId,
        commandId: "cancel-0",
        cursor: parked.cursor,
        resume: { kind: "cancel", reason: "port test" },
      });
      yield* facade.dispose(invocationId);
    });

    expect(observed).toEqual([
      "start:foreign:session:port",
      "turn:pull-0",
      "turn:cancel-0",
      "dispose:foreign:session:port",
    ]);
  });

  it("aborts active computation without delivering a concurrent semantic cancel", async () => {
    const started = createQueue<void, void>();
    const stopped = createQueue<void, void>();
    const activeTool = createTool("invocation_host_active_abort")
      .description("Active abort fixture")
      .parameters(z.object({}))
      .execute(function* () {
        started.add();
        yield* action<void>(() => () => stopped.add());
        return { unreachable: true };
      });

    await run(function* () {
      yield* createLocalToolInvocationRuntime({});
      const host = yield* ToolInvocationHostPort.use();
      const invocationId = "foreign:session:active-abort";
      yield* host.start({ invocationId, tool: activeTool, input: {} });

      const activeTurn = yield* spawn(function* () {
        try {
          yield* host.turn({ invocationId, commandId: "pull-0", cursor: 0 });
          return "completed" as const;
        } catch (error) {
          return error;
        }
      });
      yield* started.next();

      try {
        yield* host.turn({
          invocationId,
          commandId: "cancel-while-active",
          cursor: 0,
          resume: { kind: "cancel", reason: "superseded" },
        });
        throw new Error("expected active command rejection");
      } catch (error) {
        expect(error).toMatchObject({ code: "command_in_progress" });
      }

      yield* host.dispose(invocationId);
      yield* stopped.next();
      expect(yield* activeTurn).toMatchObject({ code: "command_in_progress" });
    });
  });

  it("uses the same crank for semantic cancellation of parked work", async () => {
    const result = await run(function* () {
      yield* createLocalToolInvocationRuntime({});
      const host = yield* ToolInvocationHostPort.use();
      const invocationId = "foreign:session:cancelled-turn";

      yield* host.start({
        invocationId,
        tool: bookingTool,
        input: { destination: "SFO" },
      });
      const parked = yield* host.turn({
        invocationId,
        commandId: "pull-0",
        cursor: 0,
      });
      if (parked.type !== "parked") throw new Error("expected parked invocation");

      const cancelled = yield* host.turn({
        invocationId,
        commandId: "cancel-0",
        cursor: parked.cursor,
        resume: { kind: "cancel", reason: "user chose another tool" },
      });
      expect(cancelled).toEqual({
        type: "cancelled",
        reason: "user chose another tool",
      });

      yield* host.dispose(invocationId);
      return cancelled;
    });

    expect(result).toEqual({
      type: "cancelled",
      reason: "user chose another tool",
    });
  });
});
