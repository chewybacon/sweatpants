/**
 * Agent Runtime Tests
 *
 * Tests for the agent runtime that allows tools to run as server-side agents
 * with LLM capabilities instead of browser-side with UI interactions.
 */
import { z } from 'zod'
import { spawn, all } from 'effection'
import type { Operation } from 'effection'
import { describe, it, expect } from './vitest-effection'
import { defineIsomorphicTool } from '../define'
import { executeServerPart, executeServerPhase2 } from '../executor'
import { runAsAgent, createMockAgentContext } from '../agent-runtime'
import type { ServerAuthorityContext, FlexibleClientContext, AgentContext } from '../types'

// =============================================================================
// TEST TOOLS
// =============================================================================

/**
 * Simple analysis tool that uses ctx.prompt() to analyze text.
 */
const textAnalyzerTool = defineIsomorphicTool({
  name: 'text_analyzer',
  description: 'Analyzes text and extracts entities',
  parameters: z.object({
    text: z.string(),
    extractTypes: z.array(z.enum(['people', 'places', 'dates'])),
  }),
  authority: 'server',

  *server(params, ctx: ServerAuthorityContext) {
    return yield* ctx.handoff({
      *before() {
        return {
          text: params.text,
          extractTypes: params.extractTypes,
        }
      },
      *after(
        _handoff,
        result: { entities: Record<string, string[]>; confidence: number }
      ) {
        return {
          analyzed: true,
          entities: result.entities,
          confidence: result.confidence,
          extractedTypes: params.extractTypes.length,
        }
      },
    })
  },

  *client(handoffData, ctx, _params) {
    const data = handoffData as unknown as {
      text: string
      extractTypes: string[]
    }
    const flexCtx = ctx as FlexibleClientContext

    if (!flexCtx.prompt) {
      throw new Error('text_analyzer requires agent context with prompt capability')
    }

      const result = yield* flexCtx.prompt({
        prompt: `Extract entities from: "${data.text}". Types to extract: ${data.extractTypes.join(', ')}`,
        schema: z.object({
          entities: z.object({
            people: z.array(z.string()).optional(),
            places: z.array(z.string()).optional(),
            dates: z.array(z.string()).optional(),
          }),
          confidence: z.number().min(0).max(1),
        }),
      })

    return result
  },
})

/**
 * Multi-step research tool that chains multiple LLM calls.
 */
const researcherTool = defineIsomorphicTool({
  name: 'researcher',
  description: 'Researches a topic with multiple queries',
  parameters: z.object({
    topic: z.string(),
    depth: z.enum(['shallow', 'medium', 'deep']),
  }),
  authority: 'server',

  *server(params, ctx: ServerAuthorityContext) {
    return yield* ctx.handoff({
      *before() {
        return { topic: params.topic, depth: params.depth }
      },
      *after(
        _handoff,
        result: { findings: string[]; sources: string[] }
      ) {
        return {
          topic: params.topic,
          summary: result.findings.join('. '),
          sourceCount: result.sources.length,
        }
      },
    })
  },

  *client(handoffData, ctx, _params) {
    const data = handoffData as unknown as { topic: string; depth: string }
    const flexCtx = ctx as FlexibleClientContext

    if (!flexCtx.prompt) {
      throw new Error('researcher requires agent context')
    }

    // First research query
    const initial = yield* flexCtx.prompt({
      prompt: `Initial research on: ${data.topic}`,
      schema: z.object({
        findings: z.array(z.string()),
        needsMore: z.boolean(),
      }),
    })

    const allFindings = [...initial.findings]
    const sources = ['initial']

    // Additional research based on depth
    if (data.depth !== 'shallow' && initial.needsMore) {
      const deeper = yield* flexCtx.prompt({
        prompt: `Deeper research on: ${data.topic}`,
        schema: z.object({
          findings: z.array(z.string()),
        }),
      })
      allFindings.push(...deeper.findings)
      sources.push('deep')
    }

    return { findings: allFindings, sources }
  },
})

/**
 * Parallel analysis tool that spawns concurrent LLM calls.
 */
