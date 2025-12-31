/**
 * Agent Context Exploration
 *
 * Exploring how the handoff primitive supports different context modes:
 * 1. Browser client (.context('browser') - waitFor UI interactions)
 * 2. Server-side agent (.context('agent') - ctx.prompt for LLM calls)
 * 3. Headless (.context('headless') - pure computation, runs anywhere)
 *
 * Uses the new builder API with declarative context types.
 */
import { z } from 'zod'
import { spawn, all } from 'effection'
import type { Operation } from 'effection'
import { describe, it, expect } from './vitest-effection'
import { createIsomorphicTool } from '../builder'
import { executeServerPart, executeServerPhase2 } from '../executor'
import type { AnyIsomorphicTool, BrowserToolContext, AgentToolContext } from '../types'

// =============================================================================
// MOCK IMPLEMENTATIONS
// =============================================================================

/**
 * Base mock context with no-op implementations of required BaseToolContext methods.
 */
function createBaseMockContext(callId: string) {
  return {
    callId,
    signal: new AbortController().signal,
    requestApproval: (_message: string) =>
      function* () {
        return { approved: true as const }
      }(),
    requestPermission: (_type: string) =>
      function* () {
        return { approved: true as const }
      }(),
    reportProgress: (_message: string) =>
      function* () {
        // no-op
      }(),
  }
}

/**
 * Create a mock browser context that captures waitFor calls
 */
function createMockBrowserContext(
  callId: string,
  responses: Map<string, unknown>
): BrowserToolContext {
  return {
    ...createBaseMockContext(callId),
    waitFor<TPayload, TResponse>(type: string, _payload: TPayload): Operation<TResponse> {
      return function* () {
        const response = responses.get(type)
        if (response === undefined) {
          throw new Error(`No mock response for waitFor type: ${type}`)
        }
        return response as TResponse
      }()
    },
  }
}

/**
 * Create a mock agent context with a fake LLM
 */
function createMockAgentContext(
  callId: string,
  llmResponses: Map<string, unknown>
): AgentToolContext {
  return {
    ...createBaseMockContext(callId),
    prompt<T extends z.ZodType>(opts: {
      prompt: string
      schema: T
    }): Operation<z.infer<T>> {
      return function* () {
        // Find response by checking if prompt contains key
        for (const [key, value] of llmResponses) {
          if (opts.prompt.includes(key)) {
            // Validate against schema
            const parsed = opts.schema.parse(value)
            return parsed
          }
        }
        throw new Error(`No mock LLM response for prompt: ${opts.prompt}`)
      }()
    },
  }
}

// =============================================================================
// TEST TOOLS (using new builder API)
// =============================================================================

/**
 * A browser-context tool that uses waitFor for UI interactions.
 */
const browserChoiceTool = createIsomorphicTool('browser_choice')
  .description('Gets user choice via UI')
  .parameters(z.object({
    choices: z.array(z.string()),
    criteria: z.string(),
  }))
  .context('browser')
  .authority('server')
  .handoff({
    *before(params) {
      return {
        choices: params.choices,
        criteria: params.criteria,
        timestamp: Date.now(),
      }
    },
    *client(handoff, ctx, _params) {
      // ctx is BrowserToolContext - waitFor is available
      const result = yield* ctx.waitFor<
        { choices: string[]; criteria: string },
        { selected: string }
      >('pick-choice', {
        choices: handoff.choices,
        criteria: handoff.criteria,
      })
      return { selected: result.selected }
    },
    *after(_handoff, clientResult) {
      return {
        selected: clientResult.selected,
        reasoning: 'User selection',
        decidedAt: Date.now(),
      }
    },
  })

/**
 * An agent-context tool that uses prompt for LLM interactions.
 */
const agentChoiceTool = createIsomorphicTool('agent_choice')
  .description('Gets choice via LLM')
  .parameters(z.object({
    choices: z.array(z.string()),
    criteria: z.string(),
  }))
  .context('agent')
  .authority('server')
  .handoff({
    *before(params) {
      return {
        choices: params.choices,
        criteria: params.criteria,
        timestamp: Date.now(),
      }
    },
    *client(handoff, ctx, _params) {
      // ctx is AgentToolContext - prompt is available
      const result = yield* ctx.prompt({
        prompt: `Given criteria "${handoff.criteria}", pick the best choice from: ${handoff.choices.join(', ')}`,
        schema: z.object({
          selected: z.string(),
          reasoning: z.string(),
        }),
      })
      return result
    },
    *after(_handoff, clientResult) {
      return {
        selected: clientResult.selected,
        reasoning: clientResult.reasoning,
        decidedAt: Date.now(),
      }
    },
  })

/**
 * Research agent - demonstrates sequential LLM calls
 */
