import { call, type Operation } from "effection";
import {
  createPluginSessionManager,
  type PluginSessionManager,
} from "@sweatpants/framework/server";
import type { ToolSessionRegistry } from "@sweatpants/framework/chat/mcp-tools";
import {
  createInMemoryToolSessionStore,
  createToolSessionRegistry,
} from "@sweatpants/tool-runtime-local";
import {
  createAgentCoreRemoteToolRuntimeClient,
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
import { allTools } from "./tools";
import { pluginSamplingProvider } from "./plugin-sampling-provider";
import { installYoChatToolRuntime } from "./tool-runtime-installation";

// The Vite plugin resolves this to the generated worker module. It is used only
// when the single selected runtime is local.
import toolWorkerUrl from "../__generated__/tool-worker.gen.ts?modulePath";

let sharedRegistry: ToolSessionRegistry | null = null;
let sharedPluginSessionManager: PluginSessionManager | null = null;

function* createLocalRegistry(): Operation<ToolSessionRegistry> {
  return yield* createToolSessionRegistry(createInMemoryToolSessionStore(), {
    samplingProvider: pluginSamplingProvider,
    worker: {
      workerUrl: toolWorkerUrl,
      isDev: process.env["NODE_ENV"] !== "production",
    },
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
  // SAFETY: both adapters use the same Redis command subset; the framework
  // client carries wider generic module metadata than the narrow store port.
  const client = redis as unknown as RedisLikeClient;
  return {
    handles: createRedisAgentCoreToolSessionHandleStore(client, redisOptions),
    events: createRedisAgentCoreToolSessionEventStore(client, redisOptions),
  };
}

function* createAgentCoreRegistry(): Operation<ToolSessionRegistry> {
  if (!env.AGENTCORE_RUNTIME_ARN) {
    throw new Error("AGENTCORE_RUNTIME_ARN is required when MCP_TOOL_RUNTIME=agentcore");
  }
  const toolNames = allTools.map((tool) => tool.name);
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
    stores: yield* createAgentCoreStores(),
    runtimeClient,
    profiles: [profile],
    defaultProfile: profile.name,
  });
}

function redactAgentCoreArn(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const suffix = value.split("/").pop()?.slice(-8) ?? "unknown";
  return `[redacted-agentcore-runtime:${suffix}]`;
}

function* createSelectedRegistry(): Operation<ToolSessionRegistry> {
  if (env.MCP_TOOL_RUNTIME === "agentcore") {
    console.info("[yo-chat] tool runtime: agentcore", {
      runtimeArn: redactAgentCoreArn(env.AGENTCORE_RUNTIME_ARN),
      endpointName: env.AGENTCORE_ENDPOINT_NAME,
      region: env.AGENTCORE_REGION,
      toolCount: allTools.length,
    });
    return yield* createAgentCoreRegistry();
  }
  console.info("[yo-chat] tool runtime: local", { toolCount: allTools.length });
  return yield* createLocalRegistry();
}

/** Installs all discovered tools into the single selected runtime. */
export function* setupYoChatPluginsAndRuntime(): Operation<void> {
  if (!sharedRegistry || !sharedPluginSessionManager) {
    sharedRegistry = yield* createSelectedRegistry();
    sharedPluginSessionManager = yield* createPluginSessionManager({
      registry: sharedRegistry,
      samplingProvider: pluginSamplingProvider,
    });
  }
  yield* installYoChatToolRuntime({
    mode: env.MCP_TOOL_RUNTIME,
    registry: sharedRegistry,
    pluginManager: sharedPluginSessionManager,
    samplingProvider: pluginSamplingProvider,
    tools: [...allTools],
  });
}
