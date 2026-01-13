/**
 * Tool Session Tests
 *
 * Tests for durable tool execution sessions.
 */
import { describe, it, expect } from 'vitest'
import { run, spawn, each, sleep } from 'effection'
import { z } from 'zod'
import { createMcpTool } from '../../mcp-tool-builder.ts'
import { createToolSession } from '../tool-session.ts'
import { createInMemoryToolSessionStore } from '../in-memory-store.ts'
import { createToolSessionRegistry } from '../session-registry.ts'
import { setupToolSessions, useToolSessionRegistry } from '../setup.ts'
import type {
  ToolSessionSamplingProvider,
  ToolSessionEvent,
  SampleResult,
} from '../types.ts'

// =============================================================================
// TEST HELPERS
// =============================================================================

/**
 * Create a mock sampling provider for testing.
 */
function createMockSamplingProvider(
  responses: string[] = []
): ToolSessionSamplingProvider & { calls: Array<{ messages: unknown[] }> } {
  let callIndex = 0
  const calls: Array<{ messages: unknown[] }> = []

  return {
    calls,
    *sample(messages, _options) {
      calls.push({ messages })
      const text = responses[callIndex++] ?? `Response ${callIndex}`
      return { text } as SampleResult
    },
  }
}

// =============================================================================
// TESTS
// =============================================================================

