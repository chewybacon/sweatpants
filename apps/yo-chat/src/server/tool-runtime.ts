import { call, type Operation } from "effection";
import {
  createPluginSessionManager,
  type PluginSessionManager,
} from "@sweatpants/framework/server";
import type {
  ToolSessionRegistry,
  ToolSessionSamplingProvider,
} from "@sweatpants/framework/chat/mcp-tools";
import type { AgentCoreRuntimeRelease } from "@sweatpants/session-contract";
import {
  createInMemoryToolSessionStore,
  createToolSessionRegistry,
} from "@sweatpants/tool-runtime-local";
import {
  createAgentCoreDurableProgramDriver,
  createAgentCoreRemoteToolRuntimeClient,
  createAgentCoreToolSessionRegistry,
  createAwsSdkAgentCoreInvoker,
  createInMemoryAgentCoreToolSessionEventStore,
  createInMemoryAgentCoreToolSessionHandleStore,
  createRedisAgentCoreToolSessionEventStore,
  createRedisAgentCoreToolSessionHandleStore,
  createAgentCoreWebSocketProgramTransport,
  createSigV4AgentCoreWebSocketConnector,
  exactProgramKey,
  type AgentCoreToolRuntimeProfile,
  type AgentCoreToolSessionStores,
  type RedisLikeClient,
} from "@sweatpants/tool-runtime-agentcore";
import { env } from "@/env";
import { getSharedRedisClient } from "@/lib/shared-redis";
import { pickCard } from "../tools/pick-card/durable";
import { allTools } from "./tools";
import { createPluginSamplingProvider } from "./plugin-sampling-provider";
import { installYoChatToolRuntime } from "./tool-runtime-installation";

// The Vite plugin resolves this to the generated worker module. It is used only
// when the single selected runtime is local.
import toolWorkerUrl from "../__generated__/tool-worker.gen.ts?modulePath";

let sharedRegistry: ToolSessionRegistry | null = null;
let sharedPluginSessionManager: PluginSessionManager | null = null;
let sharedSamplingProvider: ToolSessionSamplingProvider | null = null;

function* createLocalRegistry(): Operation<ToolSessionRegistry> {
  return yield* createToolSessionRegistry(createInMemoryToolSessionStore(), {
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
  const toolNames = allTools
    .filter((tool) => tool.execution !== "crank_native")
    .map((tool) => tool.name);
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

function durableAgentCoreInstallation() {
  if (
    !env.AGENTCORE_RUNTIME_ARN ||
    !env.AGENTCORE_DURABLE_RELEASE_ID ||
    !env.AGENTCORE_DURABLE_IMAGE_DIGEST ||
    !env.AGENTCORE_DURABLE_REGISTRY_DIGEST ||
    !env.AGENTCORE_DURABLE_IAM_PROFILE ||
    !env.AGENTCORE_DURABLE_NETWORK_PROFILE
  ) {
    return undefined;
  }
  const release: AgentCoreRuntimeRelease = {
    releaseId: env.AGENTCORE_DURABLE_RELEASE_ID,
    runtimeArn: env.AGENTCORE_RUNTIME_ARN,
    region: env.AGENTCORE_REGION,
    imageDigest: env.AGENTCORE_DURABLE_IMAGE_DIGEST,
    protocolVersion: 1,
    registryDigest: env.AGENTCORE_DURABLE_REGISTRY_DIGEST,
    iamProfile: env.AGENTCORE_DURABLE_IAM_PROFILE,
    networkProfile: env.AGENTCORE_DURABLE_NETWORK_PROFILE,
    filesystem: { kind: "managed_session_storage", mountPath: "/mnt/workspace" },
    lifecycle: {
      idleRuntimeSessionTimeoutSeconds: env.AGENTCORE_DURABLE_IDLE_TIMEOUT_SECONDS,
      maxLifetimeSeconds: env.AGENTCORE_DURABLE_MAX_LIFETIME_SECONDS,
    },
  };
  const program = {
    id: pickCard.manifest.programId,
    version: pickCard.manifest.version,
    digest: pickCard.manifest.digest,
  };
  return {
    journalId: "yo-chat",
    release,
    driver: createAgentCoreDurableProgramDriver(
      createAgentCoreWebSocketProgramTransport(createSigV4AgentCoreWebSocketConnector()),
    ),
    availablePrograms: new Set<string>([exactProgramKey(program)]),
    availableEffects: new Set<string>(
      Object.values(pickCard.manifest.effects).map((effect) => `${effect.name}@${effect.version}`),
    ),
    availableSchemaDigests: new Set<string>(
      pickCard.artifacts.catalog.map((entry) => entry.descriptor.digest),
    ),
  };
}

/** Installs all discovered tools into the single selected runtime. */
export function* setupYoChatPluginsAndRuntime(): Operation<void> {
  if (!sharedRegistry || !sharedPluginSessionManager || !sharedSamplingProvider) {
    sharedSamplingProvider = createPluginSamplingProvider();
    sharedRegistry = yield* createSelectedRegistry();
    sharedPluginSessionManager = yield* createPluginSessionManager({
      registry: sharedRegistry,
      samplingProvider: sharedSamplingProvider,
    });
  }
  const agentCoreDurable =
    env.MCP_TOOL_RUNTIME === "agentcore" ? durableAgentCoreInstallation() : undefined;
  yield* installYoChatToolRuntime({
    mode: env.MCP_TOOL_RUNTIME,
    registry: sharedRegistry,
    pluginManager: sharedPluginSessionManager,
    samplingProvider: sharedSamplingProvider,
    tools: [...allTools],
    ...(agentCoreDurable ? { agentCoreDurable } : {}),
  });
}
