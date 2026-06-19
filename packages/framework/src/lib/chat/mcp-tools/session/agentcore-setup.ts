import type { Operation } from 'effection'
import { ToolSessionRegistryContext } from './contexts.ts'
import type { ToolSessionRegistry } from './types.ts'
import type {
  AgentCoreToolRuntimeProfile,
  AgentCoreToolSessionHandle,
  AgentCoreToolSessionStores,
  RemoteToolRuntimeClient,
} from './agentcore-types.ts'
import {
  createAgentCoreToolSessionRegistry,
  type AgentCoreToolSessionRegistryOptions,
} from './agentcore-session-registry.ts'

export interface SetupAgentCoreToolSessionsOptions {
  stores: AgentCoreToolSessionStores
  runtimeClient: RemoteToolRuntimeClient<AgentCoreToolSessionHandle>
  profiles: AgentCoreToolRuntimeProfile[]
  defaultProfile?: string
  now?: () => Date
  createRuntimeSessionId?: (sessionId: string, toolName: string) => string
}

export function* setupAgentCoreToolSessions(
  options: SetupAgentCoreToolSessionsOptions
): Operation<ToolSessionRegistry> {
  const registryOptions: AgentCoreToolSessionRegistryOptions = {
    stores: options.stores,
    runtimeClient: options.runtimeClient,
    profiles: options.profiles,
    ...(options.defaultProfile !== undefined && { defaultProfile: options.defaultProfile }),
    ...(options.now !== undefined && { now: options.now }),
    ...(options.createRuntimeSessionId !== undefined && { createRuntimeSessionId: options.createRuntimeSessionId }),
  }
  const registry = createAgentCoreToolSessionRegistry(registryOptions)
  yield* ToolSessionRegistryContext.set(registry)
  return registry
}
