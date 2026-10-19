import { expect, it } from "vitest";
import { run } from "effection";
import { DurableProgramCancellation } from "@sweatpants/durable-execution";
import {
  createWorkflowFlow,
  createKernelExecution,
  WorkflowFailure,
  type ExchangeReply,
} from "../index.ts";

const request = { site: "approval", binding: "approval", input: null };
const identity = { kind: "fixture", version: "1", programFormat: "1", snapshotFormat: "1" };

it("passes input and exchange replies through, leaving completed state available to its owner", async () => {
  const replies: ExchangeReply[] = [];
  let disposed = false;
  const state = createKernelExecution(
    { kind: "suspended", suspensionId: "guest-17", request },
    {
      *turn(command) {
        if (command.kind !== "resume") {
          throw Error("Unexpected cancellation");
        }
        replies.push(command.reply);
        return { kind: "completed", value: command.reply.value };
      },
      *capture() {
        return { kernel: identity, programDigest: "p", state: { done: true } };
      },
      *dispose() {
        disposed = true;
      },
    },
  );
  const flow = createWorkflowFlow(function* (input) {
    expect(input).toEqual({ title: "Draft" });
    return state;
  });
  const result = await run(() =>
    flow({ title: "Draft" }, function* (outgoing) {
      expect(outgoing).toEqual(request);
      return { kind: "value", value: "approved" };
    }),
  );
  expect(result).toBe("approved");
  expect(replies).toEqual([{ kind: "value", value: "approved" }]);
  expect(disposed).toBe(false);
  expect((await run(() => state.execution.capture())).state).toEqual({ done: true });
  await run(() => state.execution.dispose());
  expect(disposed).toBe(true);
});

it("delivers guest throw replies and preserves the uncaught guest JSON failure", async () => {
  const failure = { code: "declined", detail: [1, false] };
  const flow = createWorkflowFlow(function* () {
    return createKernelExecution(
      { kind: "suspended", suspensionId: "1", request },
      {
        *turn(command) {
          expect(command).toEqual({
            kind: "resume",
            suspensionId: "1",
            reply: { kind: "throw", value: failure },
          });
          return { kind: "failed", error: failure };
        },
        *capture() {
          throw Error("Unexpected capture");
        },
        *dispose() {},
      },
    );
  });
  const result = run(() =>
    flow(null, function* () {
      return { kind: "throw", value: failure };
    }),
  );
  await expect(result).rejects.toBeInstanceOf(WorkflowFailure);
  await expect(result).rejects.toMatchObject({ value: failure });
});

it("propagates infrastructure failures without injecting a reply or cancelling the guest", async () => {
  const transport = new Error("transport unavailable");
  let turns = 0;
  const flow = createWorkflowFlow(function* () {
    return createKernelExecution(
      { kind: "suspended", suspensionId: "1", request },
      {
        *turn() {
          turns++;
          throw Error("Unexpected guest turn");
        },
        *capture() {
          throw Error("Unexpected capture");
        },
        *dispose() {},
      },
    );
  });
  await expect(
    run(() =>
      flow(null, function* () {
        throw transport;
      }),
    ),
  ).rejects.toBe(transport);
  expect(turns).toBe(0);
});

it("runs cleanup exchanges after logical cancellation and preserves the cancellation reason", async () => {
  const requests: string[] = [];
  const state = createKernelExecution(
    { kind: "suspended", suspensionId: "1", request },
    {
      *turn(command) {
        if (command.kind === "cancel") {
          expect(command.reason).toBe("stop");
          return {
            kind: "suspended",
            suspensionId: "cleanup-2",
            request: { ...request, binding: "cleanup" },
          };
        }
        expect(command).toEqual({
          kind: "resume",
          suspensionId: "cleanup-2",
          reply: { kind: "value", value: "released" },
        });
        return { kind: "cancelled", reason: "stop" };
      },
      *capture() {
        throw Error("Unexpected capture");
      },
      *dispose() {},
    },
  );
  const flow = createWorkflowFlow(function* () {
    return state;
  });
  await expect(
    run(() =>
      flow(null, function* (outgoing) {
        requests.push(outgoing.binding);
        if (requests.length <= 2) {
          throw new DurableProgramCancellation("stop");
        }
        return { kind: "value", value: "released" };
      }),
    ),
  ).rejects.toMatchObject({ name: "DurableProgramCancellation", reason: "stop" });
  expect(requests).toEqual(["approval", "cleanup", "cleanup"]);
});
