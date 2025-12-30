/**
 * Agent Context Exploration
 *
 * Exploring the idea that the handoff primitive can support both:
 * 1. Browser client (waitFor UI interactions)
 * 2. Server-side agent (ctx.prompt for LLM calls)
 *
 * Same tool definition, different ctx injections.
 */
import { z } from 'zod'
import { spawn, all } from 'effection'
import type { Operation } from 'effection'
import { describe, it, expect } from './vitest-effection'
import { defineIsomorphicTool } from '../define'
import { executeServerPart, executeServerPhase2 } from '../executor'
import type {
  ServerAuthorityContext,
  AgentContext,
  FlexibleClientContext,
} from '../types'
import type { ClientToolContext } from '../runtime/tool-runtime'

// =============================================================================
// BROWSER CONTEXT TYPE (for waitFor pattern)
// =============================================================================

/**
 * Browser context - has waitFor for UI interactions.
 * This extends ClientToolContext with required waitFor.
 */
interface BrowserClientContext extends ClientToolContext {
  waitFor<Req, Res>(type: string, payload: Req): Operation<Res>
}

// =============================================================================
// TYPE NOTES
// =============================================================================
//
// The `as any` casts in test calls are expected and safe:
//
// 1. `serverOutput as any` - The handoff data type is erased at runtime.
//    Tools cast it internally (e.g., `handoffData as unknown as {...}`).
//
// 2. `ctx as any` - BrowserClientContext and AgentContext both extend
//    ClientToolContext, but the tool's type signature expects the base type.
//    The cast is safe because we're passing a compatible supertype.
//
// This is the intended design: tools check for optional capabilities
// (ctx.prompt, ctx.waitFor) at runtime, not compile time.
//

// =============================================================================
// MOCK IMPLEMENTATIONS
// =============================================================================

/**
 * Base mock context with no-op implementations of required ClientToolContext methods.
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
): BrowserClientContext {
  return {
    ...createBaseMockContext(callId),
    waitFor<Req, Res>(type: string, _payload: Req): Operation<Res> {
      return function* () {
        const response = responses.get(type)
        if (response === undefined) {
          throw new Error(`No mock response for waitFor type: ${type}`)
        }
        return response as Res
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
): AgentContext {
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
    // emit is optional, so we don't need to provide it
  }
}

// =============================================================================
// TEST TOOLS
// =============================================================================

/**
 * A tool that works in BOTH browser and agent contexts.
 *
 * - In browser: uses waitFor to get user choice
 * - As agent: uses prompt to ask LLM for choice
 */
const choiceAnalyzerTool = defineIsomorphicTool({
  name: 'choice_analyzer',
  description: 'Analyzes a set of choices and picks the best one',
  parameters: z.object({
    choices: z.array(z.string()),
    criteria: z.string(),
  }),
  authority: 'server',

  *server(params, ctx: ServerAuthorityContext) {
    return yield* ctx.handoff({
      *before() {
        return {
          choices: params.choices,
          criteria: params.criteria,
          timestamp: Date.now(),
        }
      },
      *after(handoff, clientResult: { selected: string; reasoning?: string }) {
        return {
          choices: handoff.choices,
          criteria: handoff.criteria,
          selected: clientResult.selected,
          reasoning: clientResult.reasoning ?? 'No reasoning provided',
          decidedAt: Date.now(),
        }
      },
    })
  },

  // The flexible client - works in both environments
  // Note: We cast ctx to FlexibleClientContext since the tool definition types
  // ctx as ClientToolContext, but at runtime it may have additional capabilities
  // (prompt, emit) depending on the execution environment.
  *client(handoffData, ctx, _params) {
    // Cast handoff data (TypeScript infers after()'s return type, not before()'s)
    const data = handoffData as unknown as {
      choices: string[]
      criteria: string
    }
    // Cast ctx to flexible - it may have prompt (agent) or waitFor (browser)
    const flexCtx = ctx as FlexibleClientContext

    // Check what capabilities we have
    if (flexCtx.prompt) {
      // Agent mode - use LLM
      const result = yield* flexCtx.prompt({
        prompt: `Given criteria "${data.criteria}", pick the best choice from: ${data.choices.join(', ')}`,
        schema: z.object({
          selected: z.string(),
          reasoning: z.string(),
        }),
      })
      return result
    }

    if (flexCtx.waitFor) {
      // Browser mode - ask user
      const result = yield* flexCtx.waitFor<
        { choices: string[]; criteria: string },
        { selected: string }
      >('pick-choice', {
        choices: data.choices,
        criteria: data.criteria,
      })
      return { selected: result.selected }
    }

    // Fallback - just pick first
    return { selected: data.choices[0] }
  },
})

