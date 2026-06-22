import { call, type Operation } from 'effection'
import {
  PluginSessionManagerContext,
  PluginSessionRegistryContext,
  ToolInventoryContext,
  createToolInventory,
} from '@sweatpants/framework/chat'
import { createPluginSessionManager, type PluginSessionManager } from '@sweatpants/framework/server'
import { type ToolSessionRegistry } from '@sweatpants/framework/chat/mcp-tools'
import {
  ToolSessionSamplingProviderContext,
  createInMemoryToolSessionStore,
  createIsomorphicToolInventoryEntry,
  createMcpToolInventoryEntry,
  createToolSessionRegistry,
  installLocalToolRuntime,
} from '@sweatpants/tool-runtime-local'
import {
  createAgentCoreRemoteToolRuntimeClient,
  createAgentCoreToolInventoryEntry,
  createAgentCoreToolSessionRegistry,
  createAwsSdkAgentCoreInvoker,
  createInMemoryAgentCoreToolSessionEventStore,
  createInMemoryAgentCoreToolSessionHandleStore,
  createRedisAgentCoreToolSessionEventStore,
  createRedisAgentCoreToolSessionHandleStore,
  installAgentCoreToolRuntime,
  type AgentCoreToolRuntimeProfile,
  type AgentCoreToolSessionStores,
  type RedisLikeClient,
} from '@sweatpants/tool-runtime-agentcore'
import { env } from '@/env'
import { getSharedRedisClient } from '@/lib/shared-redis'
import toolWorkerUrl from '../__generated__/tool-worker.gen.ts?modulePath'
import {
  activeAgentCoreToolNames,
  activePluginTools,
  allTools,
  canonicalizeAgentCoreTool,
} from './tools'
import { pluginSamplingProvider } from './plugin-sampling-provider'

let sharedPluginSessionRegistry: ToolSessionRegistry | null = null
let sharedPluginSessionManager: PluginSessionManager | null = null

function* createLocalPluginToolSessionRegistry(): Operation<ToolSessionRegistry> {
  const store = createInMemoryToolSessionStore()
  return yield* createToolSessionRegistry(store, {
    samplingProvider: pluginSamplingProvider,
    worker: {
      workerUrl: toolWorkerUrl,
      isDev: process.env['NODE_ENV'] !== 'production',
    },
  })
}

function* createAgentCoreStores(): Operation<AgentCoreToolSessionStores> {
  const redis = yield* call(() => getSharedRedisClient())
  if (!redis) {
    return {
      handles: createInMemoryAgentCoreToolSessionHandleStore(),
      events: createInMemoryAgentCoreToolSessionEventStore(),
    }
  }

  const redisOptions = {
    keyPrefix: env.AGENTCORE_REDIS_KEY_PREFIX,
    defaultTtlSeconds: Math.max(1, Math.ceil(env.AGENTCORE_TOOL_SESSION_TTL_MS / 1000)),
  }
  const client = redis as unknown as RedisLikeClient
  return {
    handles: createRedisAgentCoreToolSessionHandleStore(client, redisOptions),
    events: createRedisAgentCoreToolSessionEventStore(client, redisOptions),
  }
}

function requireAgentCorePaidInvocationApproval(): void {
  if (process.env['APPROVE_AGENTCORE_PAID_INVOCATION'] !== 'yes') {
    throw new Error(
      'MCP_TOOL_RUNTIME=agentcore with AGENTCORE_RUNTIME_ARN may invoke paid AWS Bedrock AgentCore Runtime services. '
      + 'Set APPROVE_AGENTCORE_PAID_INVOCATION=yes for local/development app-mode AgentCore invocation.'
    )
  }
}

