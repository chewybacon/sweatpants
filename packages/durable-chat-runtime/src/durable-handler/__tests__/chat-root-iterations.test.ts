import { expect, it } from "vitest";
import { run } from "effection";
import { assertJson, canonicalDigest } from "@sweatpants/foundation";
import type { DurableProgramContext } from "@sweatpants/durable-execution";
import { rootTool } from "../program-driver/program-driver-chat-program.ts";

it.each([null, 2])("counts only outer rounds with limit %s", async (maxIterations) => {
  const events: unknown[] = [];
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
        events.push({ event: "invoke" });
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
                    { type: "text", text: `Starting workflow ${samples}` },
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
    *emit(event, payload) {
      events.push({ event, payload });
    },
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
  // Narration must be published before invoking a workflow that can park.
  // Each round's narration and the final answer appear exactly once.
  expect(events).toEqual([
    ...Array.from({ length: calls }, (_, index) => [
      { event: "assistant_text", payload: { text: `Starting workflow ${index + 1}` } },
      {
        event: "tool_started",
        payload: { callId: `call-${index + 1}`, tool: "workflow", input: {} },
      },
      { event: "invoke" },
      {
        event: "tool_completed",
        payload: {
          callId: `call-${index + 1}`,
          tool: "workflow",
          result: "child completed",
          failed: false,
        },
      },
    ]).flat(),
    { event: "assistant_text", payload: { text: "done" } },
  ]);
});
