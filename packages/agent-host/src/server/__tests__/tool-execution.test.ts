// @vitest-environment node
import { describe, expect, it } from "vitest";
import { run, scoped } from "effection";
import { z } from "zod";
import { createTool, defineEffect } from "@sweatpants/agent-sdk";
import { createDurableTool } from "@sweatpants/agent-sdk/legacy";
import { createDurableEffectRegistration } from "@sweatpants/durable-effects";
import { ToolInventoryApi, ToolRuntimeApi } from "@sweatpants/tool-runtime";
import { ProgramDriverNativeToolsContext } from "@sweatpants/durable-chat-runtime/durable-handler";
import type { ToolInvocationResource } from "@sweatpants/tool-session";
import { createChatApp, inProcess, installChatTools } from "../index.ts";
import { local } from "@sweatpants/tool-runtime-local";
import { routeTools, type ToolExecutionAdapter } from "@sweatpants/tool-session/execution";

import { agentCore } from "@sweatpants/tool-runtime-agentcore";

const echo = createTool("echo")
  .description("Echo")
  .parameters(z.object({ text: z.string() }))
  .execute(function* (input) {
    return input.text;
  });
const other = createTool("other")
  .description("Other")
  .parameters(z.object({}))
  .execute(function* () {
    return "other";
  });
const effect = defineEffect({
  name: "lookup",
  version: "1",
  input: z.object({}),
  output: z.string(),
  retrySafety: { mode: "repeatable" },
});
const durable = createDurableTool("durable")
  .description("Durable")
  .identity({ version: "1", digest: "a".repeat(64) })
  .parameters(z.object({}))
  .output(z.string())
  .effects({ lookup: effect })
  .execute(function* (_, ctx) {
    return yield* ctx.effect(effect, {});
  });
const identity = {
  name: "authored-api",
  secret: "authored-api-test-secret-at-least-32-bytes",
  storage: { kind: "memory" as const },
};

// Mechanical resource fixture: routing tests assert which factory receives work.
function resource(toolName: string): ToolInvocationResource {
  return {
    id: toolName,
    toolName,
    elicitBindings: {},
    projection: {} as ToolInvocationResource["projection"],
    *resume() {},
    *dispose() {},
  };
}
function placement(
  label: string,
  calls: string[],
  saved = new Map<string, ToolInvocationResource>(),
): ToolExecutionAdapter {
  return {
    prepare() {
      return {
        *createResources() {
          return {
            *create(request) {
              calls.push(label);
              const value = resource(request.tool.name);
              saved.set(request.invocationId, value);
              return value;
            },
            *open(id) {
              return saved.get(id) ?? null;
            },
          };
        },
      };
    },
  };
}

