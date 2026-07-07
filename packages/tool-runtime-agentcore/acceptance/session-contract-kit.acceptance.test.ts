import { run } from 'effection'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createTool } from '@sweatpants/core'
import { adaptToolSessionToSessionContract } from '@sweatpants/framework/chat/mcp-tools'
import { runBaseProfileConformance } from '@sweatpants/session-contract/testing'

import {
  FakeAgentCoreRemoteToolRuntimeClient,
  createAgentCoreToolSessionRegistry,
  createInMemoryAgentCoreToolSessionEventStore,
  createInMemoryAgentCoreToolSessionHandleStore,
  type AgentCoreToolRuntimeProfile,
  type AgentCoreToolSessionStores,
} from '../src/index.ts'

function createStores(): AgentCoreToolSessionStores {
  return {
    handles: createInMemoryAgentCoreToolSessionHandleStore(),
    events: createInMemoryAgentCoreToolSessionEventStore(),
  }
}

function createProfile(toolNames: string[]): AgentCoreToolRuntimeProfile {
  return {
    name: 'kit-profile',
    runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/test',
    endpointName: 'DEFAULT',
    region: 'us-east-1',
    toolNames,
    maxSessionTtlMs: 60_000,
  }
}

const RemoteElicitTool = createTool('session_contract_kit_agentcore_elicit')
  .description('Remote elicit tool for conformance kit')
  .parameters(z.object({}))
  .execute(function* () {
    return { unreachable: true }
  })

const RemoteSampleTool = createTool('session_contract_kit_agentcore_sample')
  .description('Remote sample tool for conformance kit')
  .parameters(z.object({}))
  .execute(function* () {
    return { unreachable: true }
  })

describe('@sweatpants/tool-runtime-agentcore session-contract kit bootstrap', () => {
  it('passes the exported base-profile conformance runner', async () => {
    await run(function* () {
      const runtimeClient = new FakeAgentCoreRemoteToolRuntimeClient()
      const registry = createAgentCoreToolSessionRegistry({
        stores: createStores(),
        runtimeClient,
        profiles: [createProfile([
          'session_contract_kit_agentcore_elicit',
          'session_contract_kit_agentcore_sample',
        ])],
        createRuntimeSessionId: (sessionId) => `kit-${sessionId}`,
      })

      const result = yield* runBaseProfileConformance({
        name: 'agentcore-tool-session',
        *createElicitSession(sessionId) {
          const toolSession = yield* registry.create(RemoteElicitTool, {}, { sessionId })
          return yield* adaptToolSessionToSessionContract(toolSession)
        },
        elicitPayload: { confirmed: true },
        *createSampleSession(sessionId) {
          const toolSession = yield* registry.create(RemoteSampleTool, {}, { sessionId })
          return yield* adaptToolSessionToSessionContract(toolSession)
        },
        samplePayload: { text: 'kit-sample' },
      })

      expect(result).toEqual({ name: 'agentcore-tool-session', scenarios: ['elicit', 'sample'] })
    })
  })
})