describe('Tool Session', () => {
  describe('createToolSession', () => {
    it('should run a simple tool and emit result event', async () => {
      const tool = createMcpTool('simple_tool')
        .description('Simple tool')
        .parameters(z.object({ input: z.string() }))
        .elicits({})
        .execute(function* (params, _ctx) {
          return { result: `Processed: ${params.input}` }
        })

      const samplingProvider = createMockSamplingProvider()
      const events: ToolSessionEvent<{ result: string }>[] = []

      const result = await run(function* () {
        const session = yield* createToolSession(tool, { input: 'test' }, samplingProvider)

        expect(session.id).toMatch(/^session_/)
        expect(session.toolName).toBe('simple_tool')

        // Collect events
        yield* spawn(function* () {
          for (const event of yield* each(session.events())) {
            events.push(event)
            yield* each.next()
          }
        })

        // Wait for completion
        yield* sleep(50)

        return yield* session.status()
      })

      expect(result).toBe('completed')
      expect(events.length).toBeGreaterThan(0)

      const resultEvent = events.find(e => e.type === 'result')
      expect(resultEvent).toBeDefined()
      if (resultEvent?.type === 'result') {
        expect(resultEvent.result).toEqual({ result: 'Processed: test' })
      }
    })

    it('should emit progress events from ctx.notify()', async () => {
      const tool = createMcpTool('progress_tool')
        .description('Tool with progress')
        .parameters(z.object({}))
        .elicits({})
        .execute(function* (_params, ctx) {
          yield* ctx.notify('Starting...')
          yield* ctx.notify('50% done', 0.5)
          yield* ctx.notify('Almost there...', 0.9)
          return { done: true }
        })

      const samplingProvider = createMockSamplingProvider()
      const events: ToolSessionEvent<{ done: boolean }>[] = []

      await run(function* () {
        const session = yield* createToolSession(tool, {}, samplingProvider)

        yield* spawn(function* () {
          for (const event of yield* each(session.events())) {
            events.push(event)
            yield* each.next()
          }
        })

        yield* sleep(50)
      })

      const progressEvents = events.filter(e => e.type === 'progress')
      expect(progressEvents.length).toBe(3)

      expect(progressEvents[0]).toMatchObject({ type: 'progress', message: 'Starting...' })
      expect(progressEvents[1]).toMatchObject({ type: 'progress', message: '50% done', progress: 0.5 })
      expect(progressEvents[2]).toMatchObject({ type: 'progress', message: 'Almost there...', progress: 0.9 })
    })

    it('should emit log events from ctx.log()', async () => {
      const tool = createMcpTool('log_tool')
        .description('Tool with logging')
        .parameters(z.object({}))
        .elicits({})
        .execute(function* (_params, ctx) {
          yield* ctx.log('info', 'Info message')
          yield* ctx.log('warning', 'Warning message')
          return { logged: true }
        })

      const samplingProvider = createMockSamplingProvider()
      const events: ToolSessionEvent<{ logged: boolean }>[] = []

      await run(function* () {
        const session = yield* createToolSession(tool, {}, samplingProvider)

        yield* spawn(function* () {
          for (const event of yield* each(session.events())) {
            events.push(event)
            yield* each.next()
          }
        })

        yield* sleep(50)
      })

      const logEvents = events.filter(e => e.type === 'log')
      expect(logEvents.length).toBe(2)

      expect(logEvents[0]).toMatchObject({ type: 'log', level: 'info', message: 'Info message' })
      expect(logEvents[1]).toMatchObject({ type: 'log', level: 'warning', message: 'Warning message' })
    })

    it('should emit error event when tool throws', async () => {
      const tool = createMcpTool('error_tool')
        .description('Tool that throws')
        .parameters(z.object({}))
        .elicits({})
        .execute(function* () {
          throw new Error('Test error')
        })

      const samplingProvider = createMockSamplingProvider()
      const events: ToolSessionEvent<never>[] = []

      const status = await run(function* () {
        const session = yield* createToolSession(tool, {}, samplingProvider)

        yield* spawn(function* () {
          for (const event of yield* each(session.events())) {
            events.push(event)
            yield* each.next()
          }
        })

        yield* sleep(50)
        return yield* session.status()
      })

      expect(status).toBe('failed')

      const errorEvent = events.find(e => e.type === 'error')
      expect(errorEvent).toBeDefined()
      if (errorEvent?.type === 'error') {
        expect(errorEvent.message).toBe('Test error')
      }
    })

    it('should support event resumability via LSN', async () => {
      const tool = createMcpTool('resume_tool')
        .description('Tool for resumability test')
        .parameters(z.object({}))
        .elicits({})
        .execute(function* (_params, ctx) {
          yield* ctx.notify('Event 1')
          yield* ctx.notify('Event 2')
          yield* ctx.notify('Event 3')
          return { done: true }
        })

      const samplingProvider = createMockSamplingProvider()
      const allEvents: ToolSessionEvent<{ done: boolean }>[] = []
      const resumedEvents: ToolSessionEvent<{ done: boolean }>[] = []

      await run(function* () {
        const session = yield* createToolSession(tool, {}, samplingProvider)

        // First subscriber - gets all events
        yield* spawn(function* () {
          for (const event of yield* each(session.events())) {
            allEvents.push(event)
            yield* each.next()
          }
        })

        // Wait for some events
        yield* sleep(30)

        // Second subscriber with afterLSN - should only get events after LSN 2
        const startLSN = 2
        yield* spawn(function* () {
          for (const event of yield* each(session.events(startLSN))) {
            resumedEvents.push(event)
            yield* each.next()
          }
        })

        yield* sleep(50)
      })

      // First subscriber should have all events
      expect(allEvents.length).toBeGreaterThanOrEqual(4) // 3 progress + 1 result

      // Resumed subscriber should have fewer events (only those after LSN 2)
      const resumedLSNs = resumedEvents.map(e => e.lsn)

      // All resumed events should have LSN > 2
      for (const lsn of resumedLSNs) {
        expect(lsn).toBeGreaterThan(2)
      }
    })
  })

  describe('In-Memory Store', () => {
    it('should store and retrieve sessions', async () => {
      await run(function* () {
        const store = createInMemoryToolSessionStore()

        // Initially empty
        const notFound = yield* store.get('nonexistent')
        expect(notFound).toBeNull()

        // Create a mock session entry
        const mockSession = {
          id: 'test-session',
          toolName: 'test',
          status: function* () {
            return 'running' as const
          },
          events: () => ({
            *[Symbol.iterator]() {
              return { next: function* () { return { done: true, value: undefined } } }
            },
          }),
          respondToElicit: function* () {},
          respondToSample: function* () {},
          cancel: function* () {},
        }

        yield* store.set('test-session', {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          session: mockSession as any,
          refCount: 1,
          createdAt: Date.now(),
          status: 'running',
        })

        const entry = yield* store.get('test-session')
        expect(entry).toBeDefined()
        expect(entry?.refCount).toBe(1)
        expect(entry?.status).toBe('running')

        // Update refcount
        const newRefCount = yield* store.updateRefCount('test-session', 1)
        expect(newRefCount).toBe(2)

        // Update status
        yield* store.updateStatus('test-session', 'completed')
        const updated = yield* store.get('test-session')
        expect(updated?.status).toBe('completed')

        // Delete
        yield* store.delete('test-session')
        const deleted = yield* store.get('test-session')
        expect(deleted).toBeNull()
      })
    })
  })

  describe('Tool Session Registry', () => {
    it('should create and manage sessions', async () => {
      const tool = createMcpTool('registry_test')
        .description('Test tool')
        .parameters(z.object({ value: z.number() }))
        .elicits({})
        .execute(function* (params) {
          return { doubled: params.value * 2 }
        })

      const samplingProvider = createMockSamplingProvider()

      await run(function* () {
        const store = createInMemoryToolSessionStore()
        const registry = yield* createToolSessionRegistry(store, { samplingProvider })

        // Create session
        const session = yield* registry.create(tool, { value: 21 })
        expect(session.id).toBeDefined()
        expect(session.toolName).toBe('registry_test')

        // Acquire same session
        const acquired = yield* registry.acquire(session.id)
        expect(acquired.id).toBe(session.id)

        // Release
        yield* registry.release(session.id)

        // Second release should trigger cleanup eventually
        yield* registry.release(session.id)
      })
    })

    it('should throw when acquiring non-existent session', async () => {
      const samplingProvider = createMockSamplingProvider()

      await run(function* () {
        const store = createInMemoryToolSessionStore()
        const registry = yield* createToolSessionRegistry(store, { samplingProvider })

        try {
          yield* registry.acquire('nonexistent')
          expect.fail('Should have thrown')
        } catch (err) {
          expect((err as Error).message).toContain('Session not found')
        }
      })
    })
  })

  describe('setupToolSessions', () => {
    it('should configure contexts for dependency injection', async () => {
      const samplingProvider = createMockSamplingProvider()

      const tool = createMcpTool('context_test')
        .description('Test tool')
        .parameters(z.object({}))
        .elicits({})
        .execute(function* () {
          return { success: true }
        })

      await run(function* () {
        const store = createInMemoryToolSessionStore()

        // Setup contexts
        const registry = yield* setupToolSessions({
          store,
          samplingProvider,
        })

        // Use via context accessor
        const registryFromContext = yield* useToolSessionRegistry()
        expect(registryFromContext).toBe(registry)

        // Create session via registry
        const session = yield* registry.create(tool, {})
        expect(session.toolName).toBe('context_test')
      })
    })
  })
})
