import { describe, expect, it } from 'vitest'
import { run, resource, type Operation } from 'effection'
import { z } from 'zod'
import { createMcpTool, type ToolSessionRegistry, type ToolSession } from '@sweatpants/framework/chat/mcp-tools'
import { ToolRuntimeApi, createToolInventory } from '@sweatpants/framework/chat'
import {
  createAgentCoreToolExecutionStrategy,
  createAgentCoreToolInventoryEntry,
  createAgentCoreToolRuntimeDriver,
  installAgentCoreToolRuntime,
} from '../index.ts'

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

  it('creates AgentCore inventory entries and normalized executions', async () => {
    const entry = createAgentCoreToolInventoryEntry(remoteTool, { profile: 'test' })
    expect(entry.definition).toMatchObject({ name: 'remote_echo', description: 'Remote echo' })
    expect('implementation' in entry.definition).toBe(false)
    expect(entry.capabilities).toMatchObject({ remote: true, session: true, elicits: true, samples: true })
    expect(() => createToolInventory([entry, entry])).toThrow('Duplicate tool name')

    await run(function* () {
      const driver = createAgentCoreToolRuntimeDriver({ tools: [remoteTool], registry: createFakeRegistry() })
      const result = yield* driver.execute({
        entry,
        call: { id: 'call-remote', type: 'function', function: { name: 'remote_echo', arguments: { message: 'hello' } } },
      })
      expect(result).toMatchObject({ kind: 'completed', result: { ok: true } })
      expect(result.ref).toMatchObject({ runtimeId: 'agentcore', callId: 'call-remote', toolName: 'remote_echo', sessionId: 'call-remote' })

      try {
        yield* driver.execute({
          entry: { definition: { name: 'unsupported', description: 'nope', parameters: {} } },
          call: { id: 'call-bad', type: 'function', function: { name: 'unsupported', arguments: {} } },
        })
        throw new Error('expected unsupported tool')
      } catch (error) {
        expect(error).toMatchObject({ code: 'NO_MATCHING_TOOL_STRATEGY' })
      }

      try {
        yield* driver.resume({
          ref: { runtimeId: 'agentcore', executionId: 'call-remote', sessionId: 'call-remote', callId: 'call-remote', toolName: 'other_tool' },
          input: { type: 'elicit_response', elicitId: 'elicit', result: { action: 'accept' } },
        })
        throw new Error('expected wrong tool')
      } catch (error) {
        expect(error).toMatchObject({ code: 'EXECUTION_NOT_FOUND' })
      }
    })
  })

  it('exports an executable AgentCore strategy object', async () => {
    await run(function* () {
      const strategy = createAgentCoreToolExecutionStrategy({ registry: createFakeRegistry(), tools: [remoteTool] })
      const entry = createAgentCoreToolInventoryEntry(remoteTool)
      expect(strategy.canExecute(entry, { id: 'call-remote', type: 'function', function: { name: 'remote_echo', arguments: {} } }, { runtimeId: 'agentcore' })).toBe(true)
      const result = yield* strategy.execute(entry, { id: 'call-remote', type: 'function', function: { name: 'remote_echo', arguments: { message: 'hello' } } }, { runtimeId: 'agentcore' })
      expect(result).toMatchObject({ kind: 'completed', result: { ok: true } })
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
