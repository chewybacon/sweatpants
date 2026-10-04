import {
  createAgentCoreToolInvocationResourceFactory,
  type AgentCoreToolInvocationRuntimeOptions,
} from "./invocation-runtime.ts";
import { reconcileAgentCoreDurableReadiness } from "./durable/durable-placement.ts";
import type { AgentCoreRuntimeRelease } from "./placement/placement-types.ts";
import { exactProgramKey } from "@sweatpants/durable-execution";
import type { ProgramDriver, ProgramRoute } from "@sweatpants/durable-execution";
import type { Operation } from "effection";
import { isChatDurableTool, type ToolExecutionAdapter } from "@sweatpants/tool-session/execution";

export interface AgentCoreExecutionOptions {
  readonly runtime:
    | AgentCoreToolInvocationRuntimeOptions
    | (() => Operation<AgentCoreToolInvocationRuntimeOptions>);
  readonly durable?: {
    readonly journalId: string;
    readonly release: AgentCoreRuntimeRelease;
    readonly driver: ProgramDriver;
    readonly availablePrograms: ReadonlySet<string>;
    readonly availableEffects: ReadonlySet<string>;
    readonly availableSchemaDigests: ReadonlySet<string>;
    /** Additional placement fields for explicitly configured development collections. */
    readonly route?: (toolName: string) => ProgramRoute;
  };
}

/** Remote placement validates the exact durable release before exposing a tool. */
export function agentCore(options: AgentCoreExecutionOptions): ToolExecutionAdapter {
  return {
    prepare(tools, routeId) {
      const driverKind = routeId === "tools" ? "agentcore" : routeId;
      const durable = tools.filter(isChatDurableTool);
      const ordinary = tools.filter((tool) => !isChatDurableTool(tool));
      const deployment = options.durable;
      if (durable.length && !deployment)
        throw new Error("AgentCore durable tools require a pinned release and driver");
      for (const tool of durable) {
        const identity = {
          id: tool.manifest.programId,
          version: tool.manifest.version,
          digest: tool.manifest.digest,
        };
        const key = exactProgramKey(identity);
        const readiness = reconcileAgentCoreDurableReadiness({
          release: deployment!.release,
          program: identity,
          registry: new Map(deployment!.availablePrograms.has(key) ? [[key, tool.manifest]] : []),
          driverAvailable: true,
          effectKeys: deployment!.availableEffects,
          schemaDigests: deployment!.availableSchemaDigests,
          manifest: tool.manifest,
        });
        if (!readiness.ready)
          throw new Error(
            `AgentCore tool ${tool.name} is not ready: ${JSON.stringify(readiness.missing)}`,
          );
      }
      return {
        runtimeId: "agentcore",
        createResources: ordinary.length
          ? function* () {
              const runtime =
                typeof options.runtime === "function" ? yield* options.runtime() : options.runtime;
              const advertised = new Set(runtime.profiles.flatMap((profile) => profile.toolNames));
              for (const tool of ordinary)
                if (!advertised.has(tool.name))
                  throw new Error(`AgentCore profile does not expose tool: ${tool.name}`);
              return yield* createAgentCoreToolInvocationResourceFactory(runtime);
            }
          : undefined,
        bindings: durable.map((tool) => {
          const extra = deployment!.route?.(tool.name);
          if (extra !== undefined && (!extra || typeof extra !== "object" || Array.isArray(extra)))
            throw new Error("AgentCore route must be an object");
          return {
            publicName: tool.name,
            tool,
            activation: "fenced" as const,
            route: {
              ...extra,
              driverKind,
              journalId: deployment!.journalId,
              release: deployment!.release,
            } as unknown as ProgramRoute,
          };
        }),
        drivers: durable.length ? [[driverKind, deployment!.driver] as const] : [],
      };
    },
  };
}