const researchAgentTool = createIsomorphicTool('research_agent')
  .description('Researches a topic using multiple LLM calls')
  .parameters(z.object({
    topic: z.string(),
    depth: z.enum(['shallow', 'deep']).default('shallow'),
  }))
  .context('agent')
  .authority('server')
  .handoff({
    *before(params) {
      return { topic: params.topic, depth: params.depth }
    },
    *client(handoff, ctx, _params) {
      // Initial research
      const initial = yield* ctx.prompt({
        prompt: `Research topic: ${handoff.topic}. Provide key findings.`,
        schema: z.object({
          findings: z.array(z.string()),
          needsMoreResearch: z.boolean(),
        }),
      })

      let allFindings = [...initial.findings]
      const sources = ['initial-research']

      // Deep research if requested
      if (handoff.depth === 'deep' && initial.needsMoreResearch) {
        const deeper = yield* ctx.prompt({
          prompt: `Dive deeper into: ${handoff.topic}. Build on: ${initial.findings.join(', ')}`,
          schema: z.object({
            findings: z.array(z.string()),
          }),
        })
        allFindings = [...allFindings, ...deeper.findings]
        sources.push('deep-research')
      }

      return {
        findings: allFindings,
        sources,
        confidence: handoff.depth === 'deep' ? 0.9 : 0.7,
      }
    },
    *after(_handoff, result) {
      return {
        summary: result.findings.join('. '),
        sourceCount: result.sources.length,
        confidence: result.confidence,
      }
    },
  })

/**
 * Parallel analysis tool - demonstrates spawn + all pattern
 */
const parallelAnalysisTool = createIsomorphicTool('parallel_analysis')
  .description('Analyzes a topic from multiple perspectives in parallel')
  .parameters(z.object({
    topic: z.string(),
  }))
  .context('agent')
  .authority('server')
  .handoff({
    *before(params) {
      return { topic: params.topic }
    },
    *client(handoff, ctx, _params) {
      // Spawn parallel analysis tasks
      const technicalTask = yield* spawn(function* () {
        return yield* ctx.prompt({
          prompt: `Analyze "${handoff.topic}" from a technical perspective`,
          schema: z.object({ analysis: z.string() }),
        })
      })

      const businessTask = yield* spawn(function* () {
        return yield* ctx.prompt({
          prompt: `Analyze "${handoff.topic}" from a business perspective`,
          schema: z.object({ analysis: z.string() }),
        })
      })

      const userTask = yield* spawn(function* () {
        return yield* ctx.prompt({
          prompt: `Analyze "${handoff.topic}" from a user perspective`,
          schema: z.object({ analysis: z.string() }),
        })
      })

      // Wait for all to complete
      const [technical, business, user] = yield* all([
        technicalTask,
        businessTask,
        userTask,
      ])

      return {
        technical: technical.analysis,
        business: business.analysis,
        user: user.analysis,
      }
    },
    *after(_handoff, result) {
      return {
        analysis: result,
        perspectives: 3,
      }
    },
  })

/**
 * Progress tool - demonstrates emit capability
 */
const progressTool = createIsomorphicTool('progress_tool')
  .description('Tool that emits progress')
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
      return { done: true, completed: result.completed }
    },
  })

// =============================================================================
// TESTS
// =============================================================================

