/**
 * Unified Tool Execution Tests
 *
 * Tests that unified tools (created via createTool()) work correctly
 * through the chat-engine execution path.
 *
 * Key behaviors to test:
 * 1. Simple execute-only unified tools work like isomorphic tools
 * 2. Unified tools with elicitation work through plugin session manager
 * 3. Unified tools with sampling work through the provider
 */
import { describe, it, expect, beforeEach, afterEach } from './vitest-effection.ts'
import { run, main, spawn, call, type Operation } from 'effection'
import { z } from 'zod'
import { createTool } from '../../../lib/chat/tools/builder.ts'
import { toMcpTool, isUnifiedTool } from '../../../lib/chat/tools/adapters/mcp.ts'
import type { FinalizedTool, ElicitsMap } from '../../../lib/chat/tools/types.ts'
import { createChatEngine } from '../chat-engine.ts'
import { createMockProvider, createTestInitializerHooks } from './test-utils.ts'
import type { ToolRegistry, IsomorphicTool, ToolSchema, McpToolRegistry } from '../types.ts'
import type { StreamEvent } from '../../types.ts'
import { needsMcpRuntime } from '../../../lib/chat/tools/adapters/mcp.ts'

// Type alias for any finalized tool (to avoid complex generics in tests)
// Use 'any' for the elicits map since tools have different elicit configurations
type AnyTool = FinalizedTool<string, any, any, any, any, any>

// =============================================================================
// TEST FIXTURES
// =============================================================================

/**
 * Simple calculator tool using unified API.
 */
const calculatorTool = createTool('calculator')
  .description('Calculate a math expression')
  .parameters(z.object({ expr: z.string() }))
  .execute(function* (params) {
    // Simple eval for testing (don't do this in production!)
    const result = eval(params.expr)
    return { result }
  })

/**
 * Tool that uses sampling (LLM backchannel).
 */
const summarizerTool = createTool('summarize')
  .description('Summarize text using AI')
  .parameters(z.object({ text: z.string() }))
  .execute(function* (params, ctx) {
    const result = yield* ctx.sample({
      prompt: `Summarize this text in one sentence: ${params.text}`,
      maxTokens: 100,
    })
    return { summary: result.text }
  })

/**
 * Tool with elicitation (user backchannel).
 */
const pickCardTool = createTool('pick_card')
  .description('Pick a card from a hand')
  .parameters(z.object({ count: z.number() }))
  .elicit('pick', z.object({ cardIndex: z.number() }))
  .execute(function* (params, ctx) {
    // Generate some cards
    const cards = Array.from({ length: params.count }, (_, i) => `Card ${i + 1}`)

    // Ask user to pick
    const result = yield* ctx.elicit('pick', {
      message: 'Pick a card from your hand',
      cards,
    })

    if (result.action === 'accept') {
      return { picked: cards[result.content.cardIndex] ?? 'Invalid' }
    }

    return { picked: null, reason: result.action }
  })

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Collect all events from a chat engine stream.
 */
function* collectEngineEvents(engine: ReturnType<typeof createChatEngine>): Operation<StreamEvent[]> {
  const events: StreamEvent[] = []
  const subscription = yield* engine

  while (true) {
    const result = yield* subscription.next()
    if (result.done) break
    events.push(result.value)
  }

  return events
}

/**
 * Create a tool registry from unified tools.
 * This simulates what the handler does.
 */
function createUnifiedToolRegistry(tools: AnyTool[]): ToolRegistry {
  const map = new Map<string, IsomorphicTool>()

  for (const tool of tools) {
    // Convert unified tool to isomorphic format (current wrong approach)
    // This is what we're testing - it should work for simple tools
    if (tool.mode === 'execute' && tool.execute) {
      map.set(tool.name, {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        server: tool.execute as any,
      })
    }
  }

  return {
    get: (name) => map.get(name),
    has: (name) => map.has(name),
    names: () => Array.from(map.keys()),
  }
}

/**
 * Create tool schemas from unified tools.
 */
function createToolSchemas(tools: AnyTool[]): ToolSchema[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: z.toJSONSchema(tool.parameters) as Record<string, unknown>,
    isIsomorphic: true,
    authority: 'server',
  }))
}

/**
 * Create MCP tool registry from unified tools that need MCP runtime.
 * This mimics what the handler does with extractMcpUnifiedTools.
 */
