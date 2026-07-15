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
  ToolSessionRegistry,
  ToolSessionSamplingProvider,
} from "@sweatpants/framework/chat/mcp-tools";
import {
  ToolSessionSamplingProviderContext,
  createLocalWorkerDurableProgramDriver,
  createToolSessionForeignEffectRegistrations,
  installLocalToolRuntime,
} from "@sweatpants/tool-runtime-local";
import { createAgentCoreToolExecutionStrategy } from "@sweatpants/tool-runtime-agentcore";

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
}

/**
 * Installs the entire tool inventory into exactly one execution runtime. Local
 * mode uses one worker-backed registry; AgentCore mode uses one remote registry.
 */
export function* installYoChatToolRuntime(options: YoChatToolRuntimeInstallation): Operation<void> {
  const ordinaryContracts = options.tools.filter(
    (tool) => tool.execution !== "crank_native",
  );
  const ordinaryTools = ordinaryContracts.filter(
    (tool): tool is RuntimeTool => typeof tool === "function",
  );
  const schemaRegistry = programDriverSchemaRegistry(pickCard.artifacts.catalog);
  const availableContracts = projectAvailableToolContracts(options.tools, {
    ordinaryTools: new Set(ordinaryContracts.map((tool) => tool.name)),
    drivers: new Set(options.mode === "local" ? ["worker"] : []),
    programs: new Set(
      options.mode === "local"
        ? [
            `${pickCard.manifest.programId}@${pickCard.manifest.version}#${pickCard.manifest.digest}`,
          ]
        : [],
    ),
    effects: new Set(
      options.mode === "local"
        ? Object.values(pickCard.manifest.effects).map(
            (effect) => `${effect.name}@${effect.version}`,
          )
        : [],
    ),
    schemas: schemaRegistry,
    durableDrivers: new Map(options.mode === "local" ? [[pickCard.name, "worker"]] : []),
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