/**
 * A tool that demonstrates agent-only capabilities (nested prompts, spawning)
 */
const researchAgentTool = defineIsomorphicTool({
  name: 'research_agent',
  description: 'Researches a topic using multiple LLM calls',
  parameters: z.object({
    topic: z.string(),
    depth: z.enum(['shallow', 'deep']).default('shallow'),
  }),
  authority: 'server',

  *server(params, ctx: ServerAuthorityContext) {
    return yield* ctx.handoff({
      *before() {
        return { topic: params.topic, depth: params.depth }
      },
      *after(
        _handoff,
        result: { findings: string[]; sources: string[]; confidence: number }
      ) {
        return {
          summary: result.findings.join('. '),
          sourceCount: result.sources.length,
          confidence: result.confidence,
        }
      },
    })
  },

  *client(handoffData, ctx, _params) {
    const data = handoffData as unknown as { topic: string; depth: string }
    const agentCtx = ctx as unknown as AgentContext

    if (!agentCtx.prompt) {
      throw new Error('research_agent requires agent context with prompt capability')
    }

    // Initial research
    const initial = yield* agentCtx.prompt({
      prompt: `Research topic: ${data.topic}. Provide key findings.`,
      schema: z.object({
        findings: z.array(z.string()),
        needsMoreResearch: z.boolean(),
      }),
    })

    let allFindings = [...initial.findings]
    const sources = ['initial-research']

    // Deep research if requested
    if (data.depth === 'deep' && initial.needsMoreResearch) {
      const deeper = yield* agentCtx.prompt({
        prompt: `Dive deeper into: ${data.topic}. Build on: ${initial.findings.join(', ')}`,
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
      confidence: data.depth === 'deep' ? 0.9 : 0.7,
    }
  },
})

/**
 * A tool that demonstrates parallel sub-agent execution
 */
const parallelAnalysisTool = defineIsomorphicTool({
  name: 'parallel_analysis',
  description: 'Analyzes a topic from multiple perspectives in parallel',
  parameters: z.object({
    topic: z.string(),
  }),
  authority: 'server',

  *server(params, ctx: ServerAuthorityContext) {
    return yield* ctx.handoff({
      *before() {
        return { topic: params.topic }
      },
      *after(
        _handoff,
        result: {
          technical: string
          business: string
          user: string
        }
      ) {
        return {
          analysis: result,
          perspectives: 3,
        }
      },
    })
  },

  *client(handoffData, ctx, _params) {
    const data = handoffData as unknown as { topic: string }
    const agentCtx = ctx as unknown as AgentContext

    if (!agentCtx.prompt) {
      throw new Error('parallel_analysis requires agent context')
    }

    // Spawn parallel analysis tasks
    const technicalTask = yield* spawn(function* () {
      return yield* agentCtx.prompt({
        prompt: `Analyze "${data.topic}" from a technical perspective`,
        schema: z.object({ analysis: z.string() }),
      })
    })

    const businessTask = yield* spawn(function* () {
      return yield* agentCtx.prompt({
        prompt: `Analyze "${data.topic}" from a business perspective`,
        schema: z.object({ analysis: z.string() }),
      })
    })

    const userTask = yield* spawn(function* () {
      return yield* agentCtx.prompt({
        prompt: `Analyze "${data.topic}" from a user perspective`,
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
})

// =============================================================================
// TESTS
// =============================================================================

describe('Agent Context Exploration', () => {
  const signal = new AbortController().signal

  describe('Same tool, different contexts', () => {
    it('works with browser context (waitFor)', function* () {
      // Set up mock browser context
      const responses = new Map<string, unknown>([
        ['pick-choice', { selected: 'Option B' }],
      ])

      // Phase 1
      const phase1 = yield* executeServerPart(
        choiceAnalyzerTool,
        'call-1',
        { choices: ['Option A', 'Option B', 'Option C'], criteria: 'best value' },
        signal
      )
      expect(phase1.kind).toBe('handoff')
      if (phase1.kind !== 'handoff') throw new Error('Expected handoff')

      // Simulate browser client execution
      const browserCtx = createMockBrowserContext('call-1', responses)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const clientResult = (yield* choiceAnalyzerTool.client!(
        phase1.serverOutput as any,
        browserCtx as any,
        { choices: ['Option A', 'Option B', 'Option C'], criteria: 'best value' }
      )) as { selected: string }

      expect(clientResult).toEqual({ selected: 'Option B' })

      // Phase 2
      const result = (yield* executeServerPhase2(
        choiceAnalyzerTool,
        'call-1',
        { choices: ['Option A', 'Option B', 'Option C'], criteria: 'best value' },
        clientResult,
        phase1.serverOutput,
        signal,
        true
      )) as { selected: string; reasoning: string }

      expect(result.selected).toBe('Option B')
      expect(result.reasoning).toBe('No reasoning provided')
    })

    it('works with agent context (prompt)', function* () {
      // Set up mock agent context with LLM responses
      const llmResponses = new Map<string, unknown>([
        [
          'best value',
          { selected: 'Option A', reasoning: 'Best price to quality ratio' },
        ],
      ])

      // Phase 1
      const phase1 = yield* executeServerPart(
        choiceAnalyzerTool,
        'call-1',
        { choices: ['Option A', 'Option B', 'Option C'], criteria: 'best value' },
        signal
      )
      expect(phase1.kind).toBe('handoff')
      if (phase1.kind !== 'handoff') throw new Error('Expected handoff')

      // Simulate agent execution
      const agentCtx = createMockAgentContext('call-1', llmResponses)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const clientResult = (yield* choiceAnalyzerTool.client!(
        phase1.serverOutput as any,
        agentCtx as any,
        { choices: ['Option A', 'Option B', 'Option C'], criteria: 'best value' }
      )) as { selected: string; reasoning: string }

      expect(clientResult.selected).toBe('Option A')
      expect(clientResult.reasoning).toBe('Best price to quality ratio')

      // Phase 2
      const result = (yield* executeServerPhase2(
        choiceAnalyzerTool,
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

      // Phase 1
      const phase1 = yield* executeServerPart(
        researchAgentTool,
        'call-1',
        { topic: 'AI agents', depth: 'deep' },
        signal
      )
      if (phase1.kind !== 'handoff') throw new Error('Expected handoff')

      // Execute agent
      const agentCtx = createMockAgentContext('call-1', llmResponses)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const clientResult = (yield* researchAgentTool.client!(
        phase1.serverOutput as any,
        agentCtx as any,
        { topic: 'AI agents', depth: 'deep' }
      )) as { findings: string[]; sources: string[]; confidence: number }

      expect(clientResult.findings).toEqual(['Finding 1', 'Finding 2', 'Deep finding 1'])
      expect(clientResult.sources).toEqual(['initial-research', 'deep-research'])
      expect(clientResult.confidence).toBe(0.9)

      // Phase 2
      const result = (yield* executeServerPhase2(
        researchAgentTool,
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

      // Phase 1
      const phase1 = yield* executeServerPart(
        parallelAnalysisTool,
        'call-1',
        { topic: 'New feature X' },
        signal
      )
      if (phase1.kind !== 'handoff') throw new Error('Expected handoff')

      // Execute agent (parallel tasks)
      const agentCtx = createMockAgentContext('call-1', llmResponses)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const clientResult = (yield* parallelAnalysisTool.client!(
        phase1.serverOutput as any,
        agentCtx as any,
        { topic: 'New feature X' }
      )) as { technical: string; business: string; user: string }

      expect(clientResult.technical).toBe('Technically complex but feasible')
      expect(clientResult.business).toBe('Strong market potential')
      expect(clientResult.user).toBe('Users would love this')

      // Phase 2
      const result = (yield* executeServerPhase2(
        parallelAnalysisTool,
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
      // Tool that emits progress
      const progressTool = defineIsomorphicTool({
        name: 'progress_tool',
        description: 'Tool that emits progress',
        parameters: z.object({ steps: z.number() }),
        authority: 'server',

        *server(params, ctx: ServerAuthorityContext) {
          return yield* ctx.handoff({
            *before() {
              return { steps: params.steps }
            },
            *after(_handoff, result: { completed: number }) {
              return { done: true, completed: result.completed }
            },
          })
        },

        *client(handoffData, ctx, _params) {
          const data = handoffData as unknown as { steps: number }
          const agentCtx = ctx as unknown as AgentContext

          for (let i = 1; i <= data.steps; i++) {
            if (agentCtx.emit) {
              yield* agentCtx.emit({ type: 'progress', step: i, total: data.steps })
            }
          }

          return { completed: data.steps }
        },
      })

      // Simpler approach: collect events synchronously via emit callback
      const events: unknown[] = []

      // Create a mock agent context with a simple emit that captures events
      const agentCtx: AgentContext = {
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
      const phase1 = yield* executeServerPart(progressTool, 'call-1', { steps: 3 }, signal)
      if (phase1.kind !== 'handoff') throw new Error('Expected handoff')

      // Execute with emit capability
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const clientResult = (yield* progressTool.client!(
        phase1.serverOutput as any,
        agentCtx as any,
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
    const innerAgentTool = defineIsomorphicTool({
      name: 'inner_agent',
      description: 'Does specific work',
      parameters: z.object({ task: z.string() }),
      authority: 'server',

      *server(params, ctx: ServerAuthorityContext) {
        return yield* ctx.handoff({
          *before() {
            return { task: params.task }
          },
          *after(_handoff, result: { output: string }) {
            return { completed: true, output: result.output }
          },
        })
      },

      *client(handoffData, ctx, _params) {
        const data = handoffData as unknown as { task: string }
        const agentCtx = ctx as unknown as AgentContext

        const result = yield* agentCtx.prompt({
          prompt: `Execute task: ${data.task}`,
          schema: z.object({ output: z.string() }),
        })

        return { output: result.output }
      },
    })

    // Outer agent - orchestrates multiple inner agents
    const outerAgentTool = defineIsomorphicTool({
      name: 'outer_agent',
      description: 'Orchestrates multiple tasks',
      parameters: z.object({ tasks: z.array(z.string()) }),
      authority: 'server',

      *server(params, ctx: ServerAuthorityContext) {
        return yield* ctx.handoff({
          *before() {
            return { tasks: params.tasks }
          },
          *after(_handoff, result: { results: string[] }) {
            return { allDone: true, results: result.results }
          },
        })
      },

      *client(handoffData, ctx, _params) {
        const data = handoffData as unknown as { tasks: string[] }
        const agentCtx = ctx as unknown as AgentContext

        // Execute inner agents in parallel using spawn + all pattern
        function* executeInner(task: string) {
          // Execute inner agent's full lifecycle
          const innerPhase1 = yield* executeServerPart(
            innerAgentTool,
            `inner-${task}`,
            { task },
            agentCtx.signal
          )
          if (innerPhase1.kind !== 'handoff') throw new Error('Expected handoff')

          // Run inner agent's client with same ctx
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const innerClientResult = yield* innerAgentTool.client!(
            innerPhase1.serverOutput as any,
            agentCtx as any,
            { task }
          )

          // Complete inner agent
          const innerResult = (yield* executeServerPhase2(
            innerAgentTool,
            `inner-${task}`,
            { task },
            innerClientResult,
            innerPhase1.serverOutput,
            agentCtx.signal,
            true
          )) as { completed: boolean; output: string }

          return innerResult
        }

        const results = (yield* all(data.tasks.map((t) => executeInner(t)))) as { completed: boolean; output: string }[]
        return { results: results.map((r) => r.output) }
      },
    })

    // Set up mock responses for all tasks
    const llmResponses = new Map<string, unknown>([
      ['task A', { output: 'Result A' }],
      ['task B', { output: 'Result B' }],
      ['task C', { output: 'Result C' }],
    ])

    // Execute outer agent
    const phase1 = yield* executeServerPart(
      outerAgentTool,
      'outer-1',
      { tasks: ['task A', 'task B', 'task C'] },
      signal
    )
    if (phase1.kind !== 'handoff') throw new Error('Expected handoff')

    const agentCtx = createMockAgentContext('outer-1', llmResponses)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const clientResult = (yield* outerAgentTool.client!(
      phase1.serverOutput as any,
      agentCtx as any,
      { tasks: ['task A', 'task B', 'task C'] }
    )) as { results: string[] }

    expect(clientResult).toEqual({
      results: ['Result A', 'Result B', 'Result C'],
    })

    // Complete outer agent
    const result = (yield* executeServerPhase2(
      outerAgentTool,
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
