import { describe, expect, it } from 'vitest'
import { run } from 'effection'
import { z } from 'zod'
import { createTool } from '@sweatpants/core'
import { ToolRuntimeApi, createToolInventory } from '@sweatpants/framework/chat'
import {
  createIsomorphicToolInventoryEntry,
  createLocalInlineToolExecutionStrategy,
  createLocalSessionToolExecutionStrategy,
  createInMemoryToolSessionStore,
  createLocalToolRuntimeDriver,
  createMcpToolInventoryEntry,
  createToolSessionRegistry,
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

  it('rejects invalid MCP params before creating a local session', async () => {
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

  it('rejects invalid inline params before server execution', async () => {
    await run(function* () {
      let serverCalls = 0
      const inlineTool = {
        name: 'strict_inline',
        description: 'Strict inline echo',
        parameters: z.object({ message: z.string() }),
        server: function* (params: unknown) {
          serverCalls++
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
          payload: {
            toolName: 'strict_inline',
            callId: 'call-invalid-inline',
          },
        })
      }

      expect(serverCalls).toBe(0)
    })
  })

  it('creates inventory entries with model-safe definitions and hidden implementation payloads', () => {
    const mcpEntry = createMcpToolInventoryEntry(echoTool, { runtime: 'local' })
    expect(mcpEntry.definition).toMatchObject({ name: 'echo', description: 'Echo input' })
    expect(mcpEntry.definition.parameters).toMatchObject({ required: ['message'] })
    expect((mcpEntry.definition.parameters as { safeParse?: unknown }).safeParse).toBeUndefined()
    expect('implementation' in mcpEntry.definition).toBe(false)
    expect(mcpEntry.implementation).toBeDefined()
    expect(mcpEntry.capabilities).toMatchObject({ session: true, worker: true, elicits: true, samples: true })

    const clientOnly = {
      name: 'pick_color',
      description: 'Pick color',
      parameters: { type: 'object', properties: {}, required: [] },
      client: function* () { return 'blue' },
    }
    const clientEntry = createIsomorphicToolInventoryEntry(clientOnly)
    expect(clientEntry.implementation).toBeDefined()
    expect(clientEntry.capabilities).toMatchObject({ client: true, inline: false })
    expect(() => createToolInventory([mcpEntry, mcpEntry])).toThrow('Duplicate tool name')
  })

  it('executes inline, client handoff, and missing-session resume paths through normalized runtime API', async () => {
    await run(function* () {
      const inlineTool = {
        name: 'inline_echo',
        description: 'Inline echo',
        parameters: z.object({ message: z.string() }),
        server: function* (params: unknown) { return { echoed: (params as { message: string }).message } },
      }
      const clientTool = {
        name: 'client_pick',
        description: 'Client pick',
        parameters: z.object({}),
        client: function* () { return 'picked' },
      }
      const driver = yield* createLocalToolRuntimeDriver({ isomorphicTools: [inlineTool, clientTool] })

      const inline = yield* driver.execute({
        entry: createIsomorphicToolInventoryEntry(inlineTool),
        call: { id: 'call-inline', type: 'function', function: { name: 'inline_echo', arguments: { message: 'hi' } } },
      })
      expect(inline).toMatchObject({ kind: 'completed', result: { echoed: 'hi' } })
      expect(inline.ref.sessionId).toBeUndefined()

      const handoff = yield* driver.execute({
        entry: createIsomorphicToolInventoryEntry(clientTool),
        call: { id: 'call-client', type: 'function', function: { name: 'client_pick', arguments: {} } },
      })
      expect(handoff.kind).toBe('awaiting_client')
      expect(handoff.ref.sessionId).toBeUndefined()

      try {
        yield* driver.resume({
          ref: { runtimeId: 'local', executionId: 'missing', callId: 'call-missing', toolName: 'echo', sessionId: 'missing' },
          input: { type: 'elicit_response', elicitId: 'elicit', result: { action: 'accept' } },
        })
        throw new Error('expected missing session')
      } catch (error) {
        expect(error).toMatchObject({ code: 'EXECUTION_NOT_FOUND' })
      }
    })
  })

  it('exports executable strategy objects for inline and session modes', async () => {
    await run(function* () {
      const inlineTool = {
        name: 'inline_strategy_echo',
        description: 'Inline strategy echo',
        parameters: z.object({ message: z.string() }),
        server: function* (params: unknown) { return { echoed: (params as { message: string }).message } },
      }
      const inline = createLocalInlineToolExecutionStrategy()
      const inlineEntry = createIsomorphicToolInventoryEntry(inlineTool)
      expect(inline.canExecute(inlineEntry, { id: 'call-inline', type: 'function', function: { name: inlineTool.name, arguments: { message: 'hi' } } }, { runtimeId: 'local' })).toBe(true)
      const inlineResult = yield* inline.execute(inlineEntry, { id: 'call-inline', type: 'function', function: { name: inlineTool.name, arguments: { message: 'hi' } } }, { runtimeId: 'local' })
      expect(inlineResult).toMatchObject({ kind: 'completed', result: { echoed: 'hi' } })

      const registry = yield* createToolSessionRegistry(createInMemoryToolSessionStore(), { samplingProvider: { *sample() { return { text: 'unused' } } } })
      const session = createLocalSessionToolExecutionStrategy({ registry, samplingProvider: { *sample() { return { text: 'unused' } } }, tools: [echoTool] })
      const sessionEntry = createMcpToolInventoryEntry(echoTool)
      const sessionResult = yield* session.execute(sessionEntry, { id: 'call-session', type: 'function', function: { name: 'echo', arguments: { message: 'hello' } } }, { runtimeId: 'local' })
      expect(sessionResult).toMatchObject({ kind: 'completed', result: { echoed: 'hello' } })
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
