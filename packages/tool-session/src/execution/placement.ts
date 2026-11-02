import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { ToolExecutionAdapter, PreparedToolInvocation } from "./tool-placement.ts";
import { isIteratorTool } from "@sweatpants/agent-sdk/internal/tool-execution";
import type { PreparedToolExecution, ToolRegistryAdapter } from "./tool-placement.ts";
import { canonicalDigest } from "@sweatpants/foundation";
import type { AnyToolContract, ToolContract, ToolDefinition } from "@sweatpants/agent-sdk";
import type { DurableTool, ProgramDriver, ProgramRoute } from "@sweatpants/durable-execution";
import type { Operation } from "effection";
type NativeYield = Operation<unknown> extends Iterable<infer Y> ? Y : never;
import type { ToolInvocationResourceFactory } from "../invocation.ts";

/** One public model-tool name routed to a crank-native child program. */
export interface ToolExecutionBinding {
  readonly publicName: string;
  readonly tool: DurableTool<any, any> & ToolContract;
  readonly route: ProgramRoute;
  /**
   * Explicit activation-safety capability of the driver behind `route`.
   *
   * Declare `"fenced"` when program evaluation can execute in a remote or
   * process-independent substrate that may outlive or race this host's
   * activation. Fenced bindings cause the host to claim, renew, and release
   * an activation lease around each workflow host run. In-process drivers
   * (generator, worker threads owned by this host) omit it.
   */
  readonly activation?: "fenced";
}

export type ChatTool = AnyToolContract | ToolExecutionBinding["tool"];
export type ChatDurableTool = ToolExecutionBinding["tool"];

export function isChatDurableTool(tool: ChatTool): tool is ChatDurableTool {
  return (
    "execution" in tool &&
    tool.execution === "crank_native" &&
    "manifest" in tool &&
    "program" in tool
  );
}

/** Compatibility assembly for retained sessions and authority-backed programs. */
export interface RetainedPreparedToolExecution<Y = NativeYield> extends PreparedToolExecution<Y> {
  /** Stable identity stored in ordinary tool execution references. */
  readonly runtimeId?: string;
  readonly createResources?: () => Operation<ToolInvocationResourceFactory>;
  readonly bindings?: readonly ToolExecutionBinding[];
  readonly drivers?: readonly (readonly [string, ProgramDriver])[];
  /** Application-scoped drivers with resource lifetimes beyond one activation. */
  readonly driverFactories?: readonly (readonly [string, () => Operation<ProgramDriver>])[];
}

/** Advanced adapter contract. Preparation validates without starting resources. */
export interface RetainedToolExecutionAdapter<
  T extends ChatTool | ToolDefinition = ChatTool,
  Y = NativeYield,
> extends ToolRegistryAdapter<T, Y> {
  prepare(tools: readonly T[], routeId: string): RetainedPreparedToolExecution<Y>;
}

export interface ToolRoutes<
  T extends ChatTool | ToolDefinition = ChatTool,
  Y = NativeYield,
  Adapter extends RetainedToolExecutionAdapter<T, Y> = RetainedToolExecutionAdapter<T, Y>,
> {
  readonly default?: Adapter;
  readonly routes: readonly {
    readonly name?: string;
    readonly tools: readonly T[];
    readonly runtime: Adapter;
  }[];
}

