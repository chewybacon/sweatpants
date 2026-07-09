import { describe, expect, it } from "vitest";
import { run, resource, type Operation } from "effection";
import { z } from "zod";
import { createTool } from "@sweatpants/core";
import { ToolRuntimeApi, createToolInventory } from "@sweatpants/framework/chat";
import { type ToolSessionRegistry, type ToolSession } from "@sweatpants/framework/chat/mcp-tools";
import {
  FakeAgentCoreRemoteToolRuntimeClient,
  createAgentCoreToolExecutionStrategy,
  createAgentCoreToolInventoryEntry,
  createAgentCoreToolRuntimeDriver,
  createAgentCoreToolSessionRegistry,
  createInMemoryAgentCoreToolSessionEventStore,
  createInMemoryAgentCoreToolSessionHandleStore,
  installAgentCoreToolRuntime,
  type AgentCoreToolRuntimeProfile,
  type AgentCoreToolSessionStores,
} from "../index.ts";

const remoteTool = createTool("remote_echo")
  .description("Remote echo")
  .parameters(z.object({ message: z.string() }))
  .execute(function* () {
    return { unreachable: true };
  });

const remoteElicitTool = createTool("remote_elicit")
  .description("Remote elicit")
  .parameters(z.object({}))
  .execute(function* () {
    return { unreachable: true };
  });

const remoteSampleTool = createTool("remote_sample")
  .description("Remote sample")
  .parameters(z.object({}))
  .execute(function* () {
    return { unreachable: true };
  });

const samplingProvider = {
  *sample() {
    return { text: "hello from sample provider" };
  },
};

function createStores(): AgentCoreToolSessionStores {
  return {
    handles: createInMemoryAgentCoreToolSessionHandleStore(),
    events: createInMemoryAgentCoreToolSessionEventStore(),
  };
}

function createProfile(toolNames: string[]): AgentCoreToolRuntimeProfile {
  return {
    name: "test-profile",
    runtimeArn: "arn:aws:bedrock-agentcore:us-east-1:123:runtime/test",
    endpointName: "DEFAULT",
    region: "us-east-1",
    toolNames,
    maxSessionTtlMs: 60_000,
  };
}

