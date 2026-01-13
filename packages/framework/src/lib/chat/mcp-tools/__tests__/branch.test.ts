/**
 * Tests for branch-based tool execution
 */
import { describe, it, expect } from 'vitest'
import { run } from 'effection'
import { z } from 'zod'
import {
  createBranchTool,
  createMockBranchClient,
  runBranchToolMock,
  runBranchTool,
  BranchDepthError,
} from '../index.ts'

describe('createBranchTool', () => {
  it('creates a tool with basic properties', () => {
    const tool = createBranchTool('test_tool')
      .description('A test tool')
      .parameters(z.object({ input: z.string() }))
      .elicits({})
      .execute(function* (params) {
        return `Got: ${params.input}`
      })

    expect(tool.name).toBe('test_tool')
    expect(tool.description).toBe('A test tool')
    expect(tool.execute).toBeDefined()
  })

  it('creates a tool with handoff pattern', () => {
    const tool = createBranchTool('handoff_tool')
      .description('A handoff tool')
      .parameters(z.object({ input: z.string() }))
      .elicits({})
      .handoff({
        *before(params) {
          return { prepared: params.input.toUpperCase() }
        },
        *client(handoff, ctx) {
          const result = yield* ctx.sample({ prompt: handoff.prepared })
          return { response: result.text }
        },
        *after(handoff, client) {
          return `${handoff.prepared}: ${client.response}`
        },
      })

    expect(tool.name).toBe('handoff_tool')
    expect(tool.handoffConfig).toBeDefined()
  })

  it('supports limits configuration', () => {
    const tool = createBranchTool('limited_tool')
      .description('A limited tool')
      .parameters(z.object({}))
      .limits({ maxDepth: 3, maxTokens: 1000, timeout: 5000 })
      .elicits({})
      .execute(function* () {
        return 'done'
      })

    expect(tool.limits).toEqual({ maxDepth: 3, maxTokens: 1000, timeout: 5000 })
  })
})

describe('runBranchTool - simple execute', () => {
  it('executes a simple tool', async () => {
    const tool = createBranchTool('simple')
      .description('Simple tool')
      .parameters(z.object({ value: z.number() }))
      .elicits({})
      .execute(function* (params) {
        return params.value * 2
      })

    const result = await run(function* () {
      const client = createMockBranchClient()
      return yield* runBranchTool(tool, { value: 21 }, client)
    })

    expect(result).toBe(42)
  })

  it('executes tool with sampling', async () => {
    const tool = createBranchTool('sampler')
      .description('Sampling tool')
      .parameters(z.object({ prompt: z.string() }))
      .elicits({})
      .execute(function* (params, ctx) {
        const result = yield* ctx.sample({ prompt: params.prompt })
        return result.text
      })

    const result = await run(function* () {
      const { result, client } = yield* runBranchToolMock(
        tool,
        { prompt: 'Hello' },
        { sampleResponses: ['World'] }
      )

      expect(client.sampleCalls).toHaveLength(1)
      expect(client.sampleCalls[0].messages).toEqual([
        { role: 'user', content: 'Hello' },
      ])

      return result
    })

    expect(result).toBe('World')
  })

  it('tracks conversation with auto-tracked prompts', async () => {
    const tool = createBranchTool('multi_turn')
      .description('Multi-turn tool')
      .parameters(z.object({}))
      .elicits({})
      .execute(function* (params, ctx) {
        yield* ctx.sample({ prompt: 'First' })
        yield* ctx.sample({ prompt: 'Second' })
        yield* ctx.sample({ prompt: 'Third' })
        return ctx.messages
      })

    const result = await run(function* () {
      const { result, client } = yield* runBranchToolMock(
        tool,
        {},
        { sampleResponses: ['Response 1', 'Response 2', 'Response 3'] }
      )

      expect(client.sampleCalls).toHaveLength(3)
      return result
    })

    // Should have 6 messages: 3 user + 3 assistant
    expect(result).toHaveLength(6)
    expect(result[0]).toEqual({ role: 'user', content: 'First' })
    expect(result[1]).toEqual({ role: 'assistant', content: 'Response 1' })
    expect(result[4]).toEqual({ role: 'user', content: 'Third' })
    expect(result[5]).toEqual({ role: 'assistant', content: 'Response 3' })
  })

  it('supports explicit messages mode', async () => {
    const tool = createBranchTool('explicit')
      .description('Explicit messages tool')
      .parameters(z.object({}))
      .elicits({})
      .execute(function* (params, ctx) {
        const result = yield* ctx.sample({
          messages: [
            { role: 'system', content: 'You are helpful' },
            { role: 'user', content: 'Hi' },
          ],
        })
        // Explicit mode doesn't track messages
        return { response: result.text, messageCount: ctx.messages.length }
      })

    const result = await run(function* () {
      const { result, client } = yield* runBranchToolMock(
        tool,
        {},
        { sampleResponses: ['Hello!'] }
      )

      expect(client.sampleCalls[0].messages).toEqual([
        { role: 'system', content: 'You are helpful' },
        { role: 'user', content: 'Hi' },
      ])

      return result
    })

    expect(result.response).toBe('Hello!')
    expect(result.messageCount).toBe(0) // Not tracked
  })
})

