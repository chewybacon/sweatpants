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
import { playTttTool } from "../tools/play-ttt/tool";
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
  const durablePrograms = [pickCard, playTttTool] as const;
  const schemaRegistry = programDriverSchemaRegistry(
    durablePrograms.flatMap((tool) => [...tool.artifacts.catalog]),
  );
  const programIdentities = new Map(
    durablePrograms.map((tool) => [
      tool.name,
      exactProgramKey({
        id: tool.manifest.programId,
        version: tool.manifest.version,
        digest: tool.manifest.digest,
      }),
    ]),
  );
  const readyDurableNames = new Set<string>();
  if (options.mode === "local") {
    for (const tool of durablePrograms) readyDurableNames.add(tool.name);
  } else if (options.agentCoreDurable) {
    for (const tool of durablePrograms) {
      const identity = programIdentities.get(tool.name)!;
      const readiness = reconcileAgentCoreDurableReadiness({
        release: options.agentCoreDurable.release,
        program: {
          id: tool.manifest.programId,
          version: tool.manifest.version,
          digest: tool.manifest.digest,
        },
        registry: new Map(
          options.agentCoreDurable.availablePrograms.has(identity)
            ? [[identity, tool.manifest]]
            : [],
        ),
        driverAvailable: true,
        effectKeys: options.agentCoreDurable.availableEffects,
        schemaDigests: options.agentCoreDurable.availableSchemaDigests,
        manifest: tool.manifest,
      });
      if (readiness.ready) readyDurableNames.add(tool.name);
    }
  }
  const driverKind = options.mode === "local" ? "worker" : "agentcore";
  const readyPrograms = durablePrograms.filter((tool) => readyDurableNames.has(tool.name));
  const availableContracts = projectAvailableToolContracts(options.tools, {
    ordinaryTools: new Set(ordinaryContracts.map((tool) => tool.name)),
    drivers: new Set(readyPrograms.length > 0 ? [driverKind] : []),
    programs: new Set(readyPrograms.map((tool) => programIdentities.get(tool.name)!)),
    effects: new Set(
      readyPrograms.flatMap((tool) =>
        Object.values(tool.manifest.effects).map((effect) => `${effect.name}@${effect.version}`),
      ),
    ),
    schemas: schemaRegistry,
    durableDrivers: new Map(readyPrograms.map((tool) => [tool.name, driverKind])),
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
    const durableRegistry = createDurableToolRegistry(durablePrograms);
    yield* ProgramDriverNativeToolsContext.set({
      bindings: new Map(
        durablePrograms.map((tool) => [
          tool.name,
          {
            publicName: tool.name,
            tool,
            route: { driverKind: "worker", profile: "yo-chat-durable-tools" },
          },
        ]),
      ),
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
    if (readyPrograms.length > 0 && options.agentCoreDurable) {
      const agentCoreDurable = options.agentCoreDurable;
      yield* ProgramDriverNativeToolsContext.set({
        bindings: new Map(
          readyPrograms.map((tool) => [
            tool.name,
            {
              publicName: tool.name,
              tool,
              route: {
                driverKind: "agentcore",
                journalId: agentCoreDurable.journalId,
                release: agentCoreDurable.release,
              } as unknown as ProgramRoute,
            },
          ]),
        ),
        drivers: [["agentcore", agentCoreDurable.driver]],
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
