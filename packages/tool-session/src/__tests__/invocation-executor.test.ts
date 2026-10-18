import { expect, it } from "vitest";
import { run, scoped } from "effection";
import {
  advanceToolInvocation,
  createToolInvocationExecutor,
  ToolInvocationExecutor,
} from "../invocation-executor.ts";
import type { StartToolInvocation, ToolInvocationHost, TurnToolInvocation } from "../invocation.ts";

it("preserves durable command identity and cursor across a retried pull", async () => {
  const commands: TurnToolInvocation[] = [];
  const host: ToolInvocationHost = {
    *start() {},
    *turn(command) {
      commands.push(command);
      return { type: "parked", cursor: 9, ask: { kind: "sample", requestId: "ask", messages: [] } };
    },
    *dispose() {},
  };
  const command: TurnToolInvocation = {
    invocationId: "invocation",
    commandId: "durable-pull",
    cursor: 4,
    resume: { kind: "sample", requestId: "previous", response: { text: "answer" } },
  };
  const first = await run(() => advanceToolInvocation(host, command));
  const retried = await run(() => advanceToolInvocation(host, command));
  expect(retried).toEqual(first);
  expect(first).toEqual({
    kind: "suspended",
    suspensionId: "9:ask",
    request: { kind: "sample", requestId: "ask", messages: [], cursor: 9 },
  });
  expect(commands).toEqual([command, command]);
  expect(commands[0]).toBe(command);
});

it("rejects mismatched replies before dispatch and advances with the parked cursor", async () => {
  const commands: TurnToolInvocation[] = [];
  let disposed = 0;
  const host: ToolInvocationHost = {
    *start() {},
    *turn(command) {
      commands.push(command);
      if (commands.length === 1)
        return {
          type: "parked",
          cursor: 7,
          ask: { kind: "sample", requestId: "ask", messages: [] },
        };
      return { type: "completed", result: "done" };
    },
    *dispose() {
      disposed++;
    },
  };
  // Host double does not execute a tool; only the invocation identity matters here.
  const program = { invocationId: "invocation", tool: {} as StartToolInvocation["tool"] };
  const observed: string[] = [];
  const { execution } = await run(function* () {
    yield* ToolInvocationExecutor.api.around({
      *start([program, input], next) {
        observed.push(program.invocationId);
        return yield* next(program, input);
      },
    });
    yield* ToolInvocationExecutor.installDriver(createToolInvocationExecutor(host));
    return yield* scoped(function* () {
      const executor = yield* ToolInvocationExecutor.context.expect();
      return yield* executor.start(program, null);
    });
  });
  expect(observed).toEqual(["invocation"]);
  await expect(
    run(() =>
      execution.resume("7:ask", {
        kind: "sample",
        requestId: "wrong",
        response: { text: "answer" },
      }),
    ),
  ).rejects.toThrow("execution_suspension_mismatch");
  expect(commands).toHaveLength(1);
  expect(
    await run(() =>
      execution.resume("7:ask", {
        kind: "sample",
        requestId: "ask",
        response: { text: "answer" },
      }),
    ),
  ).toEqual({ kind: "completed", value: "done" });
  expect(commands[1]?.cursor).toBe(7);
  expect(commands[1]?.commandId).not.toBe(commands[0]?.commandId);
  await expect(
    run(() =>
      execution.resume("7:ask", {
        kind: "sample",
        requestId: "ask",
        response: { text: "answer" },
      }),
    ),
  ).rejects.toThrow("execution_suspension_mismatch");
  await run(() => execution.dispose());
  expect(disposed).toBe(1);
});

it("allows cancellation to suspend for cleanup before reaching a terminal boundary", async () => {
  const commands: TurnToolInvocation[] = [];
  const host: ToolInvocationHost = {
    *start() {},
    *turn(command) {
      commands.push(command);
      if (command.resume?.kind === "sample") return { type: "cancelled", reason: "stopped" };
      return {
        type: "parked",
        cursor: commands.length,
        ask: { kind: "sample", requestId: command.resume ? "cleanup" : "work", messages: [] },
      };
    },
    *dispose() {},
  };
  const { execution } = await run(() =>
    createToolInvocationExecutor(host).start(
      {
        invocationId: "invocation",
        tool: {} as StartToolInvocation["tool"],
      },
      null,
    ),
  );
  expect(await run(() => execution.cancel("stopped"))).toMatchObject({
    kind: "suspended",
    suspensionId: "2:cleanup",
  });
  expect(commands[1]?.resume).toEqual({ kind: "cancel", reason: "stopped" });
  expect(
    await run(() =>
      execution.resume("2:cleanup", {
        kind: "sample",
        requestId: "cleanup",
        response: { text: "released" },
      }),
    ),
  ).toEqual({ kind: "cancelled", reason: "stopped" });
  await run(() => execution.dispose());
});

it("fails closed without an executor installed in the caller's scope", async () => {
  await expect(
    run(function* () {
      const executor = yield* ToolInvocationExecutor.use();
      return yield* executor.start(
        {
          invocationId: "unconfigured",
          tool: {} as StartToolInvocation["tool"],
        },
        null,
      );
    }),
  ).rejects.toThrow("No tool invocation executor is installed");
});
