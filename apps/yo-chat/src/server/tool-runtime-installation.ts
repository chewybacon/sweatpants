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
  type PluginSessionManager,
} from "@sweatpants/framework/server";
import type {
  ToolSessionRegistry,
  ToolSessionSamplingProvider,
} from "@sweatpants/framework/chat/mcp-tools";
import {
  ToolSessionSamplingProviderContext,
  createToolSessionForeignEffectRegistrations,
  installLocalToolRuntime,
} from "@sweatpants/tool-runtime-local";
import { createAgentCoreToolExecutionStrategy } from "@sweatpants/tool-runtime-agentcore";

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