const parallelAnalyzerTool = defineIsomorphicTool({
  name: 'parallel_analyzer',
  description: 'Analyzes from multiple perspectives in parallel',
  parameters: z.object({
    subject: z.string(),
  }),
  authority: 'server',

  *server(params, ctx: ServerAuthorityContext) {
    return yield* ctx.handoff({
      *before() {
        return { subject: params.subject }
      },
      *after(
        _handoff,
        result: { technical: string; business: string }
      ) {
        return {
          subject: params.subject,
          perspectives: result,
          count: 2,
        }
      },
    })
  },

  *client(handoffData, ctx, _params) {
    const data = handoffData as unknown as { subject: string }
    const flexCtx = ctx as FlexibleClientContext

    if (!flexCtx.prompt) {
      throw new Error('parallel_analyzer requires agent context')
    }

    // Spawn parallel analysis tasks
    const techTask = yield* spawn(function* () {
      return yield* flexCtx.prompt!({
        prompt: `Technical analysis of: ${data.subject}`,
        schema: z.object({ analysis: z.string() }),
      })
    })

    const bizTask = yield* spawn(function* () {
      return yield* flexCtx.prompt!({
        prompt: `Business analysis of: ${data.subject}`,
        schema: z.object({ analysis: z.string() }),
      })
    })

    const [tech, biz] = yield* all([techTask, bizTask])

    return {
      technical: tech.analysis,
      business: biz.analysis,
    }
  },
})

// =============================================================================
// TESTS
// =============================================================================

