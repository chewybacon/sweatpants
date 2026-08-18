import {
  createStrategyToolRuntime,
  createToolInventoryEntry,
  type ToolRuntime,
} from "@sweatpants/tool-runtime";
import { describe, expect, it } from "vitest";
import { run, resource, type Operation } from "effection";
import { z } from "zod";
import { createTool, type AnyToolContract } from "@sweatpants/agent-sdk";
import { ToolRuntimeApi } from "@sweatpants/tool-runtime";
import { createToolInventory } from "@sweatpants/tool-runtime";
import {
  createToolInvocationHost,
  ToolInvocationEventSourcePort,
  ToolInvocationHostPort,
  type StartToolInvocation,
  type ToolInvocationResource,
  type ToolInvocationResourceFactory,
  type ToolSession,
} from "@sweatpants/tool-session";
import {
  FakeAgentCoreRemoteToolRuntimeClient,
  createAgentCoreToolExecutionStrategy,
  installAgentCoreToolRuntime,
  type AgentCoreToolRuntimeProfile,
} from "../index.ts";
import {
  createAgentCoreToolInvocationResources,
  type AgentCoreToolInvocationResources,
} from "../agentcore-invocation-resources.ts";
import {
  createInMemoryAgentCoreToolSessionEventStore,
  createInMemoryAgentCoreToolSessionHandleStore,
} from "../agentcore-memory-store.ts";
import type { AgentCoreToolSessionStores } from "../agentcore-types.ts";

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
    projection: {
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
                  result: { ok: true },
                },
              };
            },
          });
        });
      },
    },
    resume() {
      return (function* () {})();
    },
  };
}

function createFakeResources(): AgentCoreToolInvocationResources {
  const session = createFakeSession();
  // SAFETY: generic result typing is irrelevant to this completed-session
  // driver fixture; every create returns the same protocol-complete fake.
  return {
    *create(): Operation<ToolSession> {
      return session;
    },
    *get(): Operation<ToolSession | null> {
      return session;
    },
    *dispose(): Operation<void> {},
  } as unknown as AgentCoreToolInvocationResources;
}

function invocationResource(
  session: ToolSession,
  resources: AgentCoreToolInvocationResources,
): ToolInvocationResource {
  return {
    id: session.id,
    toolName: session.toolName,
    projection: session.projection,
    resume: (resume) => session.resume(resume),
    *dispose() {
      yield* resources.dispose(session.id);
    },
  };
}

function* installResourceHost(resources: AgentCoreToolInvocationResources): Operation<void> {
  const factory: ToolInvocationResourceFactory = {
    *create(request: StartToolInvocation) {
      const session = yield* resources.create(request.tool, request.input, {
        sessionId: request.invocationId,
        ...(request.model === undefined ? {} : { model: request.model }),
      });
      return invocationResource(session, resources);
    },
    *open(invocationId) {
      const session = yield* resources.get(invocationId);
      return session ? invocationResource(session, resources) : null;
    },
  };
  yield* ToolInvocationHostPort.installDriver(createToolInvocationHost(factory));
  yield* ToolInvocationEventSourcePort.installDriver({
    *open(invocationId) {
      const resource = yield* factory.open(invocationId);
      return resource?.projection ?? null;
    },
  });
}

function createTestDriver(tools: AnyToolContract[], provider = samplingProvider): ToolRuntime {
  return createStrategyToolRuntime({
    id: "agentcore",
    strategies: [
      createAgentCoreToolExecutionStrategy({
        id: "agentcore",
        tools,
        samplingProvider: provider,
      }),
    ],
  });
}