/** Explicit overrides with an optional default; overlaps and unknown tools fail. */
export function routeTools<T extends ChatTool | ToolDefinition, Y = NativeYield>(
  options: ToolRoutes<T, Y, RetainedToolExecutionAdapter<T, Y> & ToolExecutionAdapter<Y>>,
): RetainedToolExecutionAdapter<T, Y> & ToolExecutionAdapter<Y>;
export function routeTools<T extends ChatTool | ToolDefinition, Y = NativeYield>(
  options: ToolRoutes<T, Y>,
): RetainedToolExecutionAdapter<T, Y>;
export function routeTools<T extends ChatTool | ToolDefinition, Y = NativeYield>(
  options: ToolRoutes<T, Y>,
) {
  function supportsSingle(
    adapter: RetainedToolExecutionAdapter<T, Y>,
  ): adapter is RetainedToolExecutionAdapter<T, Y> & ToolExecutionAdapter<Y> {
    return "singleTool" in adapter && adapter.singleTool === true;
  }
  function prepare<P extends StandardSchemaV1, Result>(
    tool: ToolDefinition<P, Result>,
    routeId: string,
  ): PreparedToolInvocation<P, Result, Y>;
  function prepare(tools: readonly T[], routeId: string): RetainedPreparedToolExecution<Y>;
  function prepare<P extends StandardSchemaV1, Result>(
    tools: ToolDefinition<P, Result> | readonly T[],
    routeId: string,
  ): PreparedToolInvocation<P, Result, Y> | RetainedPreparedToolExecution<Y> {
    const owners = new Map<
      unknown,
      { name: string; runtime: RetainedToolExecutionAdapter<T, Y> }
    >();
    const routeNames = new Set<string>();
    const routes = options.routes.map((route) => {
      const name = route.name ?? canonicalDigest(route.tools.map((tool) => tool.name).sort());
      if (!name || routeNames.has(name)) {
        throw new Error(`Duplicate or empty execution route name: ${name}`);
      }
      routeNames.add(name);
      for (const tool of route.tools) {
        if (owners.has(tool)) {
          throw new Error(`Multiple execution routes for tool: ${tool.name}`);
        }
        owners.set(tool, { name, runtime: route.runtime });
      }
      return { ...route, name };
    });
    if ("name" in tools) {
      const route = owners.get(tools);
      const runtime = route?.runtime ?? options.default;
      if (!runtime) {
        throw new Error(`No execution route for: ${tools.name}`);
      }
      if (!supportsSingle(runtime)) {
        throw new Error("Selected adapter supports registry preparation only");
      }
      return runtime.prepare(tools, route ? `${routeId}:${route.name}` : routeId);
    }
    const remaining = new Set(tools);
    const known = new Set(tools);
    const prepared: { tools: readonly T[]; execution: RetainedPreparedToolExecution<Y> }[] = [];
    routes.forEach((route) => {
      const name = route.name;
      for (const tool of route.tools) {
        if (!known.has(tool)) {
          throw new Error(`Route references unregistered tool: ${tool.name}`);
        }
        remaining.delete(tool);
      }
      if (route.tools.length) {
        prepared.push({
          tools: route.tools,
          execution: route.runtime.prepare(route.tools, `${routeId}:${name}`),
        });
      }
    });
    if (remaining.size) {
      if (!options.default) {
        throw new Error(`No execution route for: ${[...remaining].map((t) => t.name).join(", ")}`);
      }
      const defaults = [...remaining];
      prepared.push({
        tools: defaults,
        execution: options.default.prepare(defaults, routeId),
      });
    }
    return combineExecutions(prepared);
  }
  return {
    singleTool:
      (!options.default || supportsSingle(options.default)) &&
      options.routes.every((route) => supportsSingle(route.runtime)),
    prepare,
  };
}

function combineExecutions<T extends ChatTool | ToolDefinition, Y>(
  entries: readonly { tools: readonly T[]; execution: RetainedPreparedToolExecution<Y> }[],
): RetainedPreparedToolExecution<Y> {
  for (const entry of entries) {
    for (const name of entry.execution.guests?.keys() ?? []) {
      if (!entry.tools.some((tool) => tool.name === name)) {
        throw new Error(`Adapter returned a Guest for a tool outside its route: ${name}`);
      }
    }
  }
  return {
    guests: new Map(entries.flatMap((e) => [...(e.execution.guests ?? [])])),
    runtimeId: entries.length === 1 ? entries[0].execution.runtimeId : "tools",
    setup: function* () {
      for (const entry of entries) {
        if (entry.execution.setup) {
          yield* entry.execution.setup();
        }
      }
    },
    bindings: entries.flatMap((e) => e.execution.bindings ?? []),
    drivers: entries.flatMap((e) => e.execution.drivers ?? []),
    driverFactories: entries.flatMap((e) => e.execution.driverFactories ?? []),
    *createResources() {
      const factories: { names: Set<string>; factory: ToolInvocationResourceFactory }[] = [];
      for (const entry of entries) {
        if (entry.execution.createResources) {
          factories.push({
            names: new Set(
              entry.tools
                .filter((t) => !isIteratorTool(t) && !isChatDurableTool(t))
                .map((t) => t.name),
            ),
            factory: yield* entry.execution.createResources(),
          });
        }
      }
      return {
        *create(request) {
          const owner = factories.find((f) => f.names.has(request.tool.name));
          if (!owner) {
            throw new Error(`No invocation runtime for tool: ${request.tool.name}`);
          }
          return yield* owner.factory.create(request);
        },
        *open(id) {
          let found = null;
          for (const entry of factories) {
            const resource = yield* entry.factory.open(id);
            if (resource) {
              if (found) {
                throw new Error(`Invocation exists in multiple runtimes: ${id}`);
              }
              if (!entry.names.has(resource.toolName)) {
                throw new Error(
                  `Invocation belongs to a different tool route: ${resource.toolName}`,
                );
              }
              found = resource;
            }
          }
          return found;
        },
      };
    },
  };
}
