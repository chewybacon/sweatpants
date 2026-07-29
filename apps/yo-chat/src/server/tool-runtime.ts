import type { AgentCoreRuntimeRelease } from "@sweatpants/tool-runtime-agentcore";
import { call, type Operation } from "effection";
import {
  createPluginSessionManager,
  type PluginSessionManager,
} from "@sweatpants/framework/server";
import type { ToolSessionRegistry, ToolSessionSamplingProvider } from "@sweatpants/tool-session";
import {
  PROGRAM_ARTIFACT_GENERATOR_VERSION,
  PROGRAM_ARTIFACT_IDENTITY_FORMAT,
  createGeneratedPinnedDurableProgram,
  generateProgramArtifactIdentity,
  type DurableProgramManifest,
  type Json,
} from "@sweatpants/session-contract";
import { createDurableSchemaRegistry } from "@sweatpants/journal-authority/schema-registry";
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
import { playTttTool } from "../tools/play-ttt/tool";
import { allTools } from "./tools";
import { createPluginSamplingProvider } from "./plugin-sampling-provider";
import { installYoChatToolRuntime } from "./tool-runtime-installation";

// The Vite plugin resolves this to the hand-authored worker entry. It is used
// only when the single selected runtime is local.
import toolWorkerUrl from "./tool-worker.ts?modulePath";

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
  const developmentPrograms = developmentProgramReleases();
  const readyTools = developmentPrograms?.map((entry) => entry.tool) ?? [pickCard];
  return {
    journalId: "yo-chat",
    release,
    driver: createAgentCoreDurableProgramDriver(
      createAgentCoreWebSocketProgramTransport(createSigV4AgentCoreWebSocketConnector()),
      {
        manifests: new Map(
          readyTools.map((tool) => [
            exactProgramKey({
              id: tool.manifest.programId,
              version: tool.manifest.version,
              digest: tool.manifest.digest,
            }),
            tool.manifest,
          ]),
        ),
      },
    ),
    availablePrograms: new Set<string>(
      readyTools.map((tool) =>
        exactProgramKey({
          id: tool.manifest.programId,
          version: tool.manifest.version,
          digest: tool.manifest.digest,
        }),
      ),
    ),
    availableEffects: new Set<string>(
      readyTools.flatMap((tool) =>
        Object.values(tool.manifest.effects).map((effect) => `${effect.name}@${effect.version}`),
      ),
    ),
    availableSchemaDigests: new Set<string>([
      ...createDurableSchemaRegistry()
        .descriptors()
        .map((descriptor) => descriptor.digest),
      ...readyTools.flatMap((tool) =>
        tool.artifacts.catalog.map((entry) => entry.descriptor.digest),
      ),
    ]),
    ...(developmentPrograms ? { developmentPrograms } : {}),
  };
}

function developmentProgramReleases():
  | readonly {
      readonly publicKey: string;
      readonly tool: typeof playTttTool;
      readonly collection: Json;
      readonly evaluatorAbi: string;
    }[]
  | undefined {
  const encoded = env.AGENTCORE_DEVELOPMENT_ACTIVE_RECORD_JSON;
  if (!encoded) {
    return undefined;
  }
  const active = JSON.parse(encoded) as {
    readonly record: {
      readonly collection: Json;
      readonly evaluatorAbi: string;
    };
    readonly programs: Readonly<
      Record<
        string,
        {
          readonly programId: string;
          readonly version: string;
          readonly manifestDigest: string;
          readonly implementationArtifactDigest: string;
          readonly resourcePackageDigests: readonly string[];
        }
      >
    >;
  };
  const entry = active.programs["play_ttt"];
  if (
    !entry ||
    entry.programId !== playTttTool.manifest.programId ||
    entry.version !== playTttTool.manifest.version
  ) {
    throw new Error("Active development collection does not contain compatible play_ttt");
  }
  const { digest: _authoredDigest, ...manifest } = playTttTool.manifest;
  const generated = createGeneratedPinnedDurableProgram(
    generateProgramArtifactIdentity({
      format: PROGRAM_ARTIFACT_IDENTITY_FORMAT,
      generatorVersion: PROGRAM_ARTIFACT_GENERATOR_VERSION,
      manifest: manifest as Omit<DurableProgramManifest, "digest">,
      implementationArtifactDigest: entry.implementationArtifactDigest,
      resourcePackageDigests: entry.resourcePackageDigests,
    }),
    playTttTool.program,
  );
  if (generated.manifest.digest !== entry.manifestDigest) {
    throw new Error("Active development program identity does not re-derive");
  }
  const tool = Object.freeze({ ...playTttTool, ...generated });
  return [
    {
      publicKey: "play_ttt",
      tool,
      collection: active.record.collection,
      evaluatorAbi: active.record.evaluatorAbi,
    },
  ];
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
