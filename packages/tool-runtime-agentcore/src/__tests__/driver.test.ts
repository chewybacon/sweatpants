import { describe, expect, it } from 'vitest'
import { run, resource, type Operation } from 'effection'
import { z } from 'zod'
import { createMcpTool, type ToolSessionRegistry, type ToolSession } from '@sweatpants/framework/chat/mcp-tools'
import { ToolRuntimeApi } from '@sweatpants/framework/chat'
import { createAgentCoreToolRuntimeDriver, installAgentCoreToolRuntime } from '../index.ts'

const remoteTool = createMcpTool('remote_echo')
  .description('Remote echo')
  .parameters(z.object({ message: z.string() }))
  .elicits({})
  .execute(function* () {
    return { unreachable: true }
  })

function createFakeSession(): ToolSession {
  return {
    id: 'call-remote',
    toolName: 'remote_echo',
    status() { return function* () { return 'completed' as const }() },
    events() {
      return resource(function* (provide) {
        let emitted = false
        yield* provide({
          *next() {
            if (emitted) return { done: true as const, value: undefined }
            emitted = true
            return {
              done: false as const,
              value: {
                type: 'result' as const,
                lsn: 1,
                timestamp: Date.now(),
                result: { ok: true },
              },
            }
          },
        })
      })
    },
    respondToElicit() { return function* () {}() },
    respondToSample() { return function* () {}() },
    cancel() { return function* () {}() },
  }
}

function createFakeRegistry(): ToolSessionRegistry {
  const session = createFakeSession()
  return {
    *create(): Operation<ToolSession> { return session },
    *get(): Operation<ToolSession | null> { return session },
    *acquire(): Operation<ToolSession> { return session },
    *release(): Operation<void> {},
  }
}

describe('AgentCore ToolRuntimeDriver', () => {
  it('lists tools and adapts AgentCore registry sessions', async () => {
    await run(function* () {
      const driver = createAgentCoreToolRuntimeDriver({
        tools: [remoteTool],
        registry: createFakeRegistry(),
      })

      const tools = yield* driver.listTools()
      expect(tools.map((tool) => tool.name)).toEqual(['remote_echo'])

      const session = yield* driver.startToolCall({
        toolName: 'remote_echo',
        callId: 'call-remote',
        arguments: { message: 'hello' },
      })
      expect(session.runtimeId).toBe('agentcore')

      const events = yield* session.events()
      const next = yield* events.next()
      expect(next.done).toBe(false)
      if (!next.done) {
        expect(next.value.type).toBe('result')
      }
    })
  })

  it('installer sets ToolRuntimeContext for ToolRuntimeApi', async () => {
    await run(function* () {
      yield* installAgentCoreToolRuntime({
        tools: [remoteTool],
        registry: createFakeRegistry(),
      })
      const tools = yield* ToolRuntimeApi.listTools()
      expect(tools.map((tool) => tool.name)).toEqual(['remote_echo'])
    })
  })
})
