import { createDurableToolRegistry } from "@sweatpants/durable-execution";
import { isChatDurableTool, type ToolExecutionAdapter } from "@sweatpants/tool-session/execution";
import {
  createLocalToolInvocationResourceFactory,
  type LocalToolInvocationRuntimeOptions,
} from "./invocation-runtime.ts";
import {
  createLocalWorkerDurableProgramDriver,
  useLocalWorkerDurableProgramDriver,
} from "./local-worker-durable-driver.ts";

export interface LocalExecutionOptions {
  /** Retain idle durable workers after park; defaults to immediate teardown. */
  readonly idleTimeoutMs?: number;
  readonly profile?: string;
  readonly worker?: string | URL;
  readonly durableWorker?: string | URL;
  readonly isDev?: boolean;
  readonly execArgv?: readonly string[];
  readonly defaultTimeout?: number;
}

/** Local worker placement. Worker entries import the same authored tool list. */
export function local(options: LocalExecutionOptions): ToolExecutionAdapter {
  const idleTimeoutMs = options.idleTimeoutMs ?? 0;
  if (!Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs < 0 || idleTimeoutMs > 2_147_483_647)
    throw new Error("idleTimeoutMs must be an integer between 0 and 2147483647");
  return {
    prepare(tools, routeId) {
      const driverKind = routeId === "tools" ? "worker" : routeId;
      const durable = tools.filter(isChatDurableTool);
      const ordinary = tools.filter((tool) => !isChatDurableTool(tool));
      if (ordinary.length && !options.worker) {
        throw new Error("local execution requires a worker entry for ordinary tools");
      }
      if (durable.length && !options.durableWorker) {
        throw new Error("local execution requires a durableWorker entry for durable tools");
      }
      const worker: LocalToolInvocationRuntimeOptions["worker"] = options.worker
        ? { workerUrl: options.worker, isDev: options.isDev, execArgv: options.execArgv }
        : undefined;
      return {
        runtimeId: "local",
        createResources: ordinary.length
          ? () =>
              createLocalToolInvocationResourceFactory({
                worker,
                defaultTimeout: options.defaultTimeout,
              })
          : undefined,
        bindings: durable.map((tool) => ({
          publicName: tool.name,
          tool,
          route: { driverKind, ...(options.profile ? { profile: options.profile } : {}) },
        })),
        driverFactories:
          durable.length && idleTimeoutMs > 0
            ? [
                [
                  driverKind,
                  () =>
                    useLocalWorkerDurableProgramDriver({
                      workerUrl: options.durableWorker!,
                      registry: createDurableToolRegistry(durable),
                      name: routeId,
                      idleTimeoutMs,
                    }),
                ],
              ]
            : [],
        drivers:
          durable.length && idleTimeoutMs === 0
            ? [
                [
                  driverKind,
                  createLocalWorkerDurableProgramDriver({
                    workerUrl: options.durableWorker!,
                    registry: createDurableToolRegistry(durable),
                    name: routeId,
                  }),
                ],
              ]
            : [],
      };
    },
  };
}
