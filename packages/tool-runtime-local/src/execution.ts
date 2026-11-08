import type { StandardSchemaV1 } from "@standard-schema/spec";
import { createGuest, type Turn } from "@sweatpants/foundation/computation";
import type { PreparedToolInvocation } from "@sweatpants/tool-session/placement";
import type { RetainedPreparedToolExecution } from "@sweatpants/tool-session/execution";
import type { Effect } from "effection";
import { isIteratorTool } from "@sweatpants/agent-sdk/internal/tool-execution";
import type { Outcome } from "@sweatpants/foundation/computation";
import type { ToolDefinition, JournalRequest } from "@sweatpants/agent-sdk";
import { assertJson, type Json } from "@sweatpants/foundation";
import type { ChatTool } from "@sweatpants/tool-session/execution";
import { createWorkerGuest } from "./worker-guest.ts";
import { createDurableToolRegistry } from "@sweatpants/durable-execution";
import { isChatDurableTool } from "@sweatpants/tool-session/execution";
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
export function local(options: LocalExecutionOptions) {
  const idleTimeoutMs = options.idleTimeoutMs ?? 0;
  if (!Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs < 0 || idleTimeoutMs > 2_147_483_647) {
    throw new Error("idleTimeoutMs must be an integer between 0 and 2147483647");
  }
  function prepare<P extends StandardSchemaV1, Result>(
    tool: ToolDefinition<P, Result>,
    routeId: string,
  ): PreparedToolInvocation<P, Result, Effect<unknown>>;
  function prepare(
    tools: readonly (ChatTool | ToolDefinition)[],
    routeId: string,
  ): RetainedPreparedToolExecution;
  function prepare<P extends StandardSchemaV1, Result>(
    tools: ToolDefinition<P, Result> | readonly (ChatTool | ToolDefinition)[],
    routeId: string,
  ): PreparedToolInvocation<P, Result, Effect<unknown>> | RetainedPreparedToolExecution {
    if ("name" in tools) {
      const tool = tools;
      const version = tool.version;
      if (!isIteratorTool(tool) || !version || !options.worker) {
        throw new Error(
          "Concrete worker placement requires a versioned iterator tool and worker entry",
        );
      }
      return {
        guest(input, callId) {
          return function* () {
            // The registered worker/release implements this concrete contract. This type
            // does not substitute for runtime schema validation of untrusted bytes.
            const guest = yield* createWorkerGuest<
              Outcome<Result, Json>,
              JournalRequest,
              Json,
              PortableToolWorkerInput
            >({
              workerUrl: options.worker!,
              execArgv: options.execArgv ? [...options.execArgv] : undefined,
              input: {
                tool: { name: tool.name, version, interfaceDigest: tool.interfaceDigest },
                input: assertJson(input),
                callId,
              },
            });
            function completion(
              turn: Turn<Outcome<Result, Json>, JournalRequest>,
            ): Turn<Result, JournalRequest> {
              if (turn.kind === "suspended") {
                return turn;
              }
              if (!turn.value.ok) {
                throw new Error(String(turn.value.error));
              }
              return { kind: "completed", value: turn.value.value };
            }
            return createGuest({
              *start() {
                return completion(yield* guest.start());
              },
              *resume(outcome: Outcome<Json, Json>) {
                return completion(yield* guest.resume(outcome));
              },
              close: () => guest.close(),
            });
          };
        },
      };
    }
    const driverKind = routeId === "tools" ? "worker" : routeId;
    const portable = tools.filter((tool): tool is ToolDefinition => isIteratorTool(tool));
    const retained = tools.filter((tool): tool is ChatTool => !isIteratorTool(tool));
    const durable = retained.filter(isChatDurableTool);
    const ordinary = retained.filter((tool) => !isChatDurableTool(tool));
    if (portable.length && !options.worker) {
      throw new Error("local execution requires a worker entry for portable tools");
    }
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
      guests: new Map(
        portable.map((tool) => {
          const version = tool.version;
          if (!version) {
            throw new Error(`Worker placement requires a version for tool "${tool.name}"`);
          }
          return [
            tool.name,
            (input: Json, callId: string) => () =>
              createWorkerGuest<Outcome<Json, Json>, JournalRequest, Json, PortableToolWorkerInput>(
                {
                  workerUrl: options.worker!,
                  execArgv: options.execArgv ? [...options.execArgv] : undefined,
                  input: {
                    tool: {
                      name: tool.name,
                      version,
                      interfaceDigest: tool.interfaceDigest,
                    },
                    input,
                    callId,
                  },
                },
              ),
          ];
        }),
      ),
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
        route: {
          driverKind,
          // CONDITIONAL-SPREAD: The persisted tool route is Json; omit an absent profile before journal admission.
          ...(options.profile ? { profile: options.profile } : {}),
        },
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
  }
  return { singleTool: true as const, prepare };
}

/** Wire input for the portable branch of local tool placement. */
export interface PortableToolWorkerInput {
  tool: Pick<ToolDefinition, "name" | "interfaceDigest"> & { readonly version: string };
  input: Json;
  callId: string;
}
