import { call, type Operation } from "effection";
import {
  PluginSessionManagerContext,
  PluginSessionRegistryContext,
  ToolInventoryContext,
  ToolRuntimeContext,
  createStrategyToolRuntime,
  createToolInventory,
} from "@sweatpants/framework/chat";
import {
  createPluginSessionManager,
  type PluginSessionManager,
} from "@sweatpants/framework/server";
import { type ToolSessionRegistry } from "@sweatpants/framework/chat/mcp-tools";
import {
  ToolSessionSamplingProviderContext,
  createInMemoryToolSessionStore,
  createIsomorphicToolInventoryEntry,
  createLocalInlineToolExecutionStrategy,
  createMcpToolInventoryEntry,
  createToolSessionRegistry,
  installLocalToolRuntime,
} from "@sweatpants/tool-runtime-local";
import {
  createAgentCoreRemoteToolRuntimeClient,
  createAgentCoreToolExecutionStrategy,
  createAgentCoreToolInventoryEntry,
  createAgentCoreToolSessionRegistry,
  createAwsSdkAgentCoreInvoker,
  createInMemoryAgentCoreToolSessionEventStore,
  createInMemoryAgentCoreToolSessionHandleStore,
  createRedisAgentCoreToolSessionEventStore,
  createRedisAgentCoreToolSessionHandleStore,
  type AgentCoreToolRuntimeProfile,
  type AgentCoreToolSessionStores,
  type RedisLikeClient,
} from "@sweatpants/tool-runtime-agentcore";
import { env } from "@/env";
import { getSharedRedisClient } from "@/lib/shared-redis";
import { activeAgentCoreToolNames, activePluginTools, allTools } from "./tools";
import { pluginSamplingProvider } from "./plugin-sampling-provider";

type LocalMcpTool = Parameters<typeof createMcpToolInventoryEntry>[0];
type LocalIsomorphicRuntimeTool = Parameters<typeof createIsomorphicToolInventoryEntry>[0];
type AgentCoreMcpTool = Parameters<typeof createAgentCoreToolInventoryEntry>[0];

let sharedPluginSessionRegistry: ToolSessionRegistry | null = null;
let sharedPluginSessionManager: PluginSessionManager | null = null;

function* createLocalPluginToolSessionRegistry(): Operation<ToolSessionRegistry> {
  const store = createInMemoryToolSessionStore();
  return yield* createToolSessionRegistry(store, {
    samplingProvider: pluginSamplingProvider,
  });
}

function* createAgentCoreStores(): Operation<AgentCoreToolSessionStores> {
  const redis = yield* call(() => getSharedRedisClient());
  if (!redis) {
    return {
      handles: createInMemoryAgentCoreToolSessionHandleStore(),
      events: createInMemoryAgentCoreToolSessionEventStore(),
    };
  }

  const redisOptions = {
    keyPrefix: env.AGENTCORE_REDIS_KEY_PREFIX,
    defaultTtlSeconds: Math.max(1, Math.ceil(env.AGENTCORE_TOOL_SESSION_TTL_MS / 1000)),
  };
  const client = redis as unknown as RedisLikeClient;
  return {
    handles: createRedisAgentCoreToolSessionHandleStore(client, redisOptions),
    events: createRedisAgentCoreToolSessionEventStore(client, redisOptions),
  };
}

function* createAgentCorePluginToolSessionRegistry(): Operation<ToolSessionRegistry> {
  if (!env.AGENTCORE_RUNTIME_ARN) {
    throw new Error("AGENTCORE_RUNTIME_ARN is required when MCP_TOOL_RUNTIME=agentcore");
  }

  const toolNames = activeAgentCoreToolNames();
  if (toolNames.length === 0) {
    throw new Error(
      "generated AgentCore tool registry must contain at least one tool when MCP_TOOL_RUNTIME=agentcore",
    );
  }

  const stores = yield* createAgentCoreStores();
  const runtimeClient = createAgentCoreRemoteToolRuntimeClient(
    createAwsSdkAgentCoreInvoker({ clientConfig: { region: env.AGENTCORE_REGION } }),
  );
  const profile: AgentCoreToolRuntimeProfile = {
    name: env.AGENTCORE_RUNTIME_PROFILE_NAME,
    runtimeArn: env.AGENTCORE_RUNTIME_ARN,
    endpointName: env.AGENTCORE_ENDPOINT_NAME,
    region: env.AGENTCORE_REGION,
    toolNames,
    maxSessionTtlMs: env.AGENTCORE_TOOL_SESSION_TTL_MS,
  };

  return createAgentCoreToolSessionRegistry({
    stores,
    runtimeClient,
    profiles: [profile],
    defaultProfile: profile.name,
  });
}

