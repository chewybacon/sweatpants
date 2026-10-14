import { expect, it } from "vitest";
import { run } from "effection";
import { assertJson, canonicalDigest } from "@sweatpants/foundation";
import type { DurableProgramContext } from "@sweatpants/durable-execution";
import { rootTool } from "../program-driver/program-driver-chat-program.ts";

it.each([null, 2])("counts only outer rounds with limit %s", async (maxIterations) => {
  let samples = 0;
  let internalTurns = 0;
  const calls = maxIterations === null ? 12 : 1;
  const entries = {
    workflow: {
      model: {
        name: "workflow",
        description: "A delegated workflow",
        parameters: { type: "object" },
      },
      execution: {
        kind: "program" as const,
        target: "workflow",
        program: { id: "workflow", version: "1", digest: "a".repeat(64) },
      },
    },
  };
  const context: DurableProgramContext = {
    *pull(descriptor) {
      if (
        descriptor !== null &&
        typeof descriptor === "object" &&
        !Array.isArray(descriptor) &&
        descriptor.kind === "invoke"
      ) {
        // Many child interactions are resolved within one delegated invocation.
        for (let turn = 0; turn < 20; turn++) {
          internalTurns++;
        }
        return "child completed";
      }
      samples++;
      return assertJson({
        message: {
          message: {
            role: "assistant",
            content:
              samples <= calls
                ? [
                    {
                      type: "tool-call",
                      toolCall: {
                        id: `call-${samples}`,
                        name: "workflow",
                        input: {},
                        thoughtSignature: null,
                      },
                    },
                  ]
                : [{ type: "text", text: "done" }],
          },
          source: null,
          usage: null,
          stopReason: null,
          responseId: null,
          errorMessage: null,
        },
        output: { type: "message" },
      });
    },
    *emit() {},
    *effect() {
      throw new Error("Unexpected effect");
    },
    *record() {
      throw new Error("Unexpected record");
    },
  };
  const result = await run(() =>
    rootTool.program(
      {
        contextSource: {
          type: "conversation",
          conversationId: "conversation",
          checkpoint: { checkpointId: "checkpoint" },
          acceptedCommandId: "command",
          executionId: "execution",
          taskId: "task",
          taskJournalFrontier: "current",
        },
        maxIterations,
        catalog: { version: 1, digest: canonicalDigest({ version: 1, entries }), entries },
      },
      context,
    ),
  );
  expect(result).toBe("done");
  expect(samples).toBe(calls + 1);
  expect(internalTurns).toBe(calls * 20);
});
