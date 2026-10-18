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

/**
 * Contract fixture, not an authoring example: it deliberately declares every
 * input of the elicit binding identity (context contract, response contract,
 * authored metadata) so the host projection is checked against the complete
 * identity, not just the common subset.
 */
const bindingIdentityTool = createTool("invocation_host_binding_identity")
  .description("Binding identity contract fixture")
  .parameters(z.object({}))
  .elicits({
    choose: {
      context: z.object({ options: z.array(z.string()) }),
      response: z.object({ choice: z.string() }),
      metadata: { ui: "choice" },
    },
  })
  .execute(function* (_input, context) {
    return yield* context.elicit("choose", {
      message: "Choose one",
      context: { options: ["one", "two"] },
    });
  });

describe("ToolInvocationHost", () => {
  it.each([undefined, "", "stopped"])(
    "accepts a direct optional cancellation reason (%s) and deduplicates retries",
    async (reason) => {
      await run(function* () {
        yield* createLocalToolInvocationRuntime({});
        const host = yield* ToolInvocationHostPort.use();
        const invocationId = "optional-cancel-reason";
        yield* host.start({ invocationId, tool: bookingTool, input: { destination: "NYC" } });
        const parked = yield* host.turn({ invocationId, commandId: "start", cursor: 0 });
        if (parked.type !== "parked") {
          throw new Error("Expected a parked question");
        }

        const command = { invocationId, commandId: "cancel", cursor: parked.cursor };
        const cancelled = yield* host.turn({ ...command, resume: { kind: "cancel", reason } });
        if (cancelled.type !== "cancelled") {
          throw new Error("Expected cancellation");
        }
        expect(cancelled.reason).toBe(reason);
        const retried = yield* host.turn({
          ...command,
          resume: reason === undefined ? { kind: "cancel" } : { kind: "cancel", reason },
        });
        expect(retried).toEqual(cancelled);
        yield* host.dispose(invocationId);
      });
    },
  );

  it("projects the contract-derived binding identity on parked elicit asks", async () => {
    await run(function* () {
      yield* createLocalToolInvocationRuntime({});
      const host = yield* ToolInvocationHostPort.use();
      const expected = bindingIdentityTool.bindings.elicits["choose"]!;
      yield* host.start({
        invocationId: "ephemeral:session:identity",
        tool: bindingIdentityTool,
        input: {},
      });

      const parked = yield* host.turn({
        invocationId: "ephemeral:session:identity",
        commandId: "pull-0",
        cursor: 0,
      });
      expect(parked).toMatchObject({
        type: "parked",
        ask: {
          kind: "elicit",
          key: "choose",
          binding: expected,
        },
      });
      expect(expected.id).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  it("couples response delivery with the next crank", async () => {
    const result = await run(function* () {
      yield* createLocalToolInvocationRuntime({});
      const host = yield* ToolInvocationHostPort.use();
      const invocationId = "ephemeral:session:turn-0/root";

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
      if (parked.type !== "parked") {
        throw new Error("expected parked invocation");
      }

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
      const invocationId = "ephemeral:session:port";
      yield* facade.start({ invocationId, tool: bookingTool, input: { destination: "LHR" } });
      const parked = yield* facade.turn({ invocationId, commandId: "pull-0", cursor: 0 });
      if (parked.type !== "parked") {
        throw new Error("expected parked invocation");
      }
      yield* facade.turn({
        invocationId,
        commandId: "cancel-0",
        cursor: parked.cursor,
        resume: { kind: "cancel", reason: "port test" },
      });
      yield* facade.dispose(invocationId);
    });

    expect(observed).toEqual([
      "start:ephemeral:session:port",
      "turn:pull-0",
      "turn:cancel-0",
      "dispose:ephemeral:session:port",
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
      const invocationId = "ephemeral:session:active-abort";
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
      const invocationId = "ephemeral:session:cancelled-turn";

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
      if (parked.type !== "parked") {
        throw new Error("expected parked invocation");
      }

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