function redactAgentCoreArn(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const suffix = value.split("/").pop()?.slice(-8) ?? "unknown";
  return `[redacted-agentcore-runtime:${suffix}]`;
}

function* createConfiguredPluginToolSessionRegistry(): Operation<ToolSessionRegistry> {
  if (env.MCP_TOOL_RUNTIME === "agentcore") {
    console.info("[yo-chat] MCP tool runtime: agentcore", {
      runtimeArn: redactAgentCoreArn(env.AGENTCORE_RUNTIME_ARN),
      endpointName: env.AGENTCORE_ENDPOINT_NAME,
      region: env.AGENTCORE_REGION,
      toolNames: activeAgentCoreToolNames(),
    });
    return yield* createAgentCorePluginToolSessionRegistry();
  }

  console.info("[yo-chat] MCP tool runtime: local");
  return yield* createLocalPluginToolSessionRegistry();
}

function runtimePluginTools(): LocalMcpTool[] {
  // Tool names are already canonical (no prefixing/aliasing), so AgentCore and
  // local runtimes use the same tool objects directly.
  return activePluginTools as LocalMcpTool[];
}

function parametersToSchema(parameters: unknown): Record<string, unknown> {
  return parameters && typeof parameters === "object"
    ? (parameters as Record<string, unknown>)
    : { type: "object", properties: {}, required: [] };
}

export function* setupYoChatPluginsAndRuntime(): Operation<void> {
  yield* ToolSessionSamplingProviderContext.set(pluginSamplingProvider);

  if (!sharedPluginSessionRegistry || !sharedPluginSessionManager) {
    sharedPluginSessionRegistry = yield* createConfiguredPluginToolSessionRegistry();
    sharedPluginSessionManager = yield* createPluginSessionManager({
      registry: sharedPluginSessionRegistry,
      samplingProvider: pluginSamplingProvider,
    });
  }

  yield* PluginSessionRegistryContext.set(sharedPluginSessionRegistry);
  yield* PluginSessionManagerContext.set(sharedPluginSessionManager);

  const pluginTools = runtimePluginTools();
  const pluginGeneratedNames = new Set<string>(activePluginTools.map((tool) => tool.name));
  yield* ToolInventoryContext.set(
    createToolInventory([
      ...allTools
        .filter((tool) => !pluginGeneratedNames.has(tool.name))
        .map((tool) => createIsomorphicToolInventoryEntry(tool as LocalIsomorphicRuntimeTool)),
      ...(env.MCP_TOOL_RUNTIME === "agentcore"
        ? pluginTools.map((tool) => createAgentCoreToolInventoryEntry(tool as AgentCoreMcpTool))
        : pluginTools.map((tool) => createMcpToolInventoryEntry(tool))),
    ]),
  );

  if (env.MCP_TOOL_RUNTIME === "agentcore") {
    const runtime = createStrategyToolRuntime({
      id: "agentcore",
      strategies: [
        createAgentCoreToolExecutionStrategy({
          tools: pluginTools as AgentCoreMcpTool[],
          registry: sharedPluginSessionRegistry,
          samplingProvider: pluginSamplingProvider,
        }),
        createLocalInlineToolExecutionStrategy(),
      ],
    });

    const runtimeWithListTools = {
      ...runtime,
      *listTools() {
        return [
          ...pluginTools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: parametersToSchema(tool.parameters),
          })),
          ...allTools.map((tool) => ({
            name: (tool as LocalIsomorphicRuntimeTool).name,
            description: (tool as LocalIsomorphicRuntimeTool).description,
            parameters: parametersToSchema((tool as LocalIsomorphicRuntimeTool).parameters),
          })),
        ];
      },
    };
    yield* ToolRuntimeContext.set(runtimeWithListTools);
    return;
  }

  yield* installLocalToolRuntime({
    tools: pluginTools,
    isomorphicTools: allTools as LocalIsomorphicRuntimeTool[],
    registry: sharedPluginSessionRegistry,
    samplingProvider: pluginSamplingProvider,
  });
}