describe('runBranchTool - elicitation', () => {
  it('handles accept response', async () => {
    const tool = createBranchTool('elicit')
      .description('Elicit tool')
      .parameters(z.object({}))
      .elicits({
        pickOne: z.object({ choice: z.string() }),
      })
      .execute(function* (_params, ctx) {
        const result = yield* ctx.elicit('pickOne', {
          message: 'Pick one',
        })
        return result
      })

    const result = await run(function* () {
      // Type assertion needed: runBranchToolMock doesn't have overload for keyed elicits
      const { result } = yield* runBranchToolMock(
        tool as any,
        {},
        { elicitResponses: [{ action: 'accept', content: { choice: 'A' } }] }
      )
      return result
    })

    expect(result).toEqual({ action: 'accept', content: { choice: 'A' } })
  })

  it('handles decline response', async () => {
    const tool = createBranchTool('elicit_decline')
      .description('Elicit tool')
      .parameters(z.object({}))
      .elicits({
        pickOne: z.object({ choice: z.string() }),
      })
      .execute(function* (_params, ctx) {
        const result = yield* ctx.elicit('pickOne', {
          message: 'Pick one',
        })
        return result.action
      })

    const result = await run(function* () {
      // Type assertion needed: runBranchToolMock doesn't have overload for keyed elicits
      const { result } = yield* runBranchToolMock(
        tool as any,
        {},
        { elicitResponses: [{ action: 'decline' }] }
      )
      return result
    })

    expect(result).toBe('decline')
  })
})