describe('Agent Context Exploration', () => {
  const signal = new AbortController().signal

  describe('Browser context tools', () => {
    it('works with browser context (waitFor)', function* () {
      // Set up mock browser context
      const responses = new Map<string, unknown>([
        ['pick-choice', { selected: 'Option B' }],
      ])

      const tool = browserChoiceTool as unknown as AnyIsomorphicTool

      // Phase 1
      const phase1 = yield* executeServerPart(
        tool,
        'call-1',
        { choices: ['Option A', 'Option B', 'Option C'], criteria: 'best value' },
        signal
      )
      expect(phase1.kind).toBe('handoff')
      if (phase1.kind !== 'handoff') throw new Error('Expected handoff')

      // Simulate browser client execution
      const browserCtx = createMockBrowserContext('call-1', responses)
      const clientResult = (yield* browserChoiceTool.client!(
        phase1.serverOutput as any,
        browserCtx,
        { choices: ['Option A', 'Option B', 'Option C'], criteria: 'best value' }
      )) as { selected: string }

      expect(clientResult).toEqual({ selected: 'Option B' })

      // Phase 2
      const result = (yield* executeServerPhase2(
        tool,
        'call-1',
        { choices: ['Option A', 'Option B', 'Option C'], criteria: 'best value' },
        clientResult,
        phase1.serverOutput,
        signal,
        true
      )) as { selected: string; reasoning: string }

      expect(result.selected).toBe('Option B')
      expect(result.reasoning).toBe('User selection')
    })
  })

  describe('Agent context tools', () => {
    it('works with agent context (prompt)', function* () {
      // Set up mock agent context with LLM responses
      const llmResponses = new Map<string, unknown>([
        [
          'best value',
          { selected: 'Option A', reasoning: 'Best price to quality ratio' },
        ],
      ])

      const tool = agentChoiceTool as unknown as AnyIsomorphicTool

      // Phase 1
      const phase1 = yield* executeServerPart(
        tool,
        'call-1',
        { choices: ['Option A', 'Option B', 'Option C'], criteria: 'best value' },
        signal
      )
      expect(phase1.kind).toBe('handoff')
      if (phase1.kind !== 'handoff') throw new Error('Expected handoff')

      // Simulate agent execution
      const agentCtx = createMockAgentContext('call-1', llmResponses)
      const clientResult = (yield* agentChoiceTool.client!(
        phase1.serverOutput as any,
        agentCtx,
        { choices: ['Option A', 'Option B', 'Option C'], criteria: 'best value' }
      )) as { selected: string; reasoning: string }

      expect(clientResult.selected).toBe('Option A')
      expect(clientResult.reasoning).toBe('Best price to quality ratio')

      // Phase 2
      const result = (yield* executeServerPhase2(
        tool,
        'call-1',
        { choices: ['Option A', 'Option B', 'Option C'], criteria: 'best value' },
        clientResult,
        phase1.serverOutput,
        signal,
        true
      )) as { selected: string; reasoning: string }

      expect(result.selected).toBe('Option A')
      expect(result.reasoning).toBe('Best price to quality ratio')
    })
  })

  describe('Agent-specific capabilities', () => {
    it('supports sequential LLM calls (research agent)', function* () {
      const llmResponses = new Map<string, unknown>([
        ['Research topic', { findings: ['Finding 1', 'Finding 2'], needsMoreResearch: true }],
        ['Dive deeper', { findings: ['Deep finding 1'] }],
      ])

      const tool = researchAgentTool as unknown as AnyIsomorphicTool

      // Phase 1
      const phase1 = yield* executeServerPart(
        tool,
        'call-1',
        { topic: 'AI agents', depth: 'deep' },
        signal
      )
      if (phase1.kind !== 'handoff') throw new Error('Expected handoff')

      // Execute agent
      const agentCtx = createMockAgentContext('call-1', llmResponses)
      const clientResult = (yield* researchAgentTool.client!(
        phase1.serverOutput as any,
        agentCtx,
        { topic: 'AI agents', depth: 'deep' }
      )) as { findings: string[]; sources: string[]; confidence: number }

      expect(clientResult.findings).toEqual(['Finding 1', 'Finding 2', 'Deep finding 1'])
      expect(clientResult.sources).toEqual(['initial-research', 'deep-research'])
      expect(clientResult.confidence).toBe(0.9)

      // Phase 2
      const result = (yield* executeServerPhase2(
        tool,
        'call-1',
        { topic: 'AI agents', depth: 'deep' },
        clientResult,
        phase1.serverOutput,
        signal,
        true
      )) as { summary: string; sourceCount: number; confidence: number }

      expect(result.summary).toBe('Finding 1. Finding 2. Deep finding 1')
      expect(result.sourceCount).toBe(2)
      expect(result.confidence).toBe(0.9)
    })

    it('supports parallel execution (spawn + all)', function* () {
      const llmResponses = new Map<string, unknown>([
        ['technical perspective', { analysis: 'Technically complex but feasible' }],
        ['business perspective', { analysis: 'Strong market potential' }],
        ['user perspective', { analysis: 'Users would love this' }],
      ])

      const tool = parallelAnalysisTool as unknown as AnyIsomorphicTool

      // Phase 1
      const phase1 = yield* executeServerPart(
        tool,
        'call-1',
        { topic: 'New feature X' },
        signal
      )
      if (phase1.kind !== 'handoff') throw new Error('Expected handoff')

      // Execute agent (parallel tasks)
      const agentCtx = createMockAgentContext('call-1', llmResponses)
      const clientResult = (yield* parallelAnalysisTool.client!(
        phase1.serverOutput as any,
        agentCtx,
        { topic: 'New feature X' }
      )) as { technical: string; business: string; user: string }

      expect(clientResult.technical).toBe('Technically complex but feasible')
      expect(clientResult.business).toBe('Strong market potential')
      expect(clientResult.user).toBe('Users would love this')

      // Phase 2
      const result = (yield* executeServerPhase2(
        tool,
        'call-1',
        { topic: 'New feature X' },
        clientResult,
        phase1.serverOutput,
        signal,
        true
      )) as { analysis: { technical: string; business: string; user: string }; perspectives: number }

      expect(result.perspectives).toBe(3)
      expect(result.analysis.technical).toBe('Technically complex but feasible')
    })
  })

  describe('Agent with emit (streaming events)', () => {
    it('can emit progress events to parent', function* () {
      const tool = progressTool as unknown as AnyIsomorphicTool

      // Collect events
      const events: unknown[] = []

      // Create a mock agent context with emit
      const agentCtx: AgentToolContext = {
        ...createBaseMockContext('call-1'),
        prompt: function* () {
          throw new Error('Not used in this test')
        },
        emit: (event: unknown) =>
          function* () {
            events.push(event)
          }(),
      }

      // Phase 1
      const phase1 = yield* executeServerPart(tool, 'call-1', { steps: 3 }, signal)
      if (phase1.kind !== 'handoff') throw new Error('Expected handoff')

      // Execute with emit capability
      const clientResult = (yield* progressTool.client!(
        phase1.serverOutput as any,
        agentCtx,
        { steps: 3 }
      )) as { completed: number }

      expect(clientResult.completed).toBe(3)
      expect(events).toEqual([
        { type: 'progress', step: 1, total: 3 },
        { type: 'progress', step: 2, total: 3 },
        { type: 'progress', step: 3, total: 3 },
      ])
    })
  })
})

