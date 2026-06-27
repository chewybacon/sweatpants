import { describe, expect, it } from 'vitest'
import { run } from 'effection'
import { z } from 'zod'
import { createMcpTool, SampleValidationError } from '../index.ts'
import type { Operation } from 'effection'
import type { UnifiedToolCtxShape } from '../mcp-tool-builder.ts'

type SampleCall = Record<string, unknown>

type TestCtx = UnifiedToolCtxShape & {
  sampleCalls: SampleCall[]
}

function op<T>(fn: () => T): Operation<T> {
  return {
    *[Symbol.iterator]() {
      return fn()
    },
  }
}

function baseCtx(overrides: Partial<UnifiedToolCtxShape> = {}): TestCtx {
  const ctx = {
    sampleCalls: [] as SampleCall[],
    sample(options: Record<string, unknown>): Operation<Record<string, unknown>> {
      return op(() => {
        ctx.sampleCalls.push(options)
        return { content: 'default sample' }
      })
    },
    elicit(): Operation<Record<string, unknown>> {
      return op(() => ({ action: 'cancel' }))
    },
    notify(): Operation<void> {
      return op(() => undefined)
    },
    ...overrides,
  } satisfies TestCtx

  return ctx
}

function strategyTool() {
  return createMcpTool('shim_sample_tools_test')
    .description('Test sampleTools through unified shim')
    .parameters(z.object({}))
    .elicits({})
    .execute(function* (_params, ctx) {
      const result = yield* ctx.sampleTools({
        prompt: 'Choose a strategy',
        tools: [
          {
            name: 'choose_strategy',
            description: 'Choose strategy',
            inputSchema: z.object({ reasoning: z.string() }),
          },
        ],
      })
      return {
        text: result.text,
        stopReason: result.stopReason,
        firstCall: result.toolCalls[0],
      }
    })
}

function invokeTool(tool: ReturnType<typeof strategyTool>, ctx: UnifiedToolCtxShape): Operation<unknown> {
  return {
    *[Symbol.iterator]() {
      const invoke = yield* tool(ctx)
      return yield* invoke({})
    },
  }
}