describe("AgentCore ToolRuntimeDriver", () => {
  it("rejects duplicate configured tool names deterministically", () => {
    try {
      createTestDriver([remoteTool, remoteTool]);
      throw new Error("expected duplicate tool rejection");
    } catch (error) {
      expect(error).toMatchObject({ code: "DUPLICATE_TOOL_STRATEGY" });
    }
  });

  it("executes AgentCore resources via the canonical runtime surface", async () => {
    await run(function* () {
      yield* installResourceHost(createFakeResources());
      const driver = createTestDriver([remoteTool]);

      const result = yield* driver.execute({
        entry: createToolInventoryEntry(remoteTool),
        call: {
          id: "call-remote",
          name: "remote_echo",
          input: { message: "hello" },
          thoughtSignature: null,
        },
      });

      expect(result).toMatchObject({ kind: "completed", result: { ok: true } });
      expect(result.ref).toMatchObject({
        runtimeId: "agentcore",
        callId: "call-remote",
        toolName: "remote_echo",
      });
    });
  });

  it("refuses mismatched inventory entries and call targets", async () => {
    await run(function* () {
      yield* installResourceHost(createFakeResources());
      const driver = createTestDriver([remoteTool]);

      try {
        yield* driver.execute({
          entry: {
            definition: {
              name: "other",
              description: "Other tool",
              parameters: { type: "object" },
            },
          },
          call: {
            id: "call-mismatch",
            name: "remote_echo",
            input: { message: "hello" },
            thoughtSignature: null,
          },
        });
        throw new Error("expected strategy mismatch");
      } catch (error) {
        expect(error).toMatchObject({ code: "NO_MATCHING_TOOL_STRATEGY" });
      }
    });
  });

  it("rejects invalid params before AgentCore session creation", async () => {
    await run(function* () {
      let createCalls = 0;
      // SAFETY: this boundary fake counts dispatch and always returns the same
      // completed protocol session, independent of TResult.
      const resources = {
        *create(): Operation<ToolSession> {
          createCalls++;
          return createFakeSession();
        },
        *get(): Operation<ToolSession | null> {
          return null;
        },
        *dispose(): Operation<void> {},
      } as unknown as AgentCoreToolInvocationResources;
      yield* installResourceHost(resources);
      const driver = createTestDriver([remoteTool]);

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
    const resources = createAgentCoreToolInvocationResources({
      stores,
      runtimeClient: runtime,
      profiles: [createProfile(["remote_elicit"])],
      createRuntimeSessionId: () => "runtime-elicit",
    });

    await run(function* () {
      yield* installResourceHost(resources);
      const driver = createTestDriver([remoteElicitTool]);
      const entry = createToolInventoryEntry(remoteElicitTool);

      const initial = yield* driver.execute({
        entry,
        call: { id: "call-elicit", name: "remote_elicit", input: {}, thoughtSignature: null },
      });
      expect(initial).toMatchObject({ kind: "awaiting_elicit" });
      if (initial.kind !== "awaiting_elicit") {
        return;
      }

      const resumed = yield* driver.resume({
        ref: initial.ref,
        input: {
          type: "elicit_response",
          elicitId: initial.request.elicitId,
          completion: { action: "accept", content: { confirmed: true } },
        },
      });

      expect(resumed).toMatchObject({ kind: "completed", result: { confirmed: true } });
    });
  });

  it("passes selected chat model into AgentCore start context and handle metadata", async () => {
    const stores = createStores();
    const runtime = new FakeAgentCoreRemoteToolRuntimeClient();
    const resources = createAgentCoreToolInvocationResources({
      stores,
      runtimeClient: runtime,
      profiles: [createProfile(["remote_echo"])],
      createRuntimeSessionId: () => "runtime-model-context",
    });

    await run(function* () {
      yield* installResourceHost(resources);
      const driver = createTestDriver([remoteTool]);
      const entry = createToolInventoryEntry(remoteTool);
      yield* driver.execute({
        entry,
        call: {
          id: "call-model-context",
          name: "remote_echo",
          input: { message: "hello" },
          thoughtSignature: null,
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
    const resources = createAgentCoreToolInvocationResources({
      stores,
      runtimeClient: runtime,
      profiles: [createProfile(["remote_sample"])],
      createRuntimeSessionId: () => "runtime-sample",
    });

    await run(function* () {
      yield* installResourceHost(resources);
      const driver = createTestDriver([remoteSampleTool]);
      const entry = createToolInventoryEntry(remoteSampleTool, { profile: "test" });

      const result = yield* driver.execute({
        entry,
        call: { id: "call-sample", name: "remote_sample", input: {}, thoughtSignature: null },
      });

      expect(result).toMatchObject({
        kind: "completed",
        result: { text: "hello from sample provider" },
      });
    });
  });

  it("creates AgentCore inventory entries and normalized executions", async () => {
    const entry = createToolInventoryEntry(remoteTool, { profile: "test" });
    expect(entry.definition).toMatchObject({ name: "remote_echo", description: "Remote echo" });
    expect(entry.definition.parameters).toMatchObject({ required: ["message"] });
    expect((entry.definition.parameters as { safeParse?: unknown }).safeParse).toBeUndefined();
    expect("implementation" in entry.definition).toBe(false);
    expect(entry.capabilities).toMatchObject({
      elicits: false,
      samples: false,
    });
    expect(() => createToolInventory([entry, entry])).toThrow("Duplicate tool name");

    await run(function* () {
      yield* installResourceHost(createFakeResources());
      const driver = createTestDriver([remoteTool]);
      const result = yield* driver.execute({
        entry,
        call: {
          id: "call-remote",
          name: "remote_echo",
          input: { message: "hello" },
          thoughtSignature: null,
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
          call: { id: "call-bad", name: "unsupported", input: {}, thoughtSignature: null },
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
          input: {
            type: "elicit_response",
            elicitId: "elicit",
            completion: { action: "accept", content: null },
          },
        });
        throw new Error("expected wrong tool");
      } catch (error) {
        expect(error).toMatchObject({ code: "EXECUTION_NOT_FOUND" });
      }
    });
  });

  it("exports an executable AgentCore strategy object", async () => {
    await run(function* () {
      yield* installResourceHost(createFakeResources());
      const strategy = createAgentCoreToolExecutionStrategy({
        samplingProvider,
        tools: [remoteTool],
      });
      const entry = createToolInventoryEntry(remoteTool);
      expect(
        strategy.canExecute(
          entry,
          { id: "call-remote", name: "remote_echo", input: {}, thoughtSignature: null },
          { runtimeId: "agentcore" },
        ),
      ).toBe(true);
      const result = yield* strategy.execute(
        entry,
        {
          id: "call-remote",
          name: "remote_echo",
          input: { message: "hello" },
          thoughtSignature: null,
        },
        { runtimeId: "agentcore" },
      );
      expect(result).toMatchObject({ kind: "completed", result: { ok: true } });
    });
  });

  it("installer makes the runtime resolvable through the tool runtime port", async () => {
    await run(function* () {
      yield* installAgentCoreToolRuntime({
        tools: [remoteTool],
        samplingProvider,
        runtime: {
          runtimeClient: new FakeAgentCoreRemoteToolRuntimeClient(),
          profiles: [createProfile(["remote_echo"])],
          createRuntimeSessionId: () => "runtime-installed",
        },
      });
      const result = yield* ToolRuntimeApi.operations.execute({
        entry: createToolInventoryEntry(remoteTool),
        call: {
          id: "call-installed-agentcore",
          name: "remote_echo",
          input: { message: "hello" },
          thoughtSignature: null,
        },
      });
      expect(result).toMatchObject({ kind: "completed", result: { ok: true } });
    });
  });
});
