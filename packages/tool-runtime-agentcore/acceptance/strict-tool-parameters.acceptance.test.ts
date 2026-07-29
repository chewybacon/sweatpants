import { createToolInventoryEntry } from "@sweatpants/tool-session/tool-inventory";
import { run, resource, type Operation } from "effection";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createTool } from "@sweatpants/agent-sdk";
import { type ToolSession, type ToolSessionRegistry } from "@sweatpants/tool-session";
import { createAgentCoreToolRuntimeDriver } from "../src/index.ts";

const remoteTool = createTool("remote_echo")
  .description("Remote echo")
  .parameters(z.object({ message: z.string() }))
  .execute(function* () {
    return { unreachable: true };
  });

function createCompletedSession(): ToolSession {
  return {
    id: "call-remote",
    toolName: "remote_echo",
    status() {
      return (function* () {
        return "completed" as const;
      })();
    },
    events() {
      return resource(function* (provide) {
        let emitted = false;
        yield* provide({
          *next() {
            if (emitted) {
              return { done: true as const, value: undefined };
            }
            emitted = true;
            return {
              done: false as const,
              value: {
                type: "result" as const,
                lsn: 1,
                timestamp: Date.now(),
                result: { echoed: "hello" },
              },
            };
          },
        });
      });
    },
    respondToElicit() {
      return (function* () {})();
    },
    respondToSample() {
      return (function* () {})();
    },
    emitWakeUp() {
      return (function* () {})();
    },
    cancel() {
      return (function* () {})();
    },
  };
}

describe("@sweatpants/tool-runtime-agentcore strict parameter acceptance", () => {
  it("rejects invalid params before AgentCore registry/session dispatch and dispatches valid params", async () => {
    await run(function* () {
      const createArgs: unknown[] = [];
      // SAFETY: generic TResult does not affect this strict-input fixture; the
      // fake always returns one protocol-complete session.
      const registry = {
        *create(_tool: unknown, params: unknown): Operation<ToolSession> {
          createArgs.push(params);
          return createCompletedSession();
        },
        *get(): Operation<ToolSession | null> {
          return null;
        },
        *acquire(): Operation<ToolSession> {
          return createCompletedSession();
        },
        *release(): Operation<void> {},
      } as unknown as ToolSessionRegistry;
      const driver = createAgentCoreToolRuntimeDriver({
        tools: [remoteTool],
        registry,
        samplingProvider: {
          *sample() {
            return { text: "unused" };
          },
        },
      });

      try {
        yield* driver.execute({
          entry: createToolInventoryEntry(remoteTool),
          call: {
            id: "call-invalid-agentcore",
            type: "function",
            function: { name: "remote_echo", arguments: {} },
          },
        });
        throw new Error("expected validation failure");
      } catch (error) {
        expect(error).toMatchObject({
          code: "TOOL_PARAMETER_VALIDATION_FAILED",
          payload: { toolName: "remote_echo", callId: "call-invalid-agentcore" },
        });
      }
      expect(createArgs).toEqual([]);

      const result = yield* driver.execute({
        entry: createToolInventoryEntry(remoteTool),
        call: {
          id: "call-valid-agentcore",
          type: "function",
          function: { name: "remote_echo", arguments: { message: "hello" } },
        },
      });
      expect(result).toMatchObject({ kind: "completed", result: { echoed: "hello" } });
      expect(createArgs).toEqual([{ message: "hello" }]);
    });
  });

  it("projects AgentCore inventory schemas without leaking runtime schema objects", () => {
    const entry = createToolInventoryEntry(remoteTool);
    expect(entry.definition.parameters).toMatchObject({ required: ["message"] });
    expect((entry.definition.parameters as { safeParse?: unknown }).safeParse).toBeUndefined();
    expect(() => structuredClone(entry.definition)).not.toThrow();
  });
});