describe('unified MCP shim sample helpers', () => {
  describe('sampleTools sugar', () => {
    it('executes sampleTools as sugar over sample without the unsupported shim error', async () => {
      const ctx = baseCtx({
        sample(options: Record<string, unknown>) {
          return op(() => {
            ctx.sampleCalls.push(options)
            return {
              content: 'I will choose a strategy',
              toolCalls: [
                { id: 'call-1', name: 'choose_strategy', arguments: { reasoning: 'center control' } },
              ],
            }
          })
        },
      })

      const result = await run(function* () {
        return yield* invokeTool(strategyTool(), ctx)
      })

      expect(result).toEqual({
        text: 'I will choose a strategy',
        stopReason: 'toolUse',
        firstCall: { id: 'call-1', name: 'choose_strategy', arguments: { reasoning: 'center control' } },
      })
      expect(ctx.sampleCalls).toHaveLength(1)
      expect(ctx.sampleCalls[0]).toMatchObject({ prompt: 'Choose a strategy', toolChoice: 'required' })
    })

    it('preserves explicit sampleTools options and tool definitions when calling sample', async () => {
      const ctx = baseCtx({
        sample(options: Record<string, unknown>) {
          return op(() => {
            ctx.sampleCalls.push(options)
            return {
              text: 'ok',
              toolCalls: [{ id: 'call-1', name: 'play_offensive', arguments: { reasoning: 'win' } }],
            }
          })
        },
      })

      const tool = createMcpTool('option_preservation')
        .description('Option preservation')
        .parameters(z.object({}))
        .elicits({})
        .execute(function* (_params, mcpCtx) {
          return yield* mcpCtx.sampleTools({
            prompt: 'pick',
            systemPrompt: 'system',
            maxTokens: 123,
            modelPreferences: { speedPriority: 1 },
            toolChoice: 'auto',
            retries: 5,
            tools: [
              {
                name: 'play_offensive',
                description: 'Go win',
                inputSchema: {
                  type: 'object',
                  properties: { reasoning: { type: 'string' } },
                  required: ['reasoning'],
                },
              },
            ],
          })
        })

      await run(function* () {
        const invoke = yield* tool(ctx)
        return yield* invoke({})
      })

      expect(ctx.sampleCalls).toHaveLength(1)
      expect(ctx.sampleCalls[0]).toMatchObject({
        prompt: 'pick',
        systemPrompt: 'system',
        maxTokens: 123,
        modelPreferences: { speedPriority: 1 },
        toolChoice: 'auto',
      })
      expect(ctx.sampleCalls[0]).not.toHaveProperty('retries')
      expect(ctx.sampleCalls[0]?.tools).toEqual([
        {
          name: 'play_offensive',
          description: 'Go win',
          inputSchema: {
            type: 'object',
            properties: { reasoning: { type: 'string' } },
            required: ['reasoning'],
          },
        },
      ])
    })

    it.each([
      { retries: undefined, attempts: 3 },
      { retries: 0, attempts: 1 },
      { retries: 3, attempts: 4 },
    ])('throws SampleValidationError after $attempts sampleTools attempts', async ({ retries, attempts }) => {
      const ctx = baseCtx({
        sample(options: Record<string, unknown>) {
          return op(() => {
            ctx.sampleCalls.push(options)
            return { content: 'no tool call' }
          })
        },
      })

      const tool = createMcpTool('retry_failure')
        .description('Retry failure')
        .parameters(z.object({}))
        .elicits({})
        .execute(function* (_params, mcpCtx) {
          return yield* mcpCtx.sampleTools({
            prompt: 'must call a tool',
            tools: [{ name: 'choose', inputSchema: z.object({}) }],
            ...(retries === undefined ? {} : { retries }),
          })
        })

      await expect(run(function* () {
        const invoke = yield* tool(ctx)
        return yield* invoke({})
      })).rejects.toMatchObject({
        name: 'SampleValidationError',
        helperName: 'sampleTools',
        attempts,
      })
      expect(ctx.sampleCalls).toHaveLength(attempts)
      if (attempts > 1) {
        expect(ctx.sampleCalls[1]?.prompt).toContain('must call one of the available tools')
      }
    })

    it('stops retrying once sampleTools receives a tool call from sample', async () => {
      const ctx = baseCtx({
        sample(options: Record<string, unknown>) {
          return op(() => {
            ctx.sampleCalls.push(options)
            if (ctx.sampleCalls.length === 1) return { content: 'not yet' }
            return {
              text: 'now using a tool',
              toolCalls: [{ id: 'call-2', name: 'choose', arguments: {} }],
            }
          })
        },
      })

      const tool = createMcpTool('retry_success')
        .description('Retry success')
        .parameters(z.object({}))
        .elicits({})
        .execute(function* (_params, mcpCtx) {
          return yield* mcpCtx.sampleTools({
            prompt: 'choose',
            retries: 3,
            tools: [{ name: 'choose', inputSchema: z.object({}) }],
          })
        })

      const result = await run(function* () {
        const invoke = yield* tool(ctx)
        return yield* invoke({})
      })

      expect(ctx.sampleCalls).toHaveLength(2)
      expect(result).toMatchObject({ stopReason: 'toolUse', toolCalls: [{ id: 'call-2', name: 'choose', arguments: {} }] })
    })

    it('normalizes OpenAI-style raw tool_calls with JSON object arguments', async () => {
      const ctx = baseCtx({
        sample(options: Record<string, unknown>) {
          return op(() => {
            ctx.sampleCalls.push(options)
            return {
              text: '',
              raw: {
                tool_calls: [
                  {
                    id: 'raw-1',
                    function: {
                      name: 'choose_strategy',
                      arguments: '{"reasoning":"raw json"}',
                    },
                  },
                ],
              },
            }
          })
        },
      })

      const result = await run(function* () {
        return yield* invokeTool(strategyTool(), ctx)
      })

      expect(result).toMatchObject({
        stopReason: 'toolUse',
        firstCall: { id: 'raw-1', name: 'choose_strategy', arguments: { reasoning: 'raw json' } },
      })
    })

    it('does not synthesize tool calls from malformed calls or prose', async () => {
      const malformedResults = [
        { text: 'I choose choose_strategy with reasoning prose' },
        { text: '', toolCalls: [{ id: 'missing-name', arguments: {} }] },
        { text: '', toolCalls: [{ id: 'bad-json', name: 'choose_strategy', arguments: '{nope' }] },
        { text: '', toolCalls: [{ id: 'array-args', name: 'choose_strategy', arguments: [] }] },
      ]

      for (const sampleResult of malformedResults) {
        const ctx = baseCtx({
          sample(options: Record<string, unknown>) {
            return op(() => {
              ctx.sampleCalls.push(options)
              return sampleResult
            })
          },
        })

        await expect(run(function* () {
          return yield* invokeTool(strategyTool(), ctx)
        })).rejects.toBeInstanceOf(SampleValidationError)
      }
    })

    it('rejects sampleTools configs without prompt or messages', async () => {
      const ctx = baseCtx()
      const tool = createMcpTool('invalid_config')
        .description('Invalid config')
        .parameters(z.object({}))
        .elicits({})
        .execute(function* (_params, mcpCtx) {
          return yield* mcpCtx.sampleTools({
            tools: [{ name: 'choose', inputSchema: z.object({}) }],
          } as never)
        })

      await expect(run(function* () {
        const invoke = yield* tool(ctx)
        return yield* invoke({})
      })).rejects.toThrow(/requires either prompt or messages/)
    })
  })

  describe('sampleSchema sugar', () => {
    it('executes sampleSchema as sugar over sample and returns parsed output', async () => {
      const schema = z.object({ move: z.number() })
      const ctx = baseCtx({
        sample(options: Record<string, unknown>) {
          return op(() => {
            ctx.sampleCalls.push(options)
            return { content: '{"move":4}', parsed: { move: 4 } }
          })
        },
      })

      const tool = createMcpTool('schema_success')
        .description('Schema success')
        .parameters(z.object({}))
        .elicits({})
        .execute(function* (_params, mcpCtx) {
          return yield* mcpCtx.sampleSchema({ prompt: 'pick move', schema, retries: 5 })
        })

      const result = await run(function* () {
        const invoke = yield* tool(ctx)
        return yield* invoke({})
      })

      expect(result).toMatchObject({ text: '{"move":4}', parsed: { move: 4 } })
      expect(ctx.sampleCalls).toHaveLength(1)
      expect(ctx.sampleCalls[0]).toMatchObject({ prompt: 'pick move', schema })
      expect(ctx.sampleCalls[0]).not.toHaveProperty('retries')
    })

    it('retries sampleSchema until sample returns parsed output', async () => {
      const ctx = baseCtx({
        sample(options: Record<string, unknown>) {
          return op(() => {
            ctx.sampleCalls.push(options)
            if (ctx.sampleCalls.length === 1) {
              return { content: 'not json', parsed: null, parseError: { message: 'invalid json', rawText: 'not json' } }
            }
            return { content: '{"move":4}', parsed: { move: 4 } }
          })
        },
      })

      const tool = createMcpTool('schema_retry')
        .description('Schema retry')
        .parameters(z.object({}))
        .elicits({})
        .execute(function* (_params, mcpCtx) {
          return yield* mcpCtx.sampleSchema({
            prompt: 'pick move',
            schema: z.object({ move: z.number() }),
            retries: 3,
          })
        })

      const result = await run(function* () {
        const invoke = yield* tool(ctx)
        return yield* invoke({})
      })

      expect(result).toMatchObject({ parsed: { move: 4 } })
      expect(ctx.sampleCalls).toHaveLength(2)
      expect(ctx.sampleCalls[1]?.prompt).toContain('valid JSON matching the schema')
    })

    it.each([
      { retries: undefined, attempts: 3 },
      { retries: 0, attempts: 1 },
      { retries: 2, attempts: 3 },
    ])('throws SampleValidationError after $attempts sampleSchema attempts', async ({ retries, attempts }) => {
      const ctx = baseCtx({
        sample(options: Record<string, unknown>) {
          return op(() => {
            ctx.sampleCalls.push(options)
            return { content: 'bad', parsed: null, parseError: { message: 'bad json', rawText: 'bad' } }
          })
        },
      })

      const tool = createMcpTool('schema_failure')
        .description('Schema failure')
        .parameters(z.object({}))
        .elicits({})
        .execute(function* (_params, mcpCtx) {
          return yield* mcpCtx.sampleSchema({
            prompt: 'pick move',
            schema: z.object({ move: z.number() }),
            ...(retries === undefined ? {} : { retries }),
          })
        })

      await expect(run(function* () {
        const invoke = yield* tool(ctx)
        return yield* invoke({})
      })).rejects.toMatchObject({
        name: 'SampleValidationError',
        helperName: 'sampleSchema',
        attempts,
      })
      expect(ctx.sampleCalls).toHaveLength(attempts)
    })

    it('rejects sampleSchema configs without prompt or messages', async () => {
      const ctx = baseCtx()
      const tool = createMcpTool('schema_invalid_config')
        .description('Schema invalid config')
        .parameters(z.object({}))
        .elicits({})
        .execute(function* (_params, mcpCtx) {
          return yield* mcpCtx.sampleSchema({ schema: z.object({ move: z.number() }) } as never)
        })

      await expect(run(function* () {
        const invoke = yield* tool(ctx)
        return yield* invoke({})
      })).rejects.toThrow(/requires either prompt or messages/)
    })
  })

  it('keeps plain sample, raw sample with tools, and branch sampleTools behavior compatible', async () => {
    const ctx = baseCtx({
      sample(options: Record<string, unknown>) {
        return op(() => {
          ctx.sampleCalls.push(options)
          if ('tools' in options) {
            return {
              content: 'tool sample',
              toolCalls: [{ id: 'raw-sample', name: 'choose', arguments: {} }],
            }
          }
          return { content: 'plain sample' }
        })
      },
    })

    const tool = createMcpTool('compat')
      .description('Compatibility')
      .parameters(z.object({}))
      .elicits({})
      .execute(function* (_params, mcpCtx) {
        const plain = yield* mcpCtx.sample({ prompt: 'plain' })
        const rawTools = yield* mcpCtx.sample({
          prompt: 'raw tools',
          tools: [{ name: 'choose', inputSchema: z.object({}) }],
        })
        const branched = yield* mcpCtx.branch(function* (branchCtx) {
          return yield* branchCtx.sampleTools({
            prompt: 'branch choose',
            tools: [{ name: 'choose', inputSchema: z.object({}) }],
          })
        })
        return { plain, rawTools, branched }
      })

    const result = await run(function* () {
      const invoke = yield* tool(ctx)
      return yield* invoke({})
    })

    expect(result).toMatchObject({
      plain: { text: 'plain sample', content: 'plain sample' },
      rawTools: { text: 'tool sample', toolCalls: [{ id: 'raw-sample', name: 'choose', arguments: {} }] },
      branched: { stopReason: 'toolUse', toolCalls: [{ id: 'raw-sample', name: 'choose', arguments: {} }] },
    })
  })
})
