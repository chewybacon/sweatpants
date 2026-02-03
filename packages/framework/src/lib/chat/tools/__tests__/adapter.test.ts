/**
 * MCP Adapter Tests
 */
import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { createTool } from '../builder.ts'
import { toMcpTool, isUnifiedTool } from '../adapters/mcp.ts'

describe('toMcpTool adapter', () => {
  describe('execute pattern', () => {
    it('converts simple execute tool to MCP format', () => {
      const tool = createTool('calculator')
        .description('Calculate expression')
        .parameters(z.object({ expr: z.string() }))
        .execute(function* (params) {
          return { result: params.expr }
        })

      const mcpTool = toMcpTool(tool)

      expect(mcpTool.name).toBe('calculator')
      expect(mcpTool.description).toBe('Calculate expression')
      expect(mcpTool.execute).toBeDefined()
      expect(mcpTool.elicits).toEqual({})
    })

    it('converts execute tool with elicits', () => {
      const tool = createTool('picker')
        .description('Pick something')
        .parameters(z.object({}))
        .elicit('pick', z.object({ choice: z.string() }))
        .execute(function* () {
          return { result: 'done' }
        })

      const mcpTool = toMcpTool(tool)

      expect(mcpTool.elicits).toHaveProperty('pick')
      expect(mcpTool.elicits['pick']).toHaveProperty('response')
    })
  })

  describe('handoff pattern', () => {
    it('converts handoff tool to MCP format', () => {
      const tool = createTool('game')
        .description('Play a game')
        .parameters(z.object({}))
        .handoff({
          *before() {
            return { state: 'ready' }
          },
          *client(handoff) {
            return { played: true }
          },
          *after(handoff, client) {
            return { result: client.played ? 'win' : 'lose' }
          },
        })

      const mcpTool = toMcpTool(tool)

      expect(mcpTool.name).toBe('game')
      expect(mcpTool.handoffConfig).toBeDefined()
      expect(mcpTool.handoffConfig?.before).toBeDefined()
      expect(mcpTool.handoffConfig?.client).toBeDefined()
      expect(mcpTool.handoffConfig?.after).toBeDefined()
    })

    it('converts handoff tool with elicits', () => {
      const tool = createTool('picker')
        .description('Pick something')
        .parameters(z.object({}))
        .elicit('pick', z.object({ choice: z.string() }))
        .elicit('confirm', z.object({ ok: z.boolean() }))
        .handoff({
          *before() {
            return { options: ['a', 'b'] }
          },
          *client(handoff) {
            return { picked: 'a' }
          },
          *after(handoff, client) {
            return { result: client.picked }
          },
        })

      const mcpTool = toMcpTool(tool)

      expect(Object.keys(mcpTool.elicits)).toHaveLength(2)
      expect(mcpTool.elicits['pick']).toHaveProperty('response')
      expect(mcpTool.elicits['confirm']).toHaveProperty('response')
    })
  })

  describe('limits', () => {
    it('preserves limits in conversion', () => {
      const tool = createTool('limited')
        .description('Limited tool')
        .parameters(z.object({}))
        .limits({ maxTokens: 1000, timeout: 30000 })
        .execute(function* () {
          return {}
        })

      const mcpTool = toMcpTool(tool)

      expect(mcpTool.limits).toEqual({ maxTokens: 1000, timeout: 30000 })
    })
  })
})

describe('isUnifiedTool', () => {
  it('returns true for execute tools', () => {
    const tool = createTool('test')
      .description('Test')
      .parameters(z.object({}))
      .execute(function* () {
        return {}
      })

    expect(isUnifiedTool(tool)).toBe(true)
  })

  it('returns true for handoff tools', () => {
    const tool = createTool('test')
      .description('Test')
      .parameters(z.object({}))
      .handoff({
        *before() {
          return {}
        },
        *client() {
          return {}
        },
        *after() {
          return {}
        },
      })

    expect(isUnifiedTool(tool)).toBe(true)
  })

  it('returns false for non-tools', () => {
    expect(isUnifiedTool(null)).toBe(false)
    expect(isUnifiedTool(undefined)).toBe(false)
    expect(isUnifiedTool({})).toBe(false)
    expect(isUnifiedTool({ mode: 'invalid' })).toBe(false)
  })
})
