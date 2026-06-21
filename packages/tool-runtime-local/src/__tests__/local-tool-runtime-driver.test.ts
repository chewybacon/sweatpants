import { describe, expect, it } from 'vitest'
import { run } from 'effection'
import { z } from 'zod'
import { createMcpTool } from '@sweatpants/framework/chat/mcp-tools'
import { ToolRuntimeApi } from '@sweatpants/framework/chat'
import { createLocalToolRuntimeDriver, installLocalToolRuntime } from '../index.ts'

const echoTool = createMcpTool('echo')
  .description('Echo input')
  .parameters(z.object({ message: z.string() }))
  .elicits({})
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