function* createAgentCorePluginToolSessionRegistry(): Operation<ToolSessionRegistry> {
  if (!env.AGENTCORE_RUNTIME_ARN) {
    throw new Error('AGENTCORE_RUNTIME_ARN is required when MCP_TOOL_RUNTIME=agentcore')
  }

  requireAgentCorePaidInvocationApproval()

  const toolNames = activeAgentCoreToolNames()
  if (toolNames.length === 0) {
    throw new Error('generated AgentCore tool registry must contain at least one tool when MCP_TOOL_RUNTIME=agentcore')
  }

  const stores = yield* createAgentCoreStores()
  const runtimeClient = createAgentCoreRemoteToolRuntimeClient(
    createAwsSdkAgentCoreInvoker({ clientConfig: { region: env.AGENTCORE_REGION } })
  )
  const profile: AgentCoreToolRuntimeProfile = {
    name: env.AGENTCORE_RUNTIME_PROFILE_NAME,
    runtimeArn: env.AGENTCORE_RUNTIME_ARN,
    endpointName: env.AGENTCORE_ENDPOINT_NAME,
    region: env.AGENTCORE_REGION,
    toolNames,
    maxSessionTtlMs: env.AGENTCORE_TOOL_SESSION_TTL_MS,
  }

  return createAgentCoreToolSessionRegistry({
    stores,
    runtimeClient,
    profiles: [profile],
    defaultProfile: profile.name,
  })
}

function redactAgentCoreArn(value: string | undefined): string | undefined {
  if (!value) return undefined
  const suffix = value.split('/').pop()?.slice(-8) ?? 'unknown'
  return `[redacted-agentcore-runtime:${suffix}]`
}

function* createConfiguredPluginToolSessionRegistry(): Operation<ToolSessionRegistry> {
  if (env.MCP_TOOL_RUNTIME === 'agentcore') {
    console.info('[yo-chat] MCP tool runtime: agentcore', {
      runtimeArn: redactAgentCoreArn(env.AGENTCORE_RUNTIME_ARN),
      endpointName: env.AGENTCORE_ENDPOINT_NAME,
      region: env.AGENTCORE_REGION,
      toolNames: activeAgentCoreToolNames(),
    })
    return yield* createAgentCorePluginToolSessionRegistry()
  }

  console.info('[yo-chat] MCP tool runtime: local')
  return yield* createLocalPluginToolSessionRegistry()
}

function runtimePluginTools() {
  return env.MCP_TOOL_RUNTIME === 'agentcore'
    ? activePluginTools.map(canonicalizeAgentCoreTool)
    : activePluginTools
}

export function* setupYoChatPluginsAndRuntime(): Operation<void> {
  yield* ToolSessionSamplingProviderContext.set(pluginSamplingProvider)

  if (!sharedPluginSessionRegistry || !sharedPluginSessionManager) {
    sharedPluginSessionRegistry = yield* createConfiguredPluginToolSessionRegistry()
    sharedPluginSessionManager = yield* createPluginSessionManager({
      registry: sharedPluginSessionRegistry,
      samplingProvider: pluginSamplingProvider,
    })
  }

  yield* PluginSessionRegistryContext.set(sharedPluginSessionRegistry)
  yield* PluginSessionManagerContext.set(sharedPluginSessionManager)

  const pluginTools = runtimePluginTools()
  const pluginGeneratedNames = new Set(activePluginTools.map((tool) => tool.name))
  yield* ToolInventoryContext.set(createToolInventory([
    ...allTools
      .filter((tool) => !pluginGeneratedNames.has(tool.name))
      .map((tool) => createIsomorphicToolInventoryEntry(tool)),
    ...(env.MCP_TOOL_RUNTIME === 'agentcore'
      ? pluginTools.map((tool) => createAgentCoreToolInventoryEntry(tool))
      : pluginTools.map((tool) => createMcpToolInventoryEntry(tool))),
  ]))

  if (env.MCP_TOOL_RUNTIME === 'agentcore') {
    yield* installAgentCoreToolRuntime({
      tools: pluginTools,
      registry: sharedPluginSessionRegistry,
    })
    return
  }

  yield* installLocalToolRuntime({
    tools: pluginTools,
    isomorphicTools: allTools,
    registry: sharedPluginSessionRegistry,
    samplingProvider: pluginSamplingProvider,
  })
}
