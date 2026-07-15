import type { RuntimeTool } from "@sweatpants/core";
import type { Operation } from "effection";
import {
  PluginSessionManagerContext,
  PluginSessionRegistryContext,
  ToolInventoryContext,
  ToolRuntimeContext,
  createStrategyToolRuntime,
  createToolInventory,
  createToolInventoryEntry,
} from "@sweatpants/framework/chat";
import {
  ProgramDriverForeignEffectsContext,
  ProgramDriverNativeToolsContext,
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

import { durablePickCard, runtimeDurablePickCard } from "../tools/pick-card/durable";
import { createDrawPickCardsRegistration } from "../tools/pick-card/durable-effects";
import { yoChatDurableProgramWorkerUrl } from "./tool-worker-config";

/** Explicit dependencies for installing one complete yo-chat tool runtime. */
export interface YoChatToolRuntimeInstallation {
  mode: "local" | "agentcore";
  registry: ToolSessionRegistry;
  pluginManager: PluginSessionManager;
  samplingProvider: ToolSessionSamplingProvider;
  tools: RuntimeTool[];
}

/**
 * Installs the entire tool inventory into exactly one execution runtime. Local
 * mode uses one worker-backed registry; AgentCore mode uses one remote registry.
 */
export function* installYoChatToolRuntime(options: YoChatToolRuntimeInstallation): Operation<void> {
  yield* ToolSessionSamplingProviderContext.set(options.samplingProvider);
  yield* PluginSessionRegistryContext.set(options.registry);
  yield* PluginSessionManagerContext.set(options.pluginManager);
  yield* ToolInventoryContext.set(
    createToolInventory(options.tools.map((tool) => createToolInventoryEntry(tool))),
  );
  yield* ProgramDriverForeignEffectsContext.set(
    createToolSessionForeignEffectRegistrations({
      registry: options.registry,
      tools: new Map(options.tools.map((tool) => [tool.name, tool])),
    }),
  );

  if (options.mode === "local") {
    const durableRegistry = createDurableToolRegistry([runtimeDurablePickCard]);
    yield* ProgramDriverNativeToolsContext.set({
      bindings: new Map([
        [
          durablePickCard.name,
          {
            publicName: durablePickCard.name,
            tool: runtimeDurablePickCard,
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
            tools: options.tools,
            registry: options.registry,
            samplingProvider: options.samplingProvider,
          }),
        ],
      }),
    );
    return;
  }

  yield* installLocalToolRuntime({
    tools: options.tools,
    registry: options.registry,
    samplingProvider: options.samplingProvider,
  });
}
