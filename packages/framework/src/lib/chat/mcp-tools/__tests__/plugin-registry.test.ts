/**
 * Tests for Plugin Registry
 */
import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { createPluginRegistry, createPluginRegistryFrom } from '../plugin-registry'
import type { PluginClientRegistration } from '../plugin'
import type { ElicitsMap } from '../mcp-tool-types'

// Mock plugins for testing
function createMockPlugin(toolName: string): PluginClientRegistration<ElicitsMap> {
  const schema = z.object({ value: z.string() })
  return {
    toolName,
    handlers: {
      testKey: function* (_req, _ctx) {
        return { action: 'accept' as const, content: { value: 'test' } }
      },
    },
    schemas: {
      testKey: schema,
    },
  }
}

describe('createPluginRegistry', () => {
  it('creates an empty registry', () => {
    const registry = createPluginRegistry()
    expect(registry.size).toBe(0)
    expect(registry.toolNames()).toEqual([])
  })

  it('registers a plugin', () => {
    const registry = createPluginRegistry()
    const plugin = createMockPlugin('test_tool')

    registry.register(plugin)

    expect(registry.size).toBe(1)
    expect(registry.has('test_tool')).toBe(true)
    expect(registry.get('test_tool')).toBe(plugin)
  })

  it('registers multiple plugins', () => {
    const registry = createPluginRegistry()
    const plugin1 = createMockPlugin('tool_one')
    const plugin2 = createMockPlugin('tool_two')
    const plugin3 = createMockPlugin('tool_three')

    registry.register(plugin1)
    registry.register(plugin2)
    registry.register(plugin3)

    expect(registry.size).toBe(3)
    expect(registry.toolNames()).toContain('tool_one')
    expect(registry.toolNames()).toContain('tool_two')
    expect(registry.toolNames()).toContain('tool_three')
  })

  it('returns undefined for unknown tool name', () => {
    const registry = createPluginRegistry()
    registry.register(createMockPlugin('known_tool'))

    expect(registry.get('unknown_tool')).toBeUndefined()
    expect(registry.has('unknown_tool')).toBe(false)
  })

  it('throws on duplicate registration', () => {
    const registry = createPluginRegistry()
    const plugin1 = createMockPlugin('duplicate_tool')
    const plugin2 = createMockPlugin('duplicate_tool')

    registry.register(plugin1)

    expect(() => registry.register(plugin2)).toThrow(
      /already registered/
    )
  })
})

describe('createPluginRegistryFrom', () => {
  it('creates registry from empty array', () => {
    const registry = createPluginRegistryFrom([])
    expect(registry.size).toBe(0)
  })

  it('creates registry from array of plugins', () => {
    const plugins = [
      createMockPlugin('tool_a'),
      createMockPlugin('tool_b'),
      createMockPlugin('tool_c'),
    ]

    const registry = createPluginRegistryFrom(plugins)

    expect(registry.size).toBe(3)
    expect(registry.has('tool_a')).toBe(true)
    expect(registry.has('tool_b')).toBe(true)
    expect(registry.has('tool_c')).toBe(true)
  })

  it('throws on duplicate tool names in array', () => {
    const plugins = [
      createMockPlugin('same_name'),
      createMockPlugin('different_name'),
      createMockPlugin('same_name'),
    ]

    expect(() => createPluginRegistryFrom(plugins)).toThrow(
      /already registered/
    )
  })
})