describe('runBranchTool - sub-branches', () => {
  it('executes a sub-branch', async () => {
    const tool = createBranchTool('branching')
      .description('Branching tool')
      .parameters(z.object({}))
      .elicits({})
      .execute(function* (params, ctx) {
        const main = yield* ctx.sample({ prompt: 'Main task' })

        const sub = yield* ctx.branch(function* (subCtx) {
          const result = yield* subCtx.sample({ prompt: 'Sub task' })
          return result.text
        })

        return { main: main.text, sub }
      })

    const result = await run(function* () {
      const { result, client } = yield* runBranchToolMock(
        tool,
        {},
        { sampleResponses: ['Main result', 'Sub result'] }
      )

      expect(client.sampleCalls).toHaveLength(2)
      return result
    })

    expect(result).toEqual({ main: 'Main result', sub: 'Sub result' })
  })

  it('inherits messages by default', async () => {
    const tool = createBranchTool('inherit')
      .description('Inheriting tool')
      .parameters(z.object({}))
      .elicits({})
      .execute(function* (params, ctx) {
        yield* ctx.sample({ prompt: 'Parent message' })

        const subMessages = yield* ctx.branch(function* (subCtx) {
          // Should see parent messages
          return [...subCtx.parentMessages]
        })

        return subMessages
      })

    const result = await run(function* () {
      const { result } = yield* runBranchToolMock(
        tool,
        {},
        { sampleResponses: ['Response'] }
      )
      return result
    })

    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({ role: 'user', content: 'Parent message' })
  })

  it('can start fresh with inheritMessages: false', async () => {
    const tool = createBranchTool('fresh')
      .description('Fresh branch tool')
      .parameters(z.object({}))
      .elicits({})
      .execute(function* (params, ctx) {
        yield* ctx.sample({ prompt: 'Parent' })

        const subMessages = yield* ctx.branch(
          function* (subCtx) {
            // Should NOT see parent messages in inherited context
            // But parentMessages is still available for reading
            return {
              inherited: [...subCtx.messages],
              parent: [...subCtx.parentMessages],
            }
          },
          { inheritMessages: false }
        )

        return subMessages
      })

    const result = await run(function* () {
      const { result } = yield* runBranchToolMock(
        tool,
        {},
        { sampleResponses: ['Response'] }
      )
      return result
    })

    expect(result.inherited).toHaveLength(0) // Fresh start
    expect(result.parent).toHaveLength(2) // Can still read parent
  })

  it('tracks depth correctly', async () => {
    const tool = createBranchTool('depth')
      .description('Depth tracking tool')
      .parameters(z.object({}))
      .elicits({})
      .execute(function* (params, ctx) {
        const depths: number[] = [ctx.depth]

        yield* ctx.branch(function* (sub1) {
          depths.push(sub1.depth)

          yield* sub1.branch(function* (sub2) {
            depths.push(sub2.depth)
          })
        })

        return depths
      })

    const result = await run(function* () {
      const { result } = yield* runBranchToolMock(tool, {})
      return result
    })

    expect(result).toEqual([0, 1, 2])
  })

  it('enforces depth limits', async () => {
    const tool = createBranchTool('limited')
      .description('Depth limited tool')
      .parameters(z.object({}))
      .limits({ maxDepth: 1 })
      .elicits({})
      .execute(function* (params, ctx) {
        yield* ctx.branch(function* (sub1) {
          // This should throw - depth 2 exceeds limit of 1
          yield* sub1.branch(function* (sub2) {
            return 'should not reach here'
          })
        })
        return 'done'
      })

    await expect(
      run(function* () {
        const { result } = yield* runBranchToolMock(tool, {})
        return result
      })
    ).rejects.toThrow(BranchDepthError)
  })

  it('allows override of depth limit per branch', async () => {
    const tool = createBranchTool('override')
      .description('Override limits tool')
      .parameters(z.object({}))
      .limits({ maxDepth: 1 })
      .elicits({})
      .execute(function* (params, ctx) {
        const result = yield* ctx.branch(
          function* (sub1) {
            // Now allowed because we overrode the limit
            return yield* sub1.branch(function* (sub2) {
              return sub2.depth
            })
          },
          { maxDepth: 3 }
        )
        return result
      })

    const result = await run(function* () {
      const { result } = yield* runBranchToolMock(tool, {})
      return result
    })

    expect(result).toBe(2)
  })
})

