/**
 * Plugin Session Integration Tests
 *
 * Tests the plugin session manager and its integration with the chat engine.
 * These tests verify:
 * 1. Plugin session creation and lifecycle
 * 2. Elicitation flow across request boundaries
 * 3. Multi-step elicitation (multiple elicits in sequence)
 * 4. Session abort handling
 * 5. Error handling for missing sessions
 */
import { describe, it, expect, beforeEach } from './vitest-effection.ts'
import { z } from 'zod'
import { sleep } from 'effection'
import { createMcpTool } from '../../../lib/chat/mcp-tools/mcp-tool-builder.ts'
import { createInMemoryToolSessionStore } from '../../../lib/chat/mcp-tools/session/in-memory-store.ts'
import { createToolSessionRegistry } from '../../../lib/chat/mcp-tools/session/session-registry.ts'
import { createPluginSessionManager } from '../plugin-session-manager.ts'
import type { PluginSessionManager, CreatePluginSessionConfig } from '../plugin-session-manager.ts'
import type { ToolSessionRegistry } from '../../../lib/chat/mcp-tools/session/types.ts'
import type { ChatProvider } from '../../../lib/chat/providers/types.ts'
import type { Stream } from 'effection'
import { resource } from 'effection'
import type { ChatEvent, ChatResult } from '../../../lib/chat/types.ts'

// =============================================================================
// TEST FIXTURES
// =============================================================================

/**
 * Create a simple MCP tool that elicits user input.
 */
const simpleElicitTool = createMcpTool('simple_elicit')
  .description('A tool that asks for user input')
  .parameters(z.object({ prompt: z.string() }))
  .elicits({
    getUserInput: {
      response: z.object({ value: z.string() }),
    },
  })
  .execute(function* (params, ctx) {
    const result = yield* ctx.elicit('getUserInput', {
      message: `Please provide input for: ${params.prompt}`,
    })

    if (result.action === 'accept') {
      return { success: true, userValue: result.content.value }
    }

    return { success: false, reason: result.action }
  })

/**
 * Create a tool that completes immediately without elicitation.
 */
const immediateCompleteTool = createMcpTool('immediate_complete')
  .description('A tool that completes immediately')
  .parameters(z.object({ input: z.string() }))
  .elicits({})
  .execute(function* (params, _ctx) {
    return { processed: params.input.toUpperCase() }
  })

/**
 * Create a mock chat provider for testing.
 */
function createMockChatProvider(): ChatProvider {
  return {
    name: 'mock-provider',
    capabilities: {
      thinking: false,
      toolCalling: true,
    },
    stream(_messages, _options): Stream<ChatEvent, ChatResult> {
      return resource(function* (provide) {
        yield* provide({
          *next() {
            // Return immediate completion
            return {
              done: true as const,
              value: {
                text: 'Mock response',
                usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
              },
            }
          },
        })
      })
    },
  }
}

/**
 * Helper to cast tool to the expected type for CreatePluginSessionConfig.
 * This is needed because the specific tool types are narrower than the generic config type.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function asPluginTool(tool: any): CreatePluginSessionConfig['tool'] {
  return tool
}

/**
 * Create a mock sampling provider for the registry.
 */
function createMockSamplingProvider() {
  return {
    *sample() {
      return { text: 'Mock sampling response' }
    },
  }
}

// =============================================================================
// TESTS
// =============================================================================

