import { canonicalSnapshot } from "@sweatpants/foundation";
import type { AnyToolContract, ToolContract } from "@sweatpants/agent-sdk";
import type { DurableTool, ProgramDriver, ProgramRoute } from "@sweatpants/durable-execution";
import type { Operation } from "effection";
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
  return tool.execution === "crank_native" && "manifest" in tool && "program" in tool;
}

/** Prepared placement; the adapter never owns journal policy or tool visibility. */
export interface PreparedToolExecution {
  /** Stable identity stored in ordinary tool execution references. */
  readonly runtimeId?: string;
  readonly setup?: () => Operation<void>;
  readonly createResources?: () => Operation<ToolInvocationResourceFactory>;
  readonly bindings?: readonly ToolExecutionBinding[];
  readonly drivers?: readonly (readonly [string, ProgramDriver])[];
  /** Application-scoped drivers with resource lifetimes beyond one activation. */
  readonly driverFactories?: readonly (readonly [string, () => Operation<ProgramDriver>])[];
}

/** Advanced adapter contract. Preparation validates without starting resources. */
export interface ToolExecutionAdapter {
  prepare(tools: readonly ChatTool[], routeId: string): PreparedToolExecution;
}

export interface ToolRoutes {
  readonly default?: ToolExecutionAdapter;
  readonly routes: readonly {
    readonly name?: string;
    readonly tools: readonly ChatTool[];
    readonly runtime: ToolExecutionAdapter;
  }[];
}

/** Explicit overrides with an optional default; overlaps and unknown tools fail. */
export function routeTools(options: ToolRoutes): ToolExecutionAdapter {
  return {
    prepare(tools, routeId) {
      const remaining = new Set(tools);
      const known = new Set(tools);
      const prepared: { tools: readonly ChatTool[]; execution: PreparedToolExecution }[] = [];
      const routeNames = new Set<string>();
      options.routes.forEach((route) => {
        const name =
          route.name ?? canonicalSnapshot(route.tools.map((tool) => tool.name).sort()).sha;
        for (const tool of route.tools) {
          if (!known.has(tool)) throw new Error(`Route references unregistered tool: ${tool.name}`);
          if (!remaining.delete(tool))
            throw new Error(`Multiple execution routes for tool: ${tool.name}`);
        }
        if (!name || routeNames.has(name))
          throw new Error(`Duplicate or empty execution route name: ${name}`);
        routeNames.add(name);
        if (route.tools.length)
          prepared.push({
            tools: route.tools,
            execution: route.runtime.prepare(route.tools, `${routeId}:${name}`),
          });
      });
      if (remaining.size) {
        if (!options.default)
          throw new Error(
            `No execution route for: ${[...remaining].map((t) => t.name).join(", ")}`,
          );
        const defaults = [...remaining];
        prepared.push({
          tools: defaults,
          execution: options.default.prepare(defaults, routeId),
        });
      }
      return combineExecutions(prepared);
    },
  };
}

function combineExecutions(
  entries: readonly { tools: readonly ChatTool[]; execution: PreparedToolExecution }[],
): PreparedToolExecution {
  return {
    runtimeId: entries.length === 1 ? entries[0].execution.runtimeId : "tools",
    setup: function* () {
      for (const entry of entries) if (entry.execution.setup) yield* entry.execution.setup();
    },
    bindings: entries.flatMap((e) => e.execution.bindings ?? []),
    drivers: entries.flatMap((e) => e.execution.drivers ?? []),
    driverFactories: entries.flatMap((e) => e.execution.driverFactories ?? []),
    *createResources() {
      const factories: { names: Set<string>; factory: ToolInvocationResourceFactory }[] = [];
      for (const entry of entries) {
        if (entry.execution.createResources)
          factories.push({
            names: new Set(entry.tools.filter((t) => !isChatDurableTool(t)).map((t) => t.name)),
            factory: yield* entry.execution.createResources(),
          });
      }
      return {
        *create(request) {
          const owner = factories.find((f) => f.names.has(request.tool.name));
          if (!owner) throw new Error(`No invocation runtime for tool: ${request.tool.name}`);
          return yield* owner.factory.create(request);
        },
        *open(id) {
          let found = null;
          for (const entry of factories) {
            const resource = yield* entry.factory.open(id);
            if (resource) {
              if (found) throw new Error(`Invocation exists in multiple runtimes: ${id}`);
              if (!entry.names.has(resource.toolName))
                throw new Error(
                  `Invocation belongs to a different tool route: ${resource.toolName}`,
                );
              found = resource;
            }
          }
          return found;
        },
      };
    },
  };
}