describe('Agent Runtime', () => {
  const signal = new AbortController().signal

  describe('runAsAgent with mock context', () => {
    it('executes a simple analysis tool', function* () {
      // Mock LLM responses
      const llmResponses = new Map<string, unknown>([
        ['Extract entities', {
          entities: { people: ['Alice', 'Bob'], places: ['NYC'] },
          confidence: 0.85,
        }],
      ])

      // Phase 1: Get handoff data
      const phase1 = yield* executeServerPart(
        textAnalyzerTool,
        'call-1',
        { text: 'Alice and Bob went to NYC', extractTypes: ['people', 'places'] },
        signal
      )
      expect(phase1.kind).toBe('handoff')
      if (phase1.kind !== 'handoff') throw new Error('Expected handoff')

      // Create mock agent context
      const agentCtx = createMockAgentContext({
        callId: 'call-1',
        llmResponses,
      })

      // Run as agent
      const clientResult = (yield* runAsAgent({
        tool: textAnalyzerTool,
        handoffData: phase1.serverOutput,
        params: { text: 'Alice and Bob went to NYC', extractTypes: ['people', 'places'] },
        signal,
        llm: {
          prompt: agentCtx.prompt.bind(agentCtx),
        },
      })) as { entities: { people?: string[]; places?: string[] }; confidence: number }

      expect(clientResult.entities.people).toContain('Alice')
      expect(clientResult.confidence).toBe(0.85)

      // Phase 2: Complete with client result
      const result = (yield* executeServerPhase2(
        textAnalyzerTool,
        'call-1',
        { text: 'Alice and Bob went to NYC', extractTypes: ['people', 'places'] },
        clientResult,
        phase1.serverOutput,
        signal,
        true
      )) as { analyzed: boolean; entities: { people?: string[]; places?: string[] }; confidence: number }

      expect(result.analyzed).toBe(true)
      expect(result.entities.people).toContain('Alice')
      expect(result.confidence).toBe(0.85)
    })

    it('supports chained LLM calls', function* () {
      const llmResponses = new Map<string, unknown>([
        ['Initial research', { findings: ['Fact 1', 'Fact 2'], needsMore: true }],
        ['Deeper research', { findings: ['Deep fact 1'] }],
      ])

      const phase1 = yield* executeServerPart(
        researcherTool,
        'call-2',
        { topic: 'AI', depth: 'deep' },
        signal
      )
      if (phase1.kind !== 'handoff') throw new Error('Expected handoff')

      const agentCtx = createMockAgentContext({
        callId: 'call-2',
        llmResponses,
      })

      const clientResult = (yield* runAsAgent({
        tool: researcherTool,
        handoffData: phase1.serverOutput,
        params: { topic: 'AI', depth: 'deep' },
        signal,
        llm: { prompt: agentCtx.prompt.bind(agentCtx) },
      })) as { findings: string[]; sources: string[] }

      expect(clientResult.findings).toEqual(['Fact 1', 'Fact 2', 'Deep fact 1'])
      expect(clientResult.sources).toEqual(['initial', 'deep'])
    })

    it('supports parallel LLM calls', function* () {
      const llmResponses = new Map<string, unknown>([
        ['Technical analysis', { analysis: 'Technically sound' }],
        ['Business analysis', { analysis: 'Good market fit' }],
      ])

      const phase1 = yield* executeServerPart(
        parallelAnalyzerTool,
        'call-3',
        { subject: 'New Product' },
        signal
      )
      if (phase1.kind !== 'handoff') throw new Error('Expected handoff')

      const agentCtx = createMockAgentContext({
        callId: 'call-3',
        llmResponses,
      })

      const clientResult = (yield* runAsAgent({
        tool: parallelAnalyzerTool,
        handoffData: phase1.serverOutput,
        params: { subject: 'New Product' },
        signal,
        llm: { prompt: agentCtx.prompt.bind(agentCtx) },
      })) as { technical: string; business: string }

      expect(clientResult.technical).toBe('Technically sound')
      expect(clientResult.business).toBe('Good market fit')
    })
  })

  describe('event emission', () => {
    it('captures emitted events via onEmit callback', function* () {
      const emittedEvents: unknown[] = []

      // Tool that emits progress
      const progressTool = defineIsomorphicTool({
        name: 'progress_tool',
        description: 'Emits progress events',
        parameters: z.object({ steps: z.number() }),
        authority: 'server',

        *server(params, ctx: ServerAuthorityContext) {
          return yield* ctx.handoff({
            *before() {
              return { steps: params.steps }
            },
            *after(_h, result: { completed: number }) {
              return result
            },
          })
        },

        *client(handoffData, ctx, _params) {
          const data = handoffData as unknown as { steps: number }
          const flexCtx = ctx as AgentContext

          for (let i = 1; i <= data.steps; i++) {
            if (flexCtx.emit) {
              yield* flexCtx.emit({ type: 'progress', step: i, total: data.steps })
            }
          }

          return { completed: data.steps }
        },
      })

      const phase1 = yield* executeServerPart(
        progressTool,
        'emit-1',
        { steps: 3 },
        signal
      )
      if (phase1.kind !== 'handoff') throw new Error('Expected handoff')

      const agentCtx = createMockAgentContext({
        callId: 'emit-1',
        onEmit: (event) => emittedEvents.push(event),
      })

      yield* runAsAgent({
        tool: progressTool,
        handoffData: phase1.serverOutput,
        params: { steps: 3 },
        signal,
        llm: { prompt: agentCtx.prompt.bind(agentCtx) },
        onEmit: (event): Operation<void> =>
          function* () {
            emittedEvents.push(event)
          }(),
      })

      expect(emittedEvents).toEqual([
        { type: 'progress', step: 1, total: 3 },
        { type: 'progress', step: 2, total: 3 },
        { type: 'progress', step: 3, total: 3 },
      ])
    })
  })

  describe('error handling', () => {
    it('throws when prompt not found in mock responses', function* () {
      const agentCtx = createMockAgentContext({
        callId: 'error-1',
        llmResponses: new Map(), // Empty - no responses
      })

      const phase1 = yield* executeServerPart(
        textAnalyzerTool,
        'error-1',
        { text: 'test', extractTypes: ['people'] },
        signal
      )
      if (phase1.kind !== 'handoff') throw new Error('Expected handoff')

      try {
        yield* runAsAgent({
          tool: textAnalyzerTool,
          handoffData: phase1.serverOutput,
          params: { text: 'test', extractTypes: ['people'] },
          signal,
          llm: { prompt: agentCtx.prompt.bind(agentCtx) },
        })
        expect.fail('Should have thrown')
      } catch (e) {
        expect(e).toBeInstanceOf(Error)
        expect((e as Error).message).toContain('No mock LLM response')
      }
    })

    it('throws when tool has no client function', function* () {
      // Use a plain object instead of defineIsomorphicTool to avoid type errors
      const serverOnlyTool = {
        name: 'server_only',
        description: 'Server only tool',
        parameters: z.object({}),
        authority: 'server' as const,
        *server(_params: Record<string, never>, _ctx: ServerAuthorityContext) {
          return { result: 'done' }
        },
        // No client function!
      }

      const agentCtx = createMockAgentContext({ callId: 'no-client' })

      try {
        yield* runAsAgent({
          tool: serverOnlyTool,
          handoffData: {},
          params: {},
          signal,
          llm: { prompt: agentCtx.prompt.bind(agentCtx) },
        })
        expect.fail('Should have thrown')
      } catch (e) {
        expect((e as Error).message).toContain('no client function')
      }
    })
  })
})