describe('PluginSessionManager', () => {
  let registry: ToolSessionRegistry
  let sessionManager: PluginSessionManager
  let provider: ChatProvider

  beforeEach(function* () {
    const store = createInMemoryToolSessionStore()
    registry = yield* createToolSessionRegistry(store, {
      samplingProvider: createMockSamplingProvider(),
    })
    sessionManager = yield* createPluginSessionManager({
      registry,
    })
    provider = createMockChatProvider()
  })

  describe('Session Creation', () => {
    it('should create a session for a plugin tool', function* () {
      const session = yield* sessionManager.create({
        tool: asPluginTool(simpleElicitTool),
        params: { prompt: 'test prompt' },
        callId: 'call_123',
        provider,
      })

      expect(session.id).toBe('call_123')
      expect(session.toolName).toBe('simple_elicit')
      expect(session.callId).toBe('call_123')

      // Tool starts in 'initializing' state until events are subscribed
      const status = yield* session.status()
      expect(['initializing', 'running', 'awaiting_elicit']).toContain(status)
    })

    it('should list active sessions', function* () {
      yield* sessionManager.create({
        tool: asPluginTool(simpleElicitTool),
        params: { prompt: 'test 1' },
        callId: 'call_1',
        provider,
      })

      yield* sessionManager.create({
        tool: asPluginTool(simpleElicitTool),
        params: { prompt: 'test 2' },
        callId: 'call_2',
        provider,
      })

      const activeSessions = yield* sessionManager.listActive()
      expect(activeSessions.length).toBe(2)
      expect(activeSessions.map(s => s.id).sort()).toEqual(['call_1', 'call_2'])
    })
  })

  describe('Session Lookup', () => {
    it('should get an existing session by ID', function* () {
      yield* sessionManager.create({
        tool: asPluginTool(simpleElicitTool),
        params: { prompt: 'test' },
        callId: 'call_abc',
        provider,
      })

      const session = yield* sessionManager.get('call_abc')
      expect(session).not.toBeNull()
      expect(session?.id).toBe('call_abc')
    })

    it('should return null for non-existent session', function* () {
      const session = yield* sessionManager.get('nonexistent')
      expect(session).toBeNull()
    })
  })

  describe('Session Abort', () => {
    it('should abort an existing session', function* () {
      const session = yield* sessionManager.create({
        tool: asPluginTool(simpleElicitTool),
        params: { prompt: 'test' },
        callId: 'call_abort',
        provider,
      })

      yield* sessionManager.abort('call_abort', 'User cancelled')

      const status = yield* session.status()
      expect(status).toBe('aborted')
    })

    it('should handle abort of non-existent session gracefully', function* () {
      // Should not throw
      yield* sessionManager.abort('nonexistent', 'test')
    })
  })
})

describe('Plugin Session Event Flow', () => {
  let registry: ToolSessionRegistry
  let sessionManager: PluginSessionManager
  let provider: ChatProvider

  beforeEach(function* () {
    const store = createInMemoryToolSessionStore()
    registry = yield* createToolSessionRegistry(store, {
      samplingProvider: createMockSamplingProvider(),
    })
    sessionManager = yield* createPluginSessionManager({
      registry,
    })
    provider = createMockChatProvider()
  })

  it('should emit elicit_request event when tool elicits', function* () {
    const session = yield* sessionManager.create({
      tool: asPluginTool(simpleElicitTool),
      params: { prompt: 'What is your name?' },
      callId: 'call_elicit',
      provider,
    })

    // Get the first event - should be an elicit request
    const event = yield* session.nextEvent()

    expect(event).not.toBeNull()
    expect(event?.type).toBe('elicit_request')
    if (event?.type === 'elicit_request') {
      expect(event.key).toBe('getUserInput')
      expect(event.message).toContain('What is your name?')
      expect(event.schema).toBeDefined()
    }
  })

  it('should complete tool after elicit response', function* () {
    const session = yield* sessionManager.create({
      tool: asPluginTool(simpleElicitTool),
      params: { prompt: 'Test prompt' },
      callId: 'call_complete',
      provider,
    })

    // Get elicit request
    const elicitEvent = yield* session.nextEvent()
    expect(elicitEvent?.type).toBe('elicit_request')

    if (elicitEvent?.type === 'elicit_request') {
      // Respond to elicitation
      yield* session.respondToElicit(elicitEvent.elicitId, {
        action: 'accept',
        content: { value: 'John Doe' },
      })

      // Get result
      const resultEvent = yield* session.nextEvent()
      expect(resultEvent?.type).toBe('result')
      if (resultEvent?.type === 'result') {
        expect(resultEvent.result).toEqual({
          success: true,
          userValue: 'John Doe',
        })
      }
    }
  })

  it('should handle declined elicitation', function* () {
    const session = yield* sessionManager.create({
      tool: asPluginTool(simpleElicitTool),
      params: { prompt: 'Test' },
      callId: 'call_decline',
      provider,
    })

    // Get elicit request
    const elicitEvent = yield* session.nextEvent()
    expect(elicitEvent?.type).toBe('elicit_request')

    if (elicitEvent?.type === 'elicit_request') {
      // Decline the elicitation
      yield* session.respondToElicit(elicitEvent.elicitId, {
        action: 'decline',
      })

      // Get result - should indicate declined
      const resultEvent = yield* session.nextEvent()
      expect(resultEvent?.type).toBe('result')
      if (resultEvent?.type === 'result') {
        expect(resultEvent.result).toEqual({
          success: false,
          reason: 'decline',
        })
      }
    }
  })
})