function createFakeSession(): ToolSession {
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
            if (emitted) return { done: true as const, value: undefined };
            emitted = true;
            return {
              done: false as const,
              value: {
                type: "result" as const,
                lsn: 1,
                timestamp: Date.now(),
                result: { ok: true },
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
    cancel() {
      return (function* () {})();
    },
  };
}

function createFakeRegistry(): ToolSessionRegistry {
  const session = createFakeSession();
  return {
    *create(): Operation<ToolSession> {
      return session;
    },
    *get(): Operation<ToolSession | null> {
      return session;
    },
    *acquire(): Operation<ToolSession> {
      return session;
    },
    *release(): Operation<void> {},
  };
}

describe("AgentCore ToolRuntimeDriver", () => {
  it("lists tools and adapts AgentCore registry sessions", async () => {
    await run(function* () {
      const driver = createAgentCoreToolRuntimeDriver({
        tools: [remoteTool],
        registry: createFakeRegistry(),
        samplingProvider,
      });

      const tools = yield* driver.listTools();
      expect(tools.map((tool) => tool.name)).toEqual(["remote_echo"]);

      const session = yield* driver.startToolCall({
        toolName: "remote_echo",
        callId: "call-remote",
        arguments: { message: "hello" },
      });
      expect(session.runtimeId).toBe("agentcore");

      const events = yield* session.events();
      const next = yield* events.next();
      expect(next.done).toBe(false);
      if (!next.done) {
        expect(next.value.type).toBe("result");
      }
    });
  });

  it("rejects invalid params before AgentCore session creation", async () => {
    await run(function* () {
      let createCalls = 0;
      const registry: ToolSessionRegistry = {
        *create(): Operation<ToolSession> {
          createCalls++;
          return createFakeSession();
        },
        *get(): Operation<ToolSession | null> {
          return null;
        },
        *acquire(): Operation<ToolSession> {
          return createFakeSession();
        },
        *release(): Operation<void> {},
      };
      const driver = createAgentCoreToolRuntimeDriver({
        tools: [remoteTool],
        registry,
        samplingProvider,
      });

      try {
        yield* driver.execute({
          entry: createAgentCoreToolInventoryEntry(remoteTool),
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
          payload: {
            toolName: "remote_echo",
            callId: "call-invalid-agentcore",
          },
        });
      }

      expect(createCalls).toBe(0);
    });
  });

  it("resumes AgentCore elicitation from the response boundary instead of replaying stale state", async () => {
    const stores = createStores();
    const runtime = new FakeAgentCoreRemoteToolRuntimeClient();
    const registry = createAgentCoreToolSessionRegistry({
      stores,
      runtimeClient: runtime,
      profiles: [createProfile(["remote_elicit"])],
      createRuntimeSessionId: () => "runtime-elicit",
    });

    await run(function* () {
      const driver = createAgentCoreToolRuntimeDriver({
        tools: [remoteElicitTool],
        registry,
        samplingProvider,
      });
      const entry = createAgentCoreToolInventoryEntry(remoteElicitTool);

      const initial = yield* driver.execute({
        entry,
        call: {
          id: "call-elicit",
          type: "function",
          function: { name: "remote_elicit", arguments: {} },
        },
      });
      expect(initial).toMatchObject({ kind: "awaiting_elicit" });
      if (initial.kind !== "awaiting_elicit") return;

      const resumed = yield* driver.resume({
        ref: initial.ref,
        input: {
          type: "elicit_response",
          elicitId: initial.request.elicitId,
          result: { action: "accept", content: { confirmed: true } },
        },
      });

      expect(resumed).toMatchObject({ kind: "completed", result: { confirmed: true } });
    });
  });

  it("passes selected chat model into AgentCore start context and handle metadata", async () => {
    const stores = createStores();
    const runtime = new FakeAgentCoreRemoteToolRuntimeClient();
    const registry = createAgentCoreToolSessionRegistry({
      stores,
      runtimeClient: runtime,
      profiles: [createProfile(["remote_echo"])],
      createRuntimeSessionId: () => "runtime-model-context",
    });

    await run(function* () {
      const driver = createAgentCoreToolRuntimeDriver({
        tools: [remoteTool],
        registry,
        samplingProvider,
      });
      const entry = createAgentCoreToolInventoryEntry(remoteTool);
      yield* driver.execute({
        entry,
        call: {
          id: "call-model-context",
          type: "function",
          function: { name: "remote_echo", arguments: { message: "hello" } },
        },
        metadata: { model: { provider: "amazon-bedrock", id: "zai.glm-5" } },
      });

      const startInvocation = runtime.invocations.find(
        (entry) => entry.op === "start_tool_session",
      );
      expect(startInvocation?.request).toMatchObject({
        context: { model: { provider: "amazon-bedrock", id: "zai.glm-5" } },
      });
      const handle = yield* stores.handles.get("call-model-context");
      expect(handle?.metadata?.selectedModel).toEqual({
        provider: "amazon-bedrock",
        id: "zai.glm-5",
      });
    });
  });

  it("handles AgentCore sample_request events via the sampling provider", async () => {
    const stores = createStores();
    const runtime = new FakeAgentCoreRemoteToolRuntimeClient();
    const registry = createAgentCoreToolSessionRegistry({
      stores,
      runtimeClient: runtime,
      profiles: [createProfile(["remote_sample"])],
      createRuntimeSessionId: () => "runtime-sample",
    });

    await run(function* () {
      const driver = createAgentCoreToolRuntimeDriver({
        tools: [remoteSampleTool],
        registry,
        samplingProvider,
      });
      const entry = createAgentCoreToolInventoryEntry(remoteSampleTool, { profile: "test" });

      const result = yield* driver.execute({
        entry,
        call: {
          id: "call-sample",
          type: "function",
          function: { name: "remote_sample", arguments: {} },
        },
      });

      expect(result).toMatchObject({
        kind: "completed",
        result: { text: "hello from sample provider" },
      });
    });
  });

  it("creates AgentCore inventory entries and normalized executions", async () => {
    const entry = createAgentCoreToolInventoryEntry(remoteTool, { profile: "test" });
    expect(entry.definition).toMatchObject({ name: "remote_echo", description: "Remote echo" });
    expect(entry.definition.parameters).toMatchObject({ required: ["message"] });
    expect((entry.definition.parameters as { safeParse?: unknown }).safeParse).toBeUndefined();
    expect("implementation" in entry.definition).toBe(false);
    expect(entry.capabilities).toMatchObject({
      remote: true,
      session: true,
      elicits: true,
      samples: true,
    });
    expect(() => createToolInventory([entry, entry])).toThrow("Duplicate tool name");

    await run(function* () {
      const driver = createAgentCoreToolRuntimeDriver({
        tools: [remoteTool],
        registry: createFakeRegistry(),
        samplingProvider,
      });
      const result = yield* driver.execute({
        entry,
        call: {
          id: "call-remote",
          type: "function",
          function: { name: "remote_echo", arguments: { message: "hello" } },
        },
      });
      expect(result).toMatchObject({ kind: "completed", result: { ok: true } });
      expect(result.ref).toMatchObject({
        runtimeId: "agentcore",
        callId: "call-remote",
        toolName: "remote_echo",
        sessionId: "call-remote",
      });

      try {
        yield* driver.execute({
          entry: { definition: { name: "unsupported", description: "nope", parameters: {} } },
          call: {
            id: "call-bad",
            type: "function",
            function: { name: "unsupported", arguments: {} },
          },
        });
        throw new Error("expected unsupported tool");
      } catch (error) {
        expect(error).toMatchObject({ code: "NO_MATCHING_TOOL_STRATEGY" });
      }

      try {
        yield* driver.resume({
          ref: {
            runtimeId: "agentcore",
            executionId: "call-remote",
            sessionId: "call-remote",
            callId: "call-remote",
            toolName: "other_tool",
          },
          input: { type: "elicit_response", elicitId: "elicit", result: { action: "accept" } },
        });
        throw new Error("expected wrong tool");
      } catch (error) {
        expect(error).toMatchObject({ code: "EXECUTION_NOT_FOUND" });
      }
    });
  });

  it("exports an executable AgentCore strategy object", async () => {
    await run(function* () {
      const strategy = createAgentCoreToolExecutionStrategy({
        registry: createFakeRegistry(),
        samplingProvider,
        tools: [remoteTool],
      });
      const entry = createAgentCoreToolInventoryEntry(remoteTool);
      expect(
        strategy.canExecute(
          entry,
          { id: "call-remote", type: "function", function: { name: "remote_echo", arguments: {} } },
          { runtimeId: "agentcore" },
        ),
      ).toBe(true);
      const result = yield* strategy.execute(
        entry,
        {
          id: "call-remote",
          type: "function",
          function: { name: "remote_echo", arguments: { message: "hello" } },
        },
        { runtimeId: "agentcore" },
      );
      expect(result).toMatchObject({ kind: "completed", result: { ok: true } });
    });
  });

  it("installer sets ToolRuntimeContext for ToolRuntimeApi", async () => {
    await run(function* () {
      yield* installAgentCoreToolRuntime({
        tools: [remoteTool],
        registry: createFakeRegistry(),
        samplingProvider,
      });
      const result = yield* ToolRuntimeApi.execute({
        entry: createAgentCoreToolInventoryEntry(remoteTool),
        call: {
          id: "call-installed-agentcore",
          type: "function",
          function: { name: "remote_echo", arguments: { message: "hello" } },
        },
      });
      expect(result).toMatchObject({ kind: "completed", result: { ok: true } });
    });
  });
});
