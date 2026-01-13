/**
 * Tests for Plugin Executor
 */
import { describe, it, expect } from 'vitest'
import { run, createChannel } from 'effection'
import { z } from 'zod'
import {
  createPluginClientContext,
  executePluginElicitHandler,
  executePluginElicitHandlerFromRequest,
} from '../plugin-executor.ts'
import type { PluginClientRegistration } from '../plugin.ts'
import type { ElicitRequest, ElicitId } from '../mcp-tool-types.ts'
import type { PendingEmission, ComponentEmissionPayload } from '../../isomorphic-tools/runtime/emissions.ts'

// Helper to create a valid ElicitRequest
function createElicitRequest<K extends string>(
  key: K,
  message: string,
  callId: string = 'call-123',
  schema?: z.ZodType
): ElicitRequest<K, z.ZodType> {
  return {
    id: { toolName: 'test_tool', key, callId, seq: 1 } as ElicitId,
    key,
    toolName: 'test_tool',
    callId,
    seq: 1,
    message,
    schema: {
      zod: schema ?? z.object({}),
      json: {},
    },
  }
}

describe('createPluginClientContext', () => {
  it('creates a context with required fields', async () => {
    await run(function* () {
      const channel = createChannel<PendingEmission<ComponentEmissionPayload, unknown>, void>()
      yield* channel

      const request = createElicitRequest('testKey', 'Test message')

      const ctx = createPluginClientContext({
        callId: 'call-123',
        toolName: 'test_tool',
        elicitRequest: request,
        emissionChannel: channel,
      })

      expect(ctx.callId).toBe('call-123')
      expect(ctx.elicitRequest.key).toBe('testKey')
      expect(ctx.elicitRequest.message).toBe('Test message')
      expect(ctx.signal).toBeDefined()
      expect(ctx.render).toBeDefined()
      expect(ctx.reportProgress).toBeDefined()
    })
  })

  it('throws if neither runtime nor emissionChannel provided', async () => {
    await run(function* () {
      const request = createElicitRequest('testKey', 'Test')

      expect(() => {
        createPluginClientContext({
          callId: 'call-123',
          toolName: 'test_tool',
          elicitRequest: request,
        })
      }).toThrow('Either runtime or emissionChannel must be provided')
    })
  })

  it('uses provided abort signal', async () => {
    await run(function* () {
      const channel = createChannel<PendingEmission<ComponentEmissionPayload, unknown>, void>()
      yield* channel

      const controller = new AbortController()
      const request = createElicitRequest('testKey', 'Test')

      const ctx = createPluginClientContext({
        callId: 'call-123',
        toolName: 'test_tool',
        elicitRequest: request,
        emissionChannel: channel,
        signal: controller.signal,
      })

      expect(ctx.signal).toBe(controller.signal)
    })
  })
})

describe('executePluginElicitHandler', () => {
  const testSchema = z.object({ choice: z.string() })

  const mockPlugin: PluginClientRegistration<{ testKey: typeof testSchema }> = {
    toolName: 'test_tool',
    handlers: {
      testKey: function* (req, _ctx) {
        // Handler that returns the message as the choice
        return { action: 'accept' as const, content: { choice: req.message } }
      },
    },
    schemas: {
      testKey: testSchema,
    },
  }

  it('executes handler and returns result', async () => {
    const result = await run(function* () {
      const channel = createChannel<PendingEmission<ComponentEmissionPayload, unknown>, void>()
      yield* channel

      const request = createElicitRequest('testKey', 'Hello', 'call-123', testSchema)

      const ctx = createPluginClientContext({
        callId: 'call-123',
        toolName: 'test_tool',
        elicitRequest: request,
        emissionChannel: channel,
      })

      return yield* executePluginElicitHandler(
        mockPlugin,
        'testKey',
        request as ElicitRequest<'testKey', typeof testSchema>,
        ctx as any
      )
    })

    expect(result.action).toBe('accept')
    if (result.action === 'accept') {
      expect(result.content).toEqual({ choice: 'Hello' })
    }
  })

  it('throws for unknown key', async () => {
    await expect(
      run(function* () {
        const channel = createChannel<PendingEmission<ComponentEmissionPayload, unknown>, void>()
        yield* channel

        const request = createElicitRequest('unknownKey', 'Test')

        const ctx = createPluginClientContext({
          callId: 'call-123',
          toolName: 'test_tool',
          elicitRequest: request,
          emissionChannel: channel,
        })

        // @ts-expect-error - Testing unknown key
        return yield* executePluginElicitHandler(mockPlugin, 'unknownKey', request, ctx as any)
      })
    ).rejects.toThrow(/no handler for elicitation key/)
  })
})

describe('executePluginElicitHandlerFromRequest', () => {
  const testSchema = z.object({ value: z.number() })

  const mockPlugin: PluginClientRegistration<{ pickNumber: typeof testSchema }> = {
    toolName: 'number_tool',
    handlers: {
      pickNumber: function* (_req, _ctx) {
        return { action: 'accept' as const, content: { value: 42 } }
      },
    },
    schemas: {
      pickNumber: testSchema,
    },
  }

  it('extracts key from request and executes handler', async () => {
    const result = await run(function* () {
      const channel = createChannel<PendingEmission<ComponentEmissionPayload, unknown>, void>()
      yield* channel

      const request = createElicitRequest('pickNumber', 'Pick a number', 'call-456', testSchema)

      const ctx = createPluginClientContext({
        callId: 'call-456',
        toolName: 'number_tool',
        elicitRequest: request,
        emissionChannel: channel,
      })

      return yield* executePluginElicitHandlerFromRequest(mockPlugin, request, ctx as any)
    })

    expect(result.action).toBe('accept')
    if (result.action === 'accept') {
      expect(result.content).toEqual({ value: 42 })
    }
  })
})