describe('runBranchTool - handoff pattern', () => {
  it('executes before/client/after phases', async () => {
    const phases: string[] = []

    const tool = createBranchTool('handoff')
      .description('Handoff tool')
      .parameters(z.object({ input: z.string() }))
      .elicits({})
      .handoff({
        *before(params) {
          phases.push('before')
          return { prepared: params.input.toUpperCase() }
        },
        *client(handoff, ctx) {
          phases.push('client')
          const result = yield* ctx.sample({ prompt: handoff.prepared })
          return { response: result.text }
        },
        *after(handoff, client) {
          phases.push('after')
          return `${handoff.prepared} -> ${client.response}`
        },
      })

    const result = await run(function* () {
      const { result } = yield* runBranchToolMock(
        tool,
        { input: 'hello' },
        { sampleResponses: ['world'] }
      )
      return result
    })

    expect(phases).toEqual(['before', 'client', 'after'])
    expect(result).toBe('HELLO -> world')
  })

  it('provides server context in before/after', async () => {
    let beforeCallId: string | undefined
    let afterCallId: string | undefined

    const tool = createBranchTool('context')
      .description('Context tool')
      .parameters(z.object({}))
      .elicits({})
      .handoff({
        *before(params, ctx) {
          beforeCallId = ctx.callId
          return {}
        },
        *client(handoff, ctx) {
          return {}
        },
        *after(handoff, client, ctx) {
          afterCallId = ctx.callId
          return 'done'
        },
      })

    await run(function* () {
      yield* runBranchToolMock(tool, {})
    })

    expect(beforeCallId).toBeDefined()
    expect(afterCallId).toBe(beforeCallId)
  })
})

describe('runBranchTool - logging', () => {
  it('sends log messages', async () => {
    const tool = createBranchTool('logger')
      .description('Logging tool')
      .parameters(z.object({}))
      .elicits({})
      .execute(function* (params, ctx) {
        yield* ctx.log('info', 'Starting')
        yield* ctx.log('debug', 'Processing')
        yield* ctx.log('error', 'Oops')
        return 'done'
      })

    const result = await run(function* () {
      const { client } = yield* runBranchToolMock(tool, {})
      return client.logCalls
    })

    expect(result).toEqual([
      { level: 'info', message: 'Starting' },
      { level: 'debug', message: 'Processing' },
      { level: 'error', message: 'Oops' },
    ])
  })

  it('sends progress notifications', async () => {
    const tool = createBranchTool('notifier')
      .description('Notification tool')
      .parameters(z.object({}))
      .elicits({})
      .execute(function* (params, ctx) {
        yield* ctx.notify('Starting...')
        yield* ctx.notify('Halfway there', 0.5)
        yield* ctx.notify('Done!', 1.0)
        return 'done'
      })

    const result = await run(function* () {
      const { client } = yield* runBranchToolMock(tool, {})
      return client.notifyCalls
    })

    expect(result).toEqual([
      { message: 'Starting...' },
      { message: 'Halfway there', progress: 0.5 },
      { message: 'Done!', progress: 1.0 },
    ])
  })
})

describe('runBranchTool - validation', () => {
  it('validates parameters', async () => {
    const tool = createBranchTool('validated')
      .description('Validated tool')
      .parameters(z.object({ count: z.number().min(1).max(10) }))
      .elicits({})
      .execute(function* (params) {
        return params.count
      })

    await expect(
      run(function* () {
        yield* runBranchToolMock(tool, { count: 0 })
      })
    ).rejects.toThrow(/Invalid params/)

    await expect(
      run(function* () {
        yield* runBranchToolMock(tool, { count: 11 })
      })
    ).rejects.toThrow(/Invalid params/)

    const result = await run(function* () {
      const { result } = yield* runBranchToolMock(tool, { count: 5 })
      return result
    })
    expect(result).toBe(5)
  })
})

describe('dynamic sample responses', () => {
  it('supports function responses', async () => {
    const tool = createBranchTool('dynamic')
      .description('Dynamic response tool')
      .parameters(z.object({}))
      .elicits({})
      .execute(function* (params, ctx) {
        const result = yield* ctx.sample({ prompt: 'Count messages' })
        return result.text
      })

    const result = await run(function* () {
      const { result } = yield* runBranchToolMock(
        tool,
        {},
        {
          sampleResponses: [
            (messages) => `Got ${messages.length} messages`,
          ],
        }
      )
      return result
    })

    expect(result).toBe('Got 1 messages')
  })
})
