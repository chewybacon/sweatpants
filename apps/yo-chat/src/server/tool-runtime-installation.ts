import type { AnyToolContract, RuntimeTool } from "@sweatpants/core";
import type { Operation } from "effection";
import {
  PluginSessionManagerContext,
  PluginSessionRegistryContext,
  ToolInventoryContext,
  ToolRuntimeContext,
  createStrategyToolRuntime,
  createToolInventory,
  createToolInventoryEntry,
  projectAvailableToolContracts,
} from "@sweatpants/framework/chat";
import {
  ProgramDriverForeignEffectsContext,
  ProgramDriverNativeToolsContext,
  programDriverSchemaRegistry,
  type PluginSessionManager,
} from "@sweatpants/framework/server";
import { createDurableToolRegistry } from "@sweatpants/session-contract";
import type {
  AgentCoreRuntimeRelease,
  ProgramDriver,
  ProgramRoute,
} from "@sweatpants/session-contract";
import type {
  ToolSessionRegistry,
  ToolSessionSamplingProvider,
} from "@sweatpants/framework/chat/mcp-tools";
import {
  ToolSessionSamplingProviderContext,
  createLocalWorkerDurableProgramDriver,
  createToolSessionForeignEffectRegistrations,
  installLocalToolRuntime,
} from "@sweatpants/tool-runtime-local";
import {
  createAgentCoreToolExecutionStrategy,
  exactProgramKey,
  reconcileAgentCoreDurableReadiness,
} from "@sweatpants/tool-runtime-agentcore";

import { pickCard } from "../tools/pick-card/durable";
import { createDrawPickCardsRegistration } from "../tools/pick-card/durable-effects";
import { yoChatDurableProgramWorkerUrl } from "./tool-worker-config";

/** Explicit dependencies for installing one complete yo-chat tool runtime. */
export interface YoChatToolRuntimeInstallation {
  mode: "local" | "agentcore";
  registry: ToolSessionRegistry;
  pluginManager: PluginSessionManager;
  samplingProvider: ToolSessionSamplingProvider;
  tools: AnyToolContract[];
  /** Explicit immutable durable release readiness. Absence safely omits pick_card. */
  agentCoreDurable?: {
    readonly journalId: string;
    readonly release: AgentCoreRuntimeRelease;
    readonly driver: ProgramDriver;
    readonly availablePrograms: ReadonlySet<string>;
    readonly availableEffects: ReadonlySet<string>;
    readonly availableSchemaDigests: ReadonlySet<string>;
  };
}

/**
 * Installs the entire tool inventory into exactly one execution runtime. Local
 * mode uses one worker-backed registry; AgentCore mode uses one remote registry.
 */
export function* installYoChatToolRuntime(options: YoChatToolRuntimeInstallation): Operation<void> {
  const ordinaryContracts = options.tools.filter((tool) => tool.execution !== "crank_native");
  const ordinaryTools = ordinaryContracts.filter(
    (tool): tool is RuntimeTool => typeof tool === "function",
  );
  const schemaRegistry = programDriverSchemaRegistry(pickCard.artifacts.catalog);
  const programIdentity = exactProgramKey({
    id: pickCard.manifest.programId,
    version: pickCard.manifest.version,
    digest: pickCard.manifest.digest,
  });
  const agentReadiness =
    options.mode === "agentcore" && options.agentCoreDurable
      ? reconcileAgentCoreDurableReadiness({
          release: options.agentCoreDurable.release,
          program: {
            id: pickCard.manifest.programId,
            version: pickCard.manifest.version,
            digest: pickCard.manifest.digest,
          },
          registry: new Map(
            options.agentCoreDurable.availablePrograms.has(programIdentity)
              ? [[programIdentity, pickCard.manifest]]
              : [],
          ),
          driverAvailable: true,
          effectKeys: options.agentCoreDurable.availableEffects,
          schemaDigests: options.agentCoreDurable.availableSchemaDigests,
          manifest: pickCard.manifest,
        })
      : { ready: false, missing: ["release"] as const };
  const durableReady = options.mode === "local" || agentReadiness.ready;
  const driverKind = options.mode === "local" ? "worker" : "agentcore";
  const availableContracts = projectAvailableToolContracts(options.tools, {
    ordinaryTools: new Set(ordinaryContracts.map((tool) => tool.name)),
    drivers: new Set(durableReady ? [driverKind] : []),
    programs: new Set(durableReady ? [programIdentity] : []),
    effects: new Set(
      durableReady
        ? Object.values(pickCard.manifest.effects).map(
            (effect) => `${effect.name}@${effect.version}`,
          )
        : [],
    ),
    schemas: schemaRegistry,
    durableDrivers: new Map(durableReady ? [[pickCard.name, driverKind]] : []),
  });
  yield* ToolSessionSamplingProviderContext.set(options.samplingProvider);
  yield* PluginSessionRegistryContext.set(options.registry);
  yield* PluginSessionManagerContext.set(options.pluginManager);
  yield* ToolInventoryContext.set(
    createToolInventory(availableContracts.map((tool) => createToolInventoryEntry(tool))),
  );
  yield* ProgramDriverForeignEffectsContext.set(
    createToolSessionForeignEffectRegistrations({
      registry: options.registry,
      tools: new Map(ordinaryTools.map((tool) => [tool.name, tool])),
    }),
  );

  if (options.mode === "local") {
    const durableRegistry = createDurableToolRegistry([pickCard]);
    yield* ProgramDriverNativeToolsContext.set({
      bindings: new Map([
        [
          pickCard.name,
          {
            publicName: pickCard.name,
            tool: pickCard,
            route: { driverKind: "worker", profile: "yo-chat-durable-tools" },
          },
        ],
      ]),
      drivers: [
        [
          "worker",
          createLocalWorkerDurableProgramDriver({
            workerUrl: yoChatDurableProgramWorkerUrl,
            name: "yo-chat-durable-program",
            registry: durableRegistry,
          }),
        ],
      ],
      effects: [createDrawPickCardsRegistration()],
    });
  }

  if (options.mode === "agentcore") {
    if (agentReadiness.ready && options.agentCoreDurable) {
      yield* ProgramDriverNativeToolsContext.set({
        bindings: new Map([
          [
            pickCard.name,
            {
              publicName: pickCard.name,
              tool: pickCard,
              route: {
                driverKind: "agentcore",
                journalId: options.agentCoreDurable.journalId,
                release: options.agentCoreDurable.release,
              } as unknown as ProgramRoute,
            },
          ],
        ]),
        drivers: [["agentcore", options.agentCoreDurable.driver]],
        effects: [createDrawPickCardsRegistration()],
      });
    }
    yield* ToolRuntimeContext.set(
      createStrategyToolRuntime({
        id: "agentcore",
        strategies: [
          createAgentCoreToolExecutionStrategy({
            tools: ordinaryContracts as RuntimeTool[],
            registry: options.registry,
            samplingProvider: options.samplingProvider,
          }),
        ],
      }),
    );
    return;
  }

  yield* installLocalToolRuntime({
    tools: ordinaryTools,
    registry: options.registry,
    samplingProvider: options.samplingProvider,
  });
}
