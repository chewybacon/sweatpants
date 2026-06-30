import { describe, expect, it } from 'vitest'
import { run } from 'effection'
import { z } from 'zod'
import { createTool } from '@sweatpants/core'
import { ToolRuntimeApi, createToolInventory } from '@sweatpants/framework/chat'
import {
  createLocalToolRuntimeDriver,
  createToolInventoryEntry,
  installLocalToolRuntime,
} from '../index.ts'

const echoTool = createTool('echo')
  .description('Echo input')
  .parameters(z.object({ message: z.string() }))
  
  .execute(function* (params) {
    return { echoed: params.message }
  })

describe('local ToolRuntimeDriver', () => {
  it('lists tools and executes a local session', async () => {
    await run(function* () {
      const driver = yield* createLocalToolRuntimeDriver({
        tools: [echoTool],
        samplingProvider: { *sample() { return { text: 'unused' } } },
      })

      const tools = yield* driver.listTools()
      expect(tools.map((tool) => tool.name)).toEqual(['echo'])

      const session = yield* driver.startToolCall({
        toolName: 'echo',
        callId: 'call-echo',
        arguments: { message: 'hello' },
      })

      expect(session.runtimeId).toBe('local')
      expect(session.id).toBe('call-echo')

      const events = yield* session.events()
      let finalResult: unknown
      while (true) {
        const next = yield* events.next()
        if (next.done) break
        if (next.value.type === 'result') {
          finalResult = next.value.result
          break
        }
      }

      expect(finalResult).toEqual({ echoed: 'hello' })
    })
  })

  it('rejects invalid session params before creating a local session', async () => {
    await run(function* () {
      let executeCalls = 0
      const strictTool = createTool('strict_echo')
        .description('Strict echo input')
        .parameters(z.object({ message: z.string() }))
        
        .execute(function* (params) {
          executeCalls++
          return { echoed: params.message }
        })

      const driver = yield* createLocalToolRuntimeDriver({
        tools: [strictTool],
        samplingProvider: { *sample() { return { text: 'unused' } } },
      })

      try {
        yield* driver.startToolCall({
          toolName: 'strict_echo',
          callId: 'call-invalid-session',
          arguments: {},
        })
        throw new Error('expected validation failure')
      } catch (error) {
        expect(error).toMatchObject({
          code: 'TOOL_PARAMETER_VALIDATION_FAILED',
          payload: {
            toolName: 'strict_echo',
            callId: 'call-invalid-session',
          },
        })
      }

      expect(executeCalls).toBe(0)
    })
  })

  it('creates inventory entries with model-safe definitions and hidden implementation payloads', () => {
    const entry = createToolInventoryEntry(echoTool, { runtime: 'local' })
    expect(entry.definition).toMatchObject({ name: 'echo', description: 'Echo input' })
    expect(entry.definition.parameters).toMatchObject({ required: ['message'] })
    expect((entry.definition.parameters as { safeParse?: unknown }).safeParse).toBeUndefined()
    expect('implementation' in entry.definition).toBe(false)
    expect(entry.implementation).toBeDefined()
    expect(entry.capabilities).toMatchObject({ session: true, worker: true, elicits: false, samples: false })

    expect(() => createToolInventory([entry, entry])).toThrow('Duplicate tool name')
  })

  it('installer sets ToolRuntimeContext for ToolRuntimeApi', async () => {
    await run(function* () {
      yield* installLocalToolRuntime({
        tools: [echoTool],
        samplingProvider: { *sample() { return { text: 'unused' } } },
      })

      const tools = yield* ToolRuntimeApi.listTools()
      expect(tools.map((tool) => tool.name)).toEqual(['echo'])
    })
  })
})
