import { createToolInventoryEntry } from "@sweatpants/tool-runtime";
import { run } from "effection";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createTool } from "@sweatpants/agent-sdk";
import {
  createAgentCoreRemoteToolRuntimeClient,
  createAgentCoreToolRuntimeDriver,
  streamFromAgentCoreResponses,
  type AgentCoreInvokeInput,
  type AgentCoreInvoker,
} from "@sweatpants/tool-runtime-agentcore";

const remoteTool = createTool("remote_echo")
  .description("Remote echo")
  .parameters(z.object({ message: z.string() }))
  .execute(function* () {
    return { unreachable: true };
  });

// This deterministic adapter contract does not certify AWS transport or credentials.
describe("AgentCore adapter strict parameter contract", () => {
  it("rejects invalid params before AgentCore dispatch and dispatches valid params", async () => {
    await run(function* () {
      const invocations: AgentCoreInvokeInput[] = [];
      const simulator: AgentCoreInvoker = {
        *invoke(input) {
          invocations.push(input);
          return streamFromAgentCoreResponses([
            {
              type: "tool_event",
              toolSessionId: input.payload.toolSessionId,
              runtimeEventSeq: 1,
              runtimeEventId: `${input.payload.commandId}:result`,
              event: { type: "result", result: { echoed: "hello" } },
            },
          ]);
        },
      };
      const runtimeClient = createAgentCoreRemoteToolRuntimeClient(simulator);
      const driver = yield* createAgentCoreToolRuntimeDriver({
        tools: [remoteTool],
        samplingProvider: {
          *sample() {
            return { text: "unused" };
          },
        },
        runtime: {
          runtimeClient,
          profiles: [
            {
              name: "test",
              runtimeArn: "arn:agentcore:test",
              endpointName: "DEFAULT",
              region: "us-east-1",
              toolNames: [remoteTool.name],
              maxSessionTtlMs: 60_000,
            },
          ],
          createRuntimeSessionId: () => "strict-params-runtime",
        },
      });

      try {
        yield* driver.execute({
          entry: createToolInventoryEntry(remoteTool),
          call: {
            id: "call-invalid-agentcore",
            name: "remote_echo",
            input: {},
            thoughtSignature: null,
          },
        });
        throw new Error("expected validation failure");
      } catch (error) {
        expect(error).toMatchObject({
          code: "TOOL_PARAMETER_VALIDATION_FAILED",
          payload: { toolName: "remote_echo", callId: "call-invalid-agentcore" },
        });
      }
      expect(invocations).toEqual([]);

      const result = yield* driver.execute({
        entry: createToolInventoryEntry(remoteTool),
        call: {
          id: "call-valid-agentcore",
          name: "remote_echo",
          input: { message: "hello" },
          thoughtSignature: null,
        },
      });
      expect(result).toMatchObject({ kind: "completed" });
      expect(invocations[0]?.payload).toMatchObject({
        op: "start_tool_session",
        params: { message: "hello" },
      });
    });
  });

  it("projects AgentCore inventory schemas without leaking runtime schema objects", () => {
    const entry = createToolInventoryEntry(remoteTool);
    expect(entry.definition.parameters).toMatchObject({ required: ["message"] });
    expect((entry.definition.parameters as { safeParse?: unknown }).safeParse).toBeUndefined();
    expect(() => structuredClone(entry.definition)).not.toThrow();
  });
});