describe('Multi-Step Elicitation', () => {
  let registry: ToolSessionRegistry
  let sessionManager: PluginSessionManager
  let provider: ChatProvider

  beforeEach(function* () {
    const store = createInMemoryToolSessionStore()
    registry = yield* createToolSessionRegistry(store, {
      samplingProvider: createMockSamplingProvider(),
    })
    sessionManager = yield* createPluginSessionManager({
      registry,
    })
    provider = createMockChatProvider()
  })

  /**
   * Create a tool that requires TWO sequential elicitations.
   * This tests the core multi-step elicitation flow.
   */
  const multiStepTool = createMcpTool('multi_step_booking')
    .description('A tool that requires multiple elicitations')
    .parameters(z.object({ destination: z.string() }))
    .elicits({
      pickFlight: {
        response: z.object({ flightId: z.string() }),
      },
      pickSeat: {
        response: z.object({ seatId: z.string() }),
      },
    })
    .execute(function* (params, ctx) {
      // First elicitation: pick a flight
      const flightResult = yield* ctx.elicit('pickFlight', {
        message: `Select a flight to ${params.destination}`,
      })
      
      if (flightResult.action !== 'accept') {
        return { success: false, reason: 'flight_not_selected' }
      }
      
      // Second elicitation: pick a seat
      const seatResult = yield* ctx.elicit('pickSeat', {
        message: `Select a seat for flight ${flightResult.content.flightId}`,
      })
      
      if (seatResult.action !== 'accept') {
        return { success: false, reason: 'seat_not_selected' }
      }
      
      return {
        success: true,
        booking: {
          destination: params.destination,
          flightId: flightResult.content.flightId,
          seatId: seatResult.content.seatId,
        },
      }
    })

  it('should handle two sequential elicitations', function* () {
    const session = yield* sessionManager.create({
      tool: asPluginTool(multiStepTool),
      params: { destination: 'NYC' },
      callId: 'call_multi_step',
      provider,
    })

    // First elicitation: pickFlight
    const flightEvent = yield* session.nextEvent()
    expect(flightEvent).not.toBeNull()
    expect(flightEvent?.type).toBe('elicit_request')
    if (flightEvent?.type === 'elicit_request') {
      expect(flightEvent.key).toBe('pickFlight')
      expect(flightEvent.message).toContain('NYC')

      // Respond to first elicitation
      yield* session.respondToElicit(flightEvent.elicitId, {
        action: 'accept',
        content: { flightId: 'FL-123' },
      })
    }

    // Second elicitation: pickSeat
    const seatEvent = yield* session.nextEvent()
    expect(seatEvent).not.toBeNull()
    expect(seatEvent?.type).toBe('elicit_request')
    if (seatEvent?.type === 'elicit_request') {
      expect(seatEvent.key).toBe('pickSeat')
      expect(seatEvent.message).toContain('FL-123')

      // Respond to second elicitation
      yield* session.respondToElicit(seatEvent.elicitId, {
        action: 'accept',
        content: { seatId: '12A' },
      })
    }

    // Get final result
    const resultEvent = yield* session.nextEvent()
    expect(resultEvent).not.toBeNull()
    expect(resultEvent?.type).toBe('result')
    if (resultEvent?.type === 'result') {
      expect(resultEvent.result).toEqual({
        success: true,
        booking: {
          destination: 'NYC',
          flightId: 'FL-123',
          seatId: '12A',
        },
      })
    }
  })

  it('should handle decline on first elicitation', function* () {
    const session = yield* sessionManager.create({
      tool: asPluginTool(multiStepTool),
      params: { destination: 'LAX' },
      callId: 'call_decline_first',
      provider,
    })

    // First elicitation
    const flightEvent = yield* session.nextEvent()
    expect(flightEvent?.type).toBe('elicit_request')

    if (flightEvent?.type === 'elicit_request') {
      // Decline the first elicitation
      yield* session.respondToElicit(flightEvent.elicitId, {
        action: 'decline',
      })
    }

    // Should get result immediately (no second elicitation)
    const resultEvent = yield* session.nextEvent()
    expect(resultEvent?.type).toBe('result')
    if (resultEvent?.type === 'result') {
      expect(resultEvent.result).toEqual({
        success: false,
        reason: 'flight_not_selected',
      })
    }
  })

  it('should handle decline on second elicitation', function* () {
    const session = yield* sessionManager.create({
      tool: asPluginTool(multiStepTool),
      params: { destination: 'SFO' },
      callId: 'call_decline_second',
      provider,
    })

    // First elicitation - accept
    const flightEvent = yield* session.nextEvent()
    expect(flightEvent?.type).toBe('elicit_request')
    if (flightEvent?.type === 'elicit_request') {
      yield* session.respondToElicit(flightEvent.elicitId, {
        action: 'accept',
        content: { flightId: 'FL-456' },
      })
    }

    // Second elicitation - decline
    const seatEvent = yield* session.nextEvent()
    expect(seatEvent?.type).toBe('elicit_request')
    if (seatEvent?.type === 'elicit_request') {
      yield* session.respondToElicit(seatEvent.elicitId, {
        action: 'decline',
      })
    }

    // Should get result with second elicitation declined
    const resultEvent = yield* session.nextEvent()
    expect(resultEvent?.type).toBe('result')
    if (resultEvent?.type === 'result') {
      expect(resultEvent.result).toEqual({
        success: false,
        reason: 'seat_not_selected',
      })
    }
  })
})

