import { run } from 'effection'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createTool } from '@sweatpants/core'
import {
  createIsomorphicToolInventoryEntry,
  createLocalToolRuntimeDriver,
  createToolInventoryEntry,
} from '../src/index.ts'

let mcpExecuteCalls = 0

const strictTool = createTool('strict_echo')
  .description('Strict echo')
  .parameters(z.object({ message: z.string() }))
  
  .execute(function* (params) {
    mcpExecuteCalls += 1
    return { echoed: params.message }
  })

describe('@sweatpants/tool-runtime-local strict parameter acceptance', () => {
  it('rejects invalid session params before local session or tool execution and executes valid params', async () => {
    await run(function* () {
      mcpExecuteCalls = 0
      const driver = yield* createLocalToolRuntimeDriver({
        tools: [strictTool],
        samplingProvider: { *sample() { return { text: 'unused' } } },
      })

      try {
        yield* driver.startToolCall({
          toolName: 'strict_echo',
          callId: 'call-invalid-mcp',
          arguments: {},
        })
        throw new Error('expected validation failure')
      } catch (error) {
        expect(error).toMatchObject({
          code: 'TOOL_PARAMETER_VALIDATION_FAILED',
          payload: { toolName: 'strict_echo', callId: 'call-invalid-mcp' },
        })
      }
      expect(mcpExecuteCalls).toBe(0)

      const session = yield* driver.startToolCall({
        toolName: 'strict_echo',
        callId: 'call-valid-mcp',
        arguments: { message: 'hello' },
      })
      const events = yield* session.events()
      const next = yield* events.next()
      expect(next.done).toBe(false)
      if (!next.done) {
        expect(next.value).toMatchObject({ type: 'result', result: { echoed: 'hello' } })
      }
      expect(mcpExecuteCalls).toBe(1)
    })
  })

  it('rejects invalid inline isomorphic params before server callback execution', async () => {
    await run(function* () {
      let serverCalls = 0
      const inlineTool = {
        name: 'strict_inline',
        description: 'Strict inline',
        parameters: z.object({ message: z.string() }),
        server: function* (params: unknown) {
          serverCalls += 1
          return { echoed: (params as { message: string }).message }
        },
      }
      const driver = yield* createLocalToolRuntimeDriver({ isomorphicTools: [inlineTool] })

      try {
        yield* driver.execute({
          entry: createIsomorphicToolInventoryEntry(inlineTool),
          call: { id: 'call-invalid-inline', type: 'function', function: { name: 'strict_inline', arguments: {} } },
        })
        throw new Error('expected validation failure')
      } catch (error) {
        expect(error).toMatchObject({
          code: 'TOOL_PARAMETER_VALIDATION_FAILED',
          payload: { toolName: 'strict_inline', callId: 'call-invalid-inline' },
        })
      }
      expect(serverCalls).toBe(0)

      const result = yield* driver.execute({
        entry: createIsomorphicToolInventoryEntry(inlineTool),
        call: { id: 'call-valid-inline', type: 'function', function: { name: 'strict_inline', arguments: { message: 'hi' } } },
      })
      expect(result).toMatchObject({ kind: 'completed', result: { echoed: 'hi' } })
      expect(serverCalls).toBe(1)
    })
  })

  it('projects inventory schemas without leaking runtime schema objects', () => {
    const entry = createToolInventoryEntry(strictTool)
    expect(entry.definition.parameters).toMatchObject({ required: ['message'] })
    expect((entry.definition.parameters as { safeParse?: unknown }).safeParse).toBeUndefined()
    expect(() => structuredClone(entry.definition)).not.toThrow()
  })
})
