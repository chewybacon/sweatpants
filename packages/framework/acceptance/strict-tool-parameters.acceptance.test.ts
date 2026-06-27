import { spawn } from 'effection'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createDurableChatHandler } from '../src/handler/durable/handler.ts'
import {
  createChatRequest,
  createMockProvider,
  consumeDurableResponse,
  getEventsByType,
  setupMockModelProvider,
} from '../src/handler/durable/__tests__/test-utils.ts'
import { setupInMemoryDurableStreams } from '../src/lib/chat/durable-streams/index.ts'
import {
  ToolInventoryContext,
  ToolRegistryContext,
  ToolRuntimeContext,
  createToolExecutionRef,
  createToolInventory,
  validateToolParameters,
  type ToolRuntime,
} from '../src/lib/chat/index.ts'
import { createBridgeHost, createMcpTool } from '../src/lib/chat/mcp-tools/index.ts'

let executeCalls = 0
let bridgeStarts = 0

const bookFlightTool = createMcpTool('book_flight')
  .description('Book a flight')
  .parameters(z.object({
    from: z.string(),
    destination: z.string(),
  }))
  .elicits({
    pickFlight: {
      response: z.object({ flightId: z.string() }),
      context: z.object({ flights: z.array(z.object({ id: z.string() })) }),
    },
  })
  .execute(function* (params, ctx) {
    executeCalls += 1
    yield* ctx.elicit('pickFlight', {
      message: `Pick a flight from ${params.from} to ${params.destination}`,
      flights: [{ id: 'FL001' }],
    })
    return { ok: true }
  })

function createAcceptanceRuntime(): ToolRuntime {
  return {
    id: 'framework-acceptance',
    *execute(request) {
      const call = request.call
      const ref = createToolExecutionRef({
        runtimeId: 'framework-acceptance',
        callId: call.id,
        toolName: call.function.name,
      })

      const params = validateToolParameters({
        schema: bookFlightTool.parameters,
        params: call.function.arguments,
        toolName: bookFlightTool.name,
        callId: call.id,
      })

      bridgeStarts += 1
      const host = createBridgeHost({
        tool: bookFlightTool,
        params,
        callId: call.id,
        ...(request.signal ? { signal: request.signal } : {}),
      })

      yield* spawn(function* () {
        yield* host.run()
      })

      const events = yield* host.events
      const next = yield* events.next()
      if (next.done) {
        return { kind: 'failed', ref, error: { code: 'SESSION_ENDED', message: 'Tool session ended' } }
      }
      if (next.value.type === 'elicit') {
        return {
          kind: 'awaiting_elicit',
          ref,
          request: {
            elicitId: next.value.request.id,
            key: next.value.request.key,
            message: next.value.request.message,
            schema: next.value.request.schema.json,
          },
        }
      }
      return { kind: 'failed', ref, error: { code: 'UNEXPECTED_EVENT', message: next.value.type } }
    },
    *resume(request) {
      return {
        kind: 'failed',
        ref: request.ref,
        error: { code: 'EXECUTION_NOT_FOUND', message: 'No resumable acceptance session' },
      }
    },
    *abort() {},
  }
}

function setupAcceptance(provider: ReturnType<typeof createMockProvider>) {
  return function* setup() {
    executeCalls = 0
    bridgeStarts = 0
    yield* setupInMemoryDurableStreams<string>()
    yield* setupMockModelProvider(provider)
    yield* ToolRegistryContext.set([])
    yield* ToolInventoryContext.set(createToolInventory([{
      definition: {
        name: bookFlightTool.name,
        description: bookFlightTool.description,
        parameters: z.toJSONSchema(bookFlightTool.parameters) as Record<string, unknown>,
      },
      implementation: bookFlightTool,
      capabilities: { session: true, elicits: true, samples: true },
    }]))
    yield* ToolRuntimeContext.set(createAcceptanceRuntime())
  }
}

async function postAndCollect(handler: (req: Request) => Promise<Response>) {
  const { request } = createChatRequest([
    { id: 'user-1', role: 'user', content: 'I want to fly to NYC' },
  ], { enabledTools: true })
  return consumeDurableResponse(await handler(request))
}

describe('@sweatpants/framework strict tool parameter acceptance', () => {
  it('rejects invalid model tool args before bridge startup, execution, or elicitation', async () => {
    let providerCalls = 0
    const provider = createMockProvider({
      customStream: (messages, options) => {
        const idx = providerCalls++
        if (idx === 0) {
          return createMockProvider({
            responses: 'Calling tool',
            toolCalls: [{ id: 'call_missing_from', name: 'book_flight', arguments: { destination: 'NYC' } }],
          }).stream(messages, options)
        }
        return createMockProvider({ responses: 'Where are you flying from?' }).stream(messages, options)
      },
    })
    const handler = createDurableChatHandler({
      setup: setupAcceptance(provider),
      maxToolIterations: 2,
    })

    const result = await postAndCollect(handler)
    const errors = getEventsByType(result, 'ag_ui_tool_call_error') as Array<{
      toolCallId: string
      toolCallName: string
      error?: { code?: string; issues?: Array<{ path: Array<string | number> }> }
    }>

    expect(executeCalls).toBe(0)
    expect(bridgeStarts).toBe(0)
    expect(getEventsByType(result, 'elicit_request')).toHaveLength(0)
    expect(result.toolResults).toBeNull()
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({
      toolCallId: 'call_missing_from',
      toolCallName: 'book_flight',
    })
    expect(errors[0]?.error?.code).toBe('TOOL_PARAMETER_VALIDATION_FAILED')
    expect(errors[0]?.error?.issues?.some((issue) => issue.path.includes('from'))).toBe(true)
  })

  it('allows valid model tool args to reach the first authored elicitation boundary', async () => {
    const provider = createMockProvider({
      responses: 'Calling tool',
      toolCalls: [{
        id: 'call_valid_route',
        name: 'book_flight',
        arguments: { from: 'Boston', destination: 'NYC' },
      }],
    })
    const handler = createDurableChatHandler({
      setup: setupAcceptance(provider),
      maxToolIterations: 1,
    })

    const result = await postAndCollect(handler)
    const elicits = getEventsByType(result, 'elicit_request')

    expect(bridgeStarts).toBe(1)
    expect(executeCalls).toBe(1)
    expect(elicits).toHaveLength(1)
    expect(elicits[0]).toMatchObject({
      callId: 'call_valid_route',
      toolName: 'book_flight',
      key: 'pickFlight',
    })
  })
})