describe('Immediate Completion Tools', () => {
  let registry: ToolSessionRegistry
  let sessionManager: PluginSessionManager
  let provider: ChatProvider

  beforeEach(function* () {
    const store = createInMemoryToolSessionStore()
    registry = yield* createToolSessionRegistry(store, {
      samplingProvider: createMockSamplingProvider(),
    })
    sessionManager = yield* createPluginSessionManager({
      registry,
    })
    provider = createMockChatProvider()
  })

  it('should complete immediately for tools without elicitation', function* () {
    const session = yield* sessionManager.create({
      tool: asPluginTool(immediateCompleteTool),
      params: { input: 'hello' },
      callId: 'call_immediate',
      provider,
    })

    // Should get result immediately
    const event = yield* session.nextEvent()
    expect(event?.type).toBe('result')
    if (event?.type === 'result') {
      expect(event.result).toEqual({ processed: 'HELLO' })
    }
  })
})

describe('Status Tracking and Cleanup', () => {
  let registry: ToolSessionRegistry
  let sessionManager: PluginSessionManager
  let provider: ChatProvider

  beforeEach(function* () {
    const store = createInMemoryToolSessionStore()
    registry = yield* createToolSessionRegistry(store, {
      samplingProvider: createMockSamplingProvider(),
    })
    sessionManager = yield* createPluginSessionManager({
      registry,
    })
    provider = createMockChatProvider()
  })

  it('should return correct status in listActive() during elicitation', function* () {
    const session = yield* sessionManager.create({
      tool: asPluginTool(simpleElicitTool),
      params: { prompt: 'test' },
      callId: 'call_status',
      provider,
    })

    // Get elicit request to move to awaiting state
    const event = yield* session.nextEvent()
    expect(event?.type).toBe('elicit_request')

    // Check status via listActive
    const activeSessions = yield* sessionManager.listActive()
    expect(activeSessions.length).toBe(1)
    expect(activeSessions[0]?.status).toBe('awaiting_elicit')
  })

  it('should show completed status in listActive() before consuming terminal event', function* () {
    const session = yield* sessionManager.create({
      tool: asPluginTool(immediateCompleteTool),
      params: { input: 'test' },
      callId: 'call_complete_status',
      provider,
    })

    // Check status via listActive BEFORE consuming the event
    // The tool has completed but the terminal event hasn't been consumed yet
    const activeSessions = yield* sessionManager.listActive()
    expect(activeSessions.length).toBe(1)
    expect(activeSessions[0]?.status).toBe('completed')

    // Consume result event - this triggers cleanup
    const event = yield* session.nextEvent()
    expect(event?.type).toBe('result')

    // After consuming terminal event, session is cleaned up
    const afterCleanup = yield* sessionManager.listActive()
    expect(afterCleanup.length).toBe(0)
  })

  it('should remove session from listActive() after completion', function* () {
    const session = yield* sessionManager.create({
      tool: asPluginTool(immediateCompleteTool),
      params: { input: 'test' },
      callId: 'call_cleanup',
      provider,
    })

    // Verify session is active
    let activeSessions = yield* sessionManager.listActive()
    expect(activeSessions.length).toBe(1)

    // Consume result event
    const event = yield* session.nextEvent()
    expect(event?.type).toBe('result')

    // Wait a bit for cleanup to happen
    yield* sleep(150)

    // Session should be cleaned up
    activeSessions = yield* sessionManager.listActive()
    expect(activeSessions.length).toBe(0)
  })

  it('should clean up session after elicitation completes', function* () {
    const session = yield* sessionManager.create({
      tool: asPluginTool(simpleElicitTool),
      params: { prompt: 'test' },
      callId: 'call_elicit_cleanup',
      provider,
    })

    // Get elicit request
    const elicitEvent = yield* session.nextEvent()
    expect(elicitEvent?.type).toBe('elicit_request')

    // Verify session is active
    let activeSessions = yield* sessionManager.listActive()
    expect(activeSessions.length).toBe(1)

    // Respond to elicit
    if (elicitEvent?.type === 'elicit_request') {
      yield* session.respondToElicit(elicitEvent.elicitId, {
        action: 'accept',
        content: { value: 'test response' },
      })
    }

    // Get result
    const resultEvent = yield* session.nextEvent()
    expect(resultEvent?.type).toBe('result')

    // Wait for cleanup
    yield* sleep(150)

    // Session should be cleaned up
    activeSessions = yield* sessionManager.listActive()
    expect(activeSessions.length).toBe(0)
  })

  it('should handle multiple sessions with independent cleanup', function* () {
    // Create first session (completes immediately)
    const session1 = yield* sessionManager.create({
      tool: asPluginTool(immediateCompleteTool),
      params: { input: 'test1' },
      callId: 'call_multi_1',
      provider,
    })

    // Create second session (needs elicitation)
    const session2 = yield* sessionManager.create({
      tool: asPluginTool(simpleElicitTool),
      params: { prompt: 'test2' },
      callId: 'call_multi_2',
      provider,
    })

    // Both should be active
    let activeSessions = yield* sessionManager.listActive()
    expect(activeSessions.length).toBe(2)

    // Complete first session
    const event1 = yield* session1.nextEvent()
    expect(event1?.type).toBe('result')

    // Wait for first session cleanup
    yield* sleep(150)

    // Only second session should remain
    activeSessions = yield* sessionManager.listActive()
    expect(activeSessions.length).toBe(1)
    expect(activeSessions[0]?.id).toBe('call_multi_2')
    expect(activeSessions[0]?.status).toBe('awaiting_elicit')

    // Complete second session
    const event2 = yield* session2.nextEvent()
    if (event2?.type === 'elicit_request') {
      yield* session2.respondToElicit(event2.elicitId, {
        action: 'accept',
        content: { value: 'response' },
      })
    }
    const result2 = yield* session2.nextEvent()
    expect(result2?.type).toBe('result')

    // Wait for second session cleanup
    yield* sleep(150)

    // All cleaned up
    activeSessions = yield* sessionManager.listActive()
    expect(activeSessions.length).toBe(0)
  })

  it('should be able to recover completed session via get() from registry', function* () {
    const session = yield* sessionManager.create({
      tool: asPluginTool(immediateCompleteTool),
      params: { input: 'test' },
      callId: 'call_get_cleanup',
      provider,
    })

    // Consume result - this triggers cleanup from pluginSessions map
    const event = yield* session.nextEvent()
    expect(event?.type).toBe('result')

    // Session is removed from pluginSessions map, but still exists in registry
    // get() can recover it (for reconnection scenarios or inspection)
    const retrieved = yield* sessionManager.get('call_get_cleanup', provider)
    expect(retrieved).not.toBeNull()
    expect(retrieved?.id).toBe('call_get_cleanup')
    
    // Should show completed status
    const status = yield* retrieved!.status()
    expect(status).toBe('completed')
  })
})