function createMcpToolRegistryFromUnified(tools: AnyTool[]): McpToolRegistry | undefined {
  const mcpTools = new Map<string, unknown>()
  
  for (const tool of tools) {
    if (needsMcpRuntime(tool)) {
      const mcpTool = toMcpTool(tool)
      mcpTools.set(tool.name, mcpTool)
    }
  }
  
  if (mcpTools.size === 0) return undefined
  
  return {
    get: (name) => mcpTools.get(name),
    has: (name) => mcpTools.has(name),
    names: () => Array.from(mcpTools.keys()),
  }
}

// =============================================================================
// TESTS
// =============================================================================

describe('Unified Tool Execution', () => {
  describe('Type Guards', () => {
    it('should detect unified tools', function* () {
      expect(isUnifiedTool(calculatorTool)).toBe(true)
      expect(isUnifiedTool(summarizerTool)).toBe(true)
      expect(isUnifiedTool(pickCardTool)).toBe(true)
    })

    it('should not detect non-unified objects as unified tools', function* () {
      expect(isUnifiedTool({})).toBe(false)
      expect(isUnifiedTool({ name: 'test' })).toBe(false)
      expect(isUnifiedTool(null)).toBe(false)
      expect(isUnifiedTool(undefined)).toBe(false)
    })
  })

  describe('MCP Adapter', () => {
    it('should convert unified tool to MCP format', function* () {
      const mcpTool = toMcpTool(calculatorTool)

      expect(mcpTool.name).toBe('calculator')
      expect(mcpTool.description).toBe('Calculate a math expression')
      expect(mcpTool.execute).toBeDefined()
    })

    it('should convert elicits to MCP format', function* () {
      const mcpTool = toMcpTool(pickCardTool)

      expect(mcpTool.elicits).toBeDefined()
      expect(mcpTool.elicits['pick']).toBeDefined()
      expect(mcpTool.elicits['pick'].response).toBeDefined()
    })
  })

  describe('Simple Execute Tools', () => {
    it('should execute a simple unified tool via chat engine', function* () {
      // Setup mock provider that will call the tool
      const provider = createMockProvider({
        responses: ['Let me calculate that for you.'],
        toolCalls: [{
          id: 'call_1',
          name: 'calculator',
          arguments: { expr: '2 + 2' },
        }],
      })

      // Create tool registry from unified tools
      const tools = [calculatorTool] as AnyTool[]
      const toolRegistry = createUnifiedToolRegistry(tools)
      const toolSchemas = createToolSchemas(tools)

      // Create the engine
      const engine = createChatEngine({
        messages: [{ role: 'user', content: 'What is 2 + 2?' }],
        toolSchemas,
        toolRegistry,
        clientIsomorphicTools: [],
        isomorphicClientOutputs: [],
        provider,
        maxIterations: 3,
        signal: new AbortController().signal,
      })

      // Collect events
      const events = yield* collectEngineEvents(engine)

      // Find the tool result
      const toolResult = events.find((e) => e.type === 'tool_result')
      expect(toolResult).toBeDefined()
      expect(toolResult?.type).toBe('tool_result')

      if (toolResult?.type === 'tool_result') {
        expect(toolResult.name).toBe('calculator')
        // The result should be JSON with { result: 4 }
        const content = JSON.parse(toolResult.content)
        expect(content.result).toBe(4)
      }
    })

    it('should handle tool errors gracefully', function* () {
      const provider = createMockProvider({
        responses: ['Let me calculate that.'],
        toolCalls: [{
          id: 'call_1',
          name: 'calculator',
          arguments: { expr: 'invalid expression ++' },
        }],
      })

      const tools = [calculatorTool] as AnyTool[]
      const toolRegistry = createUnifiedToolRegistry(tools)
      const toolSchemas = createToolSchemas(tools)

      const engine = createChatEngine({
        messages: [{ role: 'user', content: 'Calculate something invalid' }],
        toolSchemas,
        toolRegistry,
        clientIsomorphicTools: [],
        isomorphicClientOutputs: [],
        provider,
        maxIterations: 3,
        signal: new AbortController().signal,
      })

      const events = yield* collectEngineEvents(engine)

      // Should have a tool_error event
      const toolError = events.find((e) => e.type === 'tool_error')
      expect(toolError).toBeDefined()
    })

    it('should execute multiple tool calls in sequence', function* () {
      let callIndex = 0
      const provider = createMockProvider({
        customStream: () => {
          callIndex++
          if (callIndex === 1) {
            // First call - emit tool calls
            return {
              *[Symbol.iterator]() {
                return {
                  *next() {
                    return {
                      done: true,
                      value: {
                        text: 'Calculating...',
                        toolCalls: [{
                          id: 'call_1',
                          type: 'function' as const,
                          function: {
                            name: 'calculator',
                            arguments: { expr: '1 + 1' },
                          },
                        }, {
                          id: 'call_2',
                          type: 'function' as const,
                          function: {
                            name: 'calculator',
                            arguments: { expr: '3 * 3' },
                          },
                        }],
                      },
                    }
                  },
                }
              },
            } as any
          }
          // Second call - emit final response
          return {
            *[Symbol.iterator]() {
              return {
                *next() {
                  return {
                    done: true,
                    value: { text: 'The results are 2 and 9.' },
                  }
                },
              }
            },
          } as any
        },
      })

      const tools = [calculatorTool] as AnyTool[]
      const toolRegistry = createUnifiedToolRegistry(tools)
      const toolSchemas = createToolSchemas(tools)

      const engine = createChatEngine({
        messages: [{ role: 'user', content: 'Calculate 1+1 and 3*3' }],
        toolSchemas,
        toolRegistry,
        clientIsomorphicTools: [],
        isomorphicClientOutputs: [],
        provider,
        maxIterations: 5,
        signal: new AbortController().signal,
      })

      const events = yield* collectEngineEvents(engine)

      // Should have two tool results
      const toolResults = events.filter((e) => e.type === 'tool_result')
      expect(toolResults.length).toBe(2)

      // Verify results
      const results = toolResults.map((e) => {
        if (e.type === 'tool_result') {
          return JSON.parse(e.content)
        }
        return null
      })

      expect(results).toContainEqual({ result: 2 })
      expect(results).toContainEqual({ result: 9 })
    })
  })

  describe('Tools with Sampling', () => {
    // Note: The summarizer tool doesn't have elicits, so needsMcpRuntime returns false.
    // This means it goes through the isomorphic path even with our changes.
    // Tools that ONLY use sampling (not elicitation) would need a different detection mechanism.
    // For now, we document that sampling-only tools without elicits won't work.

    it('should fail when sampling-only tool goes through isomorphic path', function* () {
      // The summarizer tool has no elicits, so it's treated as a simple tool
      // and goes through the isomorphic path which doesn't have ctx.sample()

      const provider = createMockProvider({
        responses: ['Summarizing...'],
        toolCalls: [{
          id: 'call_1',
          name: 'summarize',
          arguments: { text: 'Hello world' },
        }],
      })

      const tools = [summarizerTool] as AnyTool[]
      const toolRegistry = createUnifiedToolRegistry(tools)
      const toolSchemas = createToolSchemas(tools)

      const engine = createChatEngine({
        messages: [{ role: 'user', content: 'Summarize hello world' }],
        toolSchemas,
        toolRegistry,
        clientIsomorphicTools: [],
        isomorphicClientOutputs: [],
        provider,
        maxIterations: 3,
        signal: new AbortController().signal,
      })

      const events = yield* collectEngineEvents(engine)

      // Will fail because isomorphic path doesn't have ctx.sample()
      const toolError = events.find((e) => e.type === 'tool_error')
      expect(toolError).toBeDefined()

      if (toolError?.type === 'tool_error') {
        expect(toolError.message).toContain('is not iterable')
      }
    })

    it('should route sampling tool through MCP when it has elicits', function* () {
      // Tools with elicits are routed to MCP runtime, which provides ctx.sample()
      // Let's create a tool that uses both sampling and elicitation to verify

      const samplingWithElicitTool = createTool('sampling_with_elicit')
        .description('A tool that uses both sampling and elicitation')
        .parameters(z.object({ input: z.string() }))
        .elicit('confirm', z.object({ ok: z.boolean() }))
        .execute(function* (params, ctx) {
          // First sample to get AI suggestions
          const result = yield* ctx.sample({
            prompt: `Process this: ${params.input}`,
          })
          // Then elicit user confirmation
          const confirm = yield* ctx.elicit('confirm', {
            message: `Confirm processing: ${result.text}`,
          })
          return { confirmed: confirm.action === 'accept' }
        })

      const provider = createMockProvider({
        responses: ['Processing...'],
        toolCalls: [{
          id: 'call_1',
          name: 'sampling_with_elicit',
          arguments: { input: 'test' },
        }],
      })

      const tools = [samplingWithElicitTool] as AnyTool[]
      const toolRegistry = createUnifiedToolRegistry(tools)
      const toolSchemas = createToolSchemas(tools)
      const mcpToolRegistry = createMcpToolRegistryFromUnified(tools)

      const engine = createChatEngine({
        messages: [{ role: 'user', content: 'Process test' }],
        toolSchemas,
        toolRegistry,
        clientIsomorphicTools: [],
        isomorphicClientOutputs: [],
        provider,
        maxIterations: 3,
        signal: new AbortController().signal,
        mcpToolRegistry,
        // No pluginSessionManager - will get error about needing it
      })

      const events = yield* collectEngineEvents(engine)

      // Should detect as MCP tool and require session manager
      const toolError = events.find((e) => e.type === 'tool_error')
      expect(toolError).toBeDefined()

      if (toolError?.type === 'tool_error') {
        expect(toolError.message).toContain('PluginSessionManager')
      }
    })
  })

  describe('Tools with Elicitation', () => {
    it('should detect MCP tool and require session manager', function* () {
      // When we provide an mcpToolRegistry with the unified tool but no session manager,
      // the engine should detect it's an MCP tool and report that it needs the session manager

      const provider = createMockProvider({
        responses: ['Picking a card...'],
        toolCalls: [{
          id: 'call_1',
          name: 'pick_card',
          arguments: { count: 5 },
        }],
      })

      const tools = [pickCardTool] as AnyTool[]
      const toolRegistry = createUnifiedToolRegistry(tools)
      const toolSchemas = createToolSchemas(tools)
      const mcpToolRegistry = createMcpToolRegistryFromUnified(tools)

      const engine = createChatEngine({
        messages: [{ role: 'user', content: 'Pick a card' }],
        toolSchemas,
        toolRegistry,
        clientIsomorphicTools: [],
        isomorphicClientOutputs: [],
        provider,
        maxIterations: 3,
        signal: new AbortController().signal,
        mcpToolRegistry, // Provide MCP registry so engine detects it as MCP tool
        // No pluginSessionManager - should get error about needing it
      })

      const events = yield* collectEngineEvents(engine)

      // Should have a tool_error about needing PluginSessionManager
      const toolError = events.find((e) => e.type === 'tool_error')
      expect(toolError).toBeDefined()

      if (toolError?.type === 'tool_error') {
        expect(toolError.message).toContain('PluginSessionManager')
      }
    })

    it('should fall through to isomorphic path when no mcpToolRegistry', function* () {
      // This test documents the behavior when mcpToolRegistry is not provided:
      // The tool goes through the isomorphic path which doesn't have ctx.elicit()

      const provider = createMockProvider({
        responses: ['Picking a card...'],
        toolCalls: [{
          id: 'call_1',
          name: 'pick_card',
          arguments: { count: 5 },
        }],
      })

      const tools = [pickCardTool] as AnyTool[]
      const toolRegistry = createUnifiedToolRegistry(tools)
      const toolSchemas = createToolSchemas(tools)
      // No mcpToolRegistry - will use isomorphic path

      const engine = createChatEngine({
        messages: [{ role: 'user', content: 'Pick a card' }],
        toolSchemas,
        toolRegistry,
        clientIsomorphicTools: [],
        isomorphicClientOutputs: [],
        provider,
        maxIterations: 3,
        signal: new AbortController().signal,
      })

      const events = yield* collectEngineEvents(engine)

      // Should fail because isomorphic path doesn't have ctx.elicit()
      const toolError = events.find((e) => e.type === 'tool_error')
      expect(toolError).toBeDefined()

      if (toolError?.type === 'tool_error') {
        // The error is "is not iterable" because ctx.elicit() is undefined
        expect(toolError.message).toContain('is not iterable')
      }
    })
  })
})

describe('Unified Tool Integration (TARGET BEHAVIOR)', () => {
  // These tests describe the TARGET behavior after Phase 2 is complete.
  // They are currently expected to fail and will pass once the integration is done.

  describe('TODO: Proper MCP Runtime Integration', () => {
    it.skip('should route unified tools with sampling through MCP runtime', function* () {
      // After Phase 2:
      // - Chat engine detects unified tool with elicits or sampling needs
      // - Converts to MCP format via toMcpTool()
      // - Executes via PluginSessionManager
      // - ctx.sample() is provided by the session's sampling handler
    })

    it.skip('should route unified tools with elicitation through plugin session', function* () {
      // After Phase 2:
      // - Chat engine detects unified tool with elicits
      // - Creates plugin session via PluginSessionManager
      // - Emits elicit_request event
      // - Resumes when elicit response is provided
    })
  })
})
