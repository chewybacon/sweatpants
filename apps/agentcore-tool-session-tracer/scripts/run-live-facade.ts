import crypto from 'node:crypto'
import { call, run } from 'effection'
import {
  createAwsSdkAgentCoreInvoker,
} from '../../../packages/framework/src/lib/chat/mcp-tools/session/agentcore-aws-invoker.ts'
import {
  createAgentCoreRemoteToolRuntimeClient,
} from '../../../packages/framework/src/lib/chat/mcp-tools/session/agentcore-runtime-client.ts'
import {
  createAgentCoreToolSessionRegistry,
} from '../../../packages/framework/src/lib/chat/mcp-tools/session/agentcore-session-registry.ts'
import {
  createInMemoryAgentCoreToolSessionEventStore,
  createInMemoryAgentCoreToolSessionHandleStore,
} from '../../../packages/framework/src/lib/chat/mcp-tools/session/agentcore-memory-store.ts'
import type {
  AgentCoreToolRuntimeProfile,
  AgentCoreToolSessionStores,
} from '../../../packages/framework/src/lib/chat/mcp-tools/session/agentcore-types.ts'

if (process.env['APPROVE_AGENTCORE_PAID_INVOCATION'] !== 'yes') {
  console.error('Refusing live AgentCore facade smoke without APPROVE_AGENTCORE_PAID_INVOCATION=yes')
  process.exit(2)
}

const runtimeArnEnv = process.env['AGENTCORE_RUNTIME_ARN']
if (!runtimeArnEnv) throw new Error('AGENTCORE_RUNTIME_ARN is required')
const runtimeArn: string = runtimeArnEnv

const region = process.env['AWS_REGION'] ?? process.env['AWS_DEFAULT_REGION'] ?? 'us-east-1'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const elicitTool = { name: 'elicit_then_result' } as never

async function main(): Promise<void> {
  const stores: AgentCoreToolSessionStores = {
    handles: createInMemoryAgentCoreToolSessionHandleStore(),
    events: createInMemoryAgentCoreToolSessionEventStore(),
  }
  const runtimeClient = createAgentCoreRemoteToolRuntimeClient(createAwsSdkAgentCoreInvoker({ clientConfig: { region } }))
  const profile: AgentCoreToolRuntimeProfile = {
    name: 'live-tracer',
    runtimeArn,
    endpointName: process.env['AGENTCORE_QUALIFIER'] ?? 'DEFAULT',
    region,
    toolNames: ['elicit_then_result'],
    maxSessionTtlMs: 15 * 60 * 1000,
  }
  const runtimeSessionId = process.env['AGENTCORE_SESSION_ID'] ?? `sp-facade-${crypto.randomUUID()}`
  const toolSessionId = process.env['TOOL_SESSION_ID'] ?? `facade-tool-${crypto.randomUUID()}`

  const summary = await run(function* () {
    const registry = createAgentCoreToolSessionRegistry({
      stores,
      runtimeClient,
      profiles: [profile],
      createRuntimeSessionId: () => runtimeSessionId,
    })

    const session = yield* registry.create(elicitTool, {}, { sessionId: toolSessionId })
    const statusBefore = yield* session.status()
    assert(statusBefore === 'awaiting_elicit', `expected awaiting_elicit, got ${statusBefore}`)

    const handleBefore = yield* stores.handles.get(toolSessionId)
    const elicitId = handleBefore?.pendingRequest?.type === 'elicit' ? handleBefore.pendingRequest.elicitId : undefined
    assert(elicitId, 'missing pending elicit id in handle')

    const delayMs = Number(process.env['AGENTCORE_FACADE_DELAY_MS'] ?? '60000')
    yield* call(() => new Promise((resolve) => setTimeout(resolve, delayMs)))

    yield* session.respondToElicit(elicitId, { action: 'accept', content: { confirmed: true, via: 'sweatpants-facade' } })
    const statusAfter = yield* session.status()
    assert(statusAfter === 'completed', `expected completed, got ${statusAfter}`)

    const events = yield* stores.events.readAfter(toolSessionId, 0)
    const handleAfter = yield* stores.handles.get(toolSessionId)
    return {
      status: 'ok',
      runtimeArn,
      region,
      runtimeSessionId,
      toolSessionId,
      delayMs,
      statusBefore,
      statusAfter,
      handleBefore,
      handleAfter,
      eventTypes: events.events.map(({ event }) => event.type),
      events: events.events,
    }
  })

  console.log(JSON.stringify(summary, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exit(1)
})