describe("authored application tools", () => {
  it("retains host-program placement and scoped setup for advanced authored capabilities", () => {
    const setup = function* () {};
    const prepared = inProcess({ setup }).prepare([durable], "tools");
    expect(prepared.setup).toBe(setup);
    expect(prepared.bindings?.[0].route).toEqual({ driverKind: "program" });
    expect(() => inProcess().prepare([echo], "tools")).toThrow("durable programs only");
  });

  it("rejects duplicate tool names and missing placement before starting the app", () => {
    expect(() =>
      createChatApp({
        ...identity,
        tools: [echo, echo],
        execution: local({ worker: "unused.js" }),
      }),
    ).toThrow("Duplicate tool name: echo");
    expect(() => createChatApp({ ...identity, tools: [echo] })).toThrow("execution adapter");
    expect(() => createChatApp({ ...identity, tools: [echo], execution: local({}) })).toThrow(
      "worker entry",
    );
  });

  it("requires matching effect implementations before exposing a durable tool", () => {
    const execution = local({ durableWorker: "unused.js" });
    expect(() => createChatApp({ ...identity, tools: [durable], execution })).toThrow(
      "requires effect handler: lookup@1",
    );
    const wrong = defineEffect({
      name: "lookup",
      version: "1",
      input: z.object({}),
      output: z.number(),
      retrySafety: { mode: "repeatable" },
    });
    const effects = [
      createDurableEffectRegistration(wrong, { mode: "repeatable" }, function* () {
        return { status: "ok", value: 1 };
      }),
    ];
    expect(() => createChatApp({ ...identity, tools: [durable], execution, effects })).toThrow(
      "contract mismatch",
    );
  });

  it("derives one inventory while preserving ordinary and durable execution kinds", async () => {
    await run(function* () {
      yield* installChatTools({
        tools: [echo, durable],
        execution: local({ worker: "unused.js", durableWorker: "unused-durable.js" }),
        effects: [
          createDurableEffectRegistration(effect, { mode: "repeatable" }, function* () {
            return { status: "ok", value: "found" };
          }),
        ],
      });
      expect((yield* ToolInventoryApi.list()).map((entry) => entry.definition.name)).toEqual([
        "echo",
        "durable",
      ]);
      const runtimeId = yield* ToolRuntimeApi.operations.runtimeId();
      expect(runtimeId).toBe("local");
      const native = yield* ProgramDriverNativeToolsContext.get();
      expect([...native!.bindings.keys()]).toEqual(["durable"]);
      expect(native!.bindings.get("durable")!.tool).toBe(durable);
      expect(native!.bindings.get("durable")!.route).toEqual({ driverKind: "worker" });
      expect(native!.drivers.map(([name]) => name)).toEqual(["worker"]);
      expect(echo.execution).not.toBe("crank_native");
    });
  });

  it("preserves the remote runtime identity through default routing without eager startup", async () => {
    const remote = agentCore({
      runtime: function* () {
        throw new Error("must remain lazy without ordinary tools");
      },
    });
    expect(routeTools({ default: remote, routes: [] }).prepare([echo], "tools").runtimeId).toBe(
      "agentcore",
    );
    await run(function* () {
      yield* installChatTools({ tools: [], execution: remote });
      const runtimeId = yield* ToolRuntimeApi.operations.runtimeId();
      expect(runtimeId).toBe("agentcore");
    });
  });

  it("owns retained durable workers in the application scope across activation scopes", async () => {
    await run(function* () {
      yield* installChatTools({
        tools: [durable],
        effects: [
          createDurableEffectRegistration(effect, { mode: "repeatable" }, function* () {
            return { status: "ok", value: "found" };
          }),
        ],
        execution: local({
          durableWorker: new URL(
            "../../../../tool-runtime-local/src/__tests__/fixtures/retained-worker.mjs",
            import.meta.url,
          ),
          idleTimeoutMs: 10_000,
        }),
      });
      const native = yield* ProgramDriverNativeToolsContext.get();
      const driver = native!.drivers.find(([name]) => name === "worker")![1];
      const request = {
        sessionId: "app-retention",
        taskId: "root",
        input: null,
        program: {
          id: durable.manifest.programId,
          version: durable.manifest.version,
          digest: durable.manifest.digest,
        },
        executionEpoch: 1,
        route: { driverKind: "worker" },
      };
      const first = yield* scoped(function* () {
        const attachment = yield* driver.attach(request);
        yield* driver.shutdown(attachment, "parked");
        return attachment;
      });
      const next = yield* driver.attach({ ...request, executionEpoch: 2 });
      expect(next.attachmentId.split(":")[0]).toBe(first.attachmentId.split(":")[0]);
      expect(next.attachmentId).not.toBe(first.attachmentId);
      yield* driver.shutdown(next, "completed");
    });
    expect(() => local({ idleTimeoutMs: -1 })).toThrow("idleTimeoutMs");
  });

  it("rejects overlapping, unknown, and uncovered explicit routes", () => {
    const runtime = placement("test", []);
    expect(() =>
      routeTools({
        routes: [
          { tools: [echo], runtime },
          { tools: [echo], runtime },
        ],
      }).prepare([echo], "test"),
    ).toThrow("Multiple execution routes");
    expect(() =>
      routeTools({ routes: [{ tools: [other], runtime }] }).prepare([echo], "test"),
    ).toThrow("unregistered tool");
    expect(() => routeTools({ routes: [] }).prepare([echo], "test")).toThrow("No execution route");
  });

  it("routes new calls and reopens persisted calls without relying on a host-local routing cache", async () => {
    const calls: string[] = [];
    const saved = new Map<string, ToolInvocationResource>();
    const execution = routeTools({
      default: placement("local", calls),
      routes: [{ tools: [other], runtime: placement("remote", calls, saved) }],
    });
    await run(function* () {
      const factory = yield* execution.prepare([echo, other], "tools").createResources!();
      yield* factory.create({ invocationId: "one", tool: echo, input: { text: "hi" } });
      yield* factory.create({ invocationId: "two", tool: other, input: {} });
      expect(calls).toEqual(["local", "remote"]);
    });
    await run(function* () {
      const factory = yield* execution.prepare([echo, other], "tools").createResources!();
      expect((yield* factory.open("two"))?.toolName).toBe("other");
      expect(yield* factory.open("missing")).toBeNull();
    });
  });

  it("rejects recovered resources belonging to another route", async () => {
    const saved = new Map([["old", resource("echo")]]);
    const execution = routeTools({
      default: placement("local", []),
      routes: [{ tools: [other], runtime: placement("remote", [], saved) }],
    });
    await expect(
      run(function* () {
        const factory = yield* execution.prepare([echo, other], "tools").createResources!();
        yield* factory.open("old");
      }),
    ).rejects.toThrow("different tool route");
  });
});
