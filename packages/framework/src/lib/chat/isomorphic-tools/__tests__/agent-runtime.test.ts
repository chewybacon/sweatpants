/**
 * Agent Runtime Tests
 *
 * Tests for the agent runtime that allows tools to run as server-side agents
 * with LLM capabilities instead of browser-side with UI interactions.
 *
 * These tests use the new builder API with `.context('agent')` which provides:
 * - Full type inference for handoff data
 * - AgentToolContext with prompt() available without casts
 * - Runtime validation that agent tools run in agent environments
 */
import { z } from 'zod'
import { spawn, all } from 'effection'
import type { Operation } from 'effection'
import { describe, it, expect } from './vitest-effection'
import { createIsomorphicTool } from '../builder'
import { executeServerPart, executeServerPhase2 } from '../executor'
import { runAsAgent, createMockAgentToolContext } from '../agent-runtime'
import type { AnyIsomorphicTool } from '../types'

// =============================================================================
// TEST TOOLS (using new builder API with .context('agent'))
// =============================================================================

/**
 * Simple analysis tool that uses ctx.prompt() to analyze text.
 * With .context('agent'), ctx is typed as AgentToolContext - no casts needed.
 */
const textAnalyzerTool = createIsomorphicTool('text_analyzer')
  .description('Analyzes text and extracts entities')
  .parameters(z.object({
    text: z.string(),
    extractTypes: z.array(z.enum(['people', 'places', 'dates'])),
  }))
  .context('agent')
  .authority('server')
  .handoff({
    *before(params) {
      return {
        text: params.text,
        extractTypes: params.extractTypes,
      }
    },
    *client(handoff, ctx, _params) {
      // ctx is AgentToolContext - prompt() is guaranteed available
      const result = yield* ctx.prompt({
        prompt: `Extract entities from: "${handoff.text}". Types to extract: ${handoff.extractTypes.join(', ')}`,
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
    *after(_handoff, result, _ctx, params) {
      return {
        analyzed: true,
        entities: result.entities,
        confidence: result.confidence,
        extractedTypes: params.extractTypes.length,
      }
    },
  })

/**
 * Multi-step research tool that chains multiple LLM calls.
 */
const researcherTool = createIsomorphicTool('researcher')
  .description('Researches a topic with multiple queries')
  .parameters(z.object({
    topic: z.string(),
    depth: z.enum(['shallow', 'medium', 'deep']),
  }))
  .context('agent')
  .authority('server')
  .handoff({
    *before(params) {
      return { topic: params.topic, depth: params.depth }
    },
    *client(handoff, ctx, _params) {
      // First research query
      const initial = yield* ctx.prompt({
        prompt: `Initial research on: ${handoff.topic}`,
        schema: z.object({
          findings: z.array(z.string()),
          needsMore: z.boolean(),
        }),
      })

      const allFindings = [...initial.findings]
      const sources = ['initial']

      // Additional research based on depth
      if (handoff.depth !== 'shallow' && initial.needsMore) {
        const deeper = yield* ctx.prompt({
          prompt: `Deeper research on: ${handoff.topic}`,
          schema: z.object({
            findings: z.array(z.string()),
          }),
        })
        allFindings.push(...deeper.findings)
        sources.push('deep')
      }

      return { findings: allFindings, sources }
    },
    *after(_handoff, result, _ctx, params) {
      return {
        topic: params.topic,
        summary: result.findings.join('. '),
        sourceCount: result.sources.length,
      }
    },
  })

/**
 * Parallel analysis tool that spawns concurrent LLM calls.
 */
const parallelAnalyzerTool = createIsomorphicTool('parallel_analyzer')
  .description('Analyzes from multiple perspectives in parallel')
  .parameters(z.object({
    subject: z.string(),
  }))
  .context('agent')
  .authority('server')
  .handoff({
    *before(params) {
      return { subject: params.subject }
    },
    *client(handoff, ctx, _params) {
      // Spawn parallel analysis tasks
      const techTask = yield* spawn(function* () {
        return yield* ctx.prompt({
          prompt: `Technical analysis of: ${handoff.subject}`,
          schema: z.object({ analysis: z.string() }),
        })
      })

      const bizTask = yield* spawn(function* () {
        return yield* ctx.prompt({
          prompt: `Business analysis of: ${handoff.subject}`,
          schema: z.object({ analysis: z.string() }),
        })
      })

      const [tech, biz] = yield* all([techTask, bizTask])

      return {
        technical: tech.analysis,
        business: biz.analysis,
      }
    },
    *after(_handoff, result, _ctx, params) {
      return {
        subject: params.subject,
        perspectives: result,
        count: 2,
      }
    },
  })

/**
 * Progress tool that emits events during execution.
 */
const progressTool = createIsomorphicTool('progress_tool')
  .description('Emits progress events')
  .parameters(z.object({ steps: z.number() }))
  .context('agent')
  .authority('server')
  .handoff({
    *before(params) {
      return { steps: params.steps }
    },
    *client(handoff, ctx, _params) {
      for (let i = 1; i <= handoff.steps; i++) {
        if (ctx.emit) {
          yield* ctx.emit({ type: 'progress', step: i, total: handoff.steps })
        }
      }
      return { completed: handoff.steps }
    },
    *after(_handoff, result) {
      return result
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

      // Cast to AnyIsomorphicTool for executor (type erasure at runtime)
      const tool = textAnalyzerTool as unknown as AnyIsomorphicTool

      // Phase 1: Get handoff data
      const phase1 = yield* executeServerPart(
        tool,
        'call-1',
        { text: 'Alice and Bob went to NYC', extractTypes: ['people', 'places'] },
        signal
      )
      expect(phase1.kind).toBe('handoff')
      if (phase1.kind !== 'handoff') throw new Error('Expected handoff')

      // Create mock agent context
      const agentCtx = createMockAgentToolContext({
        callId: 'call-1',
        llmResponses,
      })

      // Run as agent
      const clientResult = (yield* runAsAgent({
        tool,
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
        tool,
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

      const tool = researcherTool as unknown as AnyIsomorphicTool

      const phase1 = yield* executeServerPart(
        tool,
        'call-2',
        { topic: 'AI', depth: 'deep' },
        signal
      )
      if (phase1.kind !== 'handoff') throw new Error('Expected handoff')

      const agentCtx = createMockAgentToolContext({
        callId: 'call-2',
        llmResponses,
      })

      const clientResult = (yield* runAsAgent({
        tool,
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

      const tool = parallelAnalyzerTool as unknown as AnyIsomorphicTool

      const phase1 = yield* executeServerPart(
        tool,
        'call-3',
        { subject: 'New Product' },
        signal
      )
      if (phase1.kind !== 'handoff') throw new Error('Expected handoff')

      const agentCtx = createMockAgentToolContext({
        callId: 'call-3',
        llmResponses,
      })

      const clientResult = (yield* runAsAgent({
        tool,
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
      const tool = progressTool as unknown as AnyIsomorphicTool

      const phase1 = yield* executeServerPart(
        tool,
        'emit-1',
        { steps: 3 },
        signal
      )
      if (phase1.kind !== 'handoff') throw new Error('Expected handoff')

      const agentCtx = createMockAgentToolContext({
        callId: 'emit-1',
        onEmit: (event) => emittedEvents.push(event),
      })

      yield* runAsAgent({
        tool,
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
      const agentCtx = createMockAgentToolContext({
        callId: 'error-1',
        llmResponses: new Map(), // Empty - no responses
      })

      const tool = textAnalyzerTool as unknown as AnyIsomorphicTool

      const phase1 = yield* executeServerPart(
        tool,
        'error-1',
        { text: 'test', extractTypes: ['people'] },
        signal
      )
      if (phase1.kind !== 'handoff') throw new Error('Expected handoff')

      try {
        yield* runAsAgent({
          tool,
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
      // A server-only tool (no handoff, no client)
      const serverOnlyTool = createIsomorphicTool('server_only')
        .description('Server only tool')
        .parameters(z.object({}))
        .context('headless')
        .authority('server')
        .server(function* () {
          return { result: 'done' }
        })
        .build()

      const agentCtx = createMockAgentToolContext({ callId: 'no-client' })

      try {
        yield* runAsAgent({
          tool: serverOnlyTool as unknown as AnyIsomorphicTool,
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