describe('Nested Agents (agent calling agent)', () => {
  const signal = new AbortController().signal

  it('demonstrates agent composition via direct tool execution', function* () {
    // Inner agent - does the actual work
    const innerAgentTool = createIsomorphicTool('inner_agent')
      .description('Does specific work')
      .parameters(z.object({ task: z.string() }))
      .context('agent')
      .authority('server')
      .handoff({
        *before(params) {
          return { task: params.task }
        },
        *client(handoff, ctx, _params) {
          const result = yield* ctx.prompt({
            prompt: `Execute task: ${handoff.task}`,
            schema: z.object({ output: z.string() }),
          })
          return { output: result.output }
        },
        *after(_handoff, result) {
          return { completed: true, output: result.output }
        },
      })

    // Outer agent - orchestrates multiple inner agents
    const outerAgentTool = createIsomorphicTool('outer_agent')
      .description('Orchestrates multiple tasks')
      .parameters(z.object({ tasks: z.array(z.string()) }))
      .context('agent')
      .authority('server')
      .handoff({
        *before(params) {
          return { tasks: params.tasks }
        },
        *client(handoff, ctx, _params) {
          const innerTool = innerAgentTool as unknown as AnyIsomorphicTool

          // Execute inner agents in parallel using spawn + all pattern
          function* executeInner(task: string) {
            // Execute inner agent's full lifecycle
            const innerPhase1 = yield* executeServerPart(
              innerTool,
              `inner-${task}`,
              { task },
              ctx.signal
            )
            if (innerPhase1.kind !== 'handoff') throw new Error('Expected handoff')

            // Run inner agent's client with same ctx
            const innerClientResult = yield* innerAgentTool.client!(
              innerPhase1.serverOutput as any,
              ctx,
              { task }
            )

            // Complete inner agent
            const innerResult = (yield* executeServerPhase2(
              innerTool,
              `inner-${task}`,
              { task },
              innerClientResult,
              innerPhase1.serverOutput,
              ctx.signal,
              true
            )) as { completed: boolean; output: string }

            return innerResult
          }

          const results = (yield* all(handoff.tasks.map((t) => executeInner(t)))) as { completed: boolean; output: string }[]
          return { results: results.map((r) => r.output) }
        },
        *after(_handoff, result) {
          return { allDone: true, results: result.results }
        },
      })

    // Set up mock responses for all tasks
    const llmResponses = new Map<string, unknown>([
      ['task A', { output: 'Result A' }],
      ['task B', { output: 'Result B' }],
      ['task C', { output: 'Result C' }],
    ])

    const tool = outerAgentTool as unknown as AnyIsomorphicTool

    // Execute outer agent
    const phase1 = yield* executeServerPart(
      tool,
      'outer-1',
      { tasks: ['task A', 'task B', 'task C'] },
      signal
    )
    if (phase1.kind !== 'handoff') throw new Error('Expected handoff')

    const agentCtx = createMockAgentContext('outer-1', llmResponses)
    const clientResult = (yield* outerAgentTool.client!(
      phase1.serverOutput as any,
      agentCtx,
      { tasks: ['task A', 'task B', 'task C'] }
    )) as { results: string[] }

    expect(clientResult).toEqual({
      results: ['Result A', 'Result B', 'Result C'],
    })

    // Complete outer agent
    const result = (yield* executeServerPhase2(
      tool,
      'outer-1',
      { tasks: ['task A', 'task B', 'task C'] },
      clientResult,
      phase1.serverOutput,
      signal,
      true
    )) as { allDone: boolean; results: string[] }

    expect(result).toEqual({
      allDone: true,
      results: ['Result A', 'Result B', 'Result C'],
    })
  })
})
