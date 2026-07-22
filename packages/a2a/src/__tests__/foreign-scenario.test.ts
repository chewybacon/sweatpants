import { run, spawn } from "effection";
import { describe, expect, it } from "vitest";
import {
  ForeignA2ADurableSession,
  parseForeignA2ATask,
  type ForeignA2AInvocationPin,
} from "../index.ts";
import { createControllableForeignA2AAgent } from "../testing.ts";

const pin: ForeignA2AInvocationPin = {
  cardDigest: "a".repeat(64),
  agentName: "controllable-agent",
  skillId: "research",
  interface: {
    url: "https://controllable.example/a2a",
    protocolBinding: "HTTP+JSON",
    protocolVersion: "1.0",
  },
  extensionUris: [],
  guarantee: {
    level: "task_handle_only",
    source: "base_task_handle",
    negotiatedAt: new Date().toISOString(),
  },
  ambiguityPolicy: "surface",
  invocationId: "controllable-invocation-1",
  initialMessageId: "controllable-message-1",
  requestExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  principalId: "acceptance-caller",
};

function task(state: "input_required" | "completed") {
  return parseForeignA2ATask({
    id: "remote-task-1",
    contextId: "remote-context-1",
    status: {
      state: state === "input_required" ? "TASK_STATE_INPUT_REQUIRED" : "TASK_STATE_COMPLETED",
      ...(state === "input_required"
        ? {
            message: {
              messageId: "remote-question-1",
              role: "agent",
              taskId: "remote-task-1",
              contextId: "remote-context-1",
              parts: [{ text: "Morning or evening?" }],
            },
          }
        : {}),
    },
    artifacts:
      state === "completed"
        ? [{ artifactId: "answer", parts: [{ text: "Take the morning express." }] }]
        : [],
  });
}

describe("causal foreign A2A scenario controls", () => {
  it("drives input-required continuation to terminal completion", async () => {
    const result = await run(function* () {
      const remote = createControllableForeignA2AAgent();
      const session = new ForeignA2ADurableSession({ client: remote.client });

      const starting = yield* spawn(() =>
        session.start({
          pin,
          message: {
            messageId: pin.initialMessageId,
            role: "user",
            parts: [{ text: "Research trains" }],
          },
        }),
      );
      const initial = yield* remote.nextInitial();
      expect(initial.request.message.parts).toEqual([{ text: "Research trains" }]);
      yield* initial.respond({ type: "task", task: task("input_required") });
      const interrupted = yield* starting;
      expect(interrupted.event).toMatchObject({
        type: "interruption",
        interruption: { type: "input_required", taskId: "remote-task-1" },
      });

      const responding = yield* spawn(() =>
        session.respond(interrupted.state, {
          pin,
          taskId: "remote-task-1",
          contextId: "remote-context-1",
          message: {
            messageId: "controllable-continuation-1",
            role: "user",
            parts: [{ text: "Morning" }],
          },
        }),
      );
      const continuation = yield* remote.nextContinuation();
      expect(continuation.request.message.parts).toEqual([{ text: "Morning" }]);
      yield* continuation.respond({ type: "task", task: task("completed") });
      const completed = yield* responding;
      remote.verify();
      return completed;
    });

    expect(result.event).toMatchObject({
      type: "terminal",
      result: {
        status: "completed",
        taskId: "remote-task-1",
        artifacts: [{ artifactId: "answer" }],
      },
    });
  });
});
