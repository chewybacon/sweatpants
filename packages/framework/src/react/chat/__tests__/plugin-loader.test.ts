/**
 * plugin-loader.test.ts
 *
 * Unit tests for the plugin loader (DAG resolution, settler negotiation, preload).
 */
import { describe, it, expect, vi } from 'vitest'
import { run } from 'effection'
import type { ProcessorPlugin } from '../plugins/types'
import {
  resolvePlugins,
  preloadPlugins,
  arePluginsReady,
  loadPlugins,
  CircularDependencyError,
  MissingDependencyError,
  DuplicatePluginError,
} from '../plugins/loader'

// Helper to create a minimal plugin
function plugin(
  name: string,
  opts: Partial<Omit<ProcessorPlugin, 'name' | 'processor'>> = {}
): ProcessorPlugin {
  return {
    name,
    processor: () =>
      function* () {
        /* noop */
      },
    ...opts,
  }
}

describe('plugin-loader', () => {
  describe('resolvePlugins', () => {
    it('should return empty result for empty input', () => {
      const result = resolvePlugins([])
      expect(result.plugins).toEqual([])
      expect(result.settler).toBe('paragraph')
      expect(result.processors).toEqual([])
    })

    it('should return single plugin unchanged', () => {
      const p = plugin('test')
      const result = resolvePlugins([p])
      expect(result.plugins).toEqual([p])
      expect(result.settler).toBe('paragraph')
      expect(result.processors).toHaveLength(1)
    })

    it('should sort plugins by dependencies', () => {
      const a = plugin('a')
      const b = plugin('b', { dependencies: ['a'] })
      const c = plugin('c', { dependencies: ['b'] })

      // Pass in wrong order
      const result = resolvePlugins([c, a, b])

      expect(result.plugins.map((p) => p.name)).toEqual(['a', 'b', 'c'])
    })

    it('should handle diamond dependencies', () => {
      //     a
      //    / \
      //   b   c
      //    \ /
      //     d
      const a = plugin('a')
      const b = plugin('b', { dependencies: ['a'] })
      const c = plugin('c', { dependencies: ['a'] })
      const d = plugin('d', { dependencies: ['b', 'c'] })

      const result = resolvePlugins([d, c, b, a])
      const names = result.plugins.map((p) => p.name)

      // a must come first, d must come last
      expect(names[0]).toBe('a')
      expect(names[3]).toBe('d')
      // b and c can be in either order, but both before d
      expect(names.indexOf('b')).toBeLessThan(names.indexOf('d'))
      expect(names.indexOf('c')).toBeLessThan(names.indexOf('d'))
    })

    it('should throw on missing dependency', () => {
      const a = plugin('a', { dependencies: ['missing'] })

      expect(() => resolvePlugins([a])).toThrow(MissingDependencyError)
      expect(() => resolvePlugins([a])).toThrow("depends on 'missing'")
    })

    it('should throw on circular dependency', () => {
      const a = plugin('a', { dependencies: ['b'] })
      const b = plugin('b', { dependencies: ['a'] })

      expect(() => resolvePlugins([a, b])).toThrow(CircularDependencyError)
    })

    it('should throw on self-dependency', () => {
      const a = plugin('a', { dependencies: ['a'] })

      expect(() => resolvePlugins([a])).toThrow(CircularDependencyError)
    })

    it('should throw on longer circular chain', () => {
      const a = plugin('a', { dependencies: ['c'] })
      const b = plugin('b', { dependencies: ['a'] })
      const c = plugin('c', { dependencies: ['b'] })

      expect(() => resolvePlugins([a, b, c])).toThrow(CircularDependencyError)
    })

    it('should throw on duplicate plugin names', () => {
      const a1 = plugin('a')
      const a2 = plugin('a')

      expect(() => resolvePlugins([a1, a2])).toThrow(DuplicatePluginError)
      expect(() => resolvePlugins([a1, a2])).toThrow("Duplicate plugin: 'a'")
    })
  })

  describe('settler negotiation', () => {
    it('should default to paragraph when no settlers specified', () => {
      const result = resolvePlugins([plugin('a'), plugin('b')])
      expect(result.settler).toBe('paragraph')
    })

    it('should use the specified settler', () => {
      const result = resolvePlugins([plugin('a', { settler: 'line' })])
      expect(result.settler).toBe('line')
    })

    it('should use most specific settler (line > paragraph)', () => {
      const result = resolvePlugins([
        plugin('a', { settler: 'paragraph' }),
        plugin('b', { settler: 'line' }),
      ])
      expect(result.settler).toBe('line')
    })

    it('should use most specific settler (codeFence > line)', () => {
      const result = resolvePlugins([
        plugin('a', { settler: 'line' }),
        plugin('b', { settler: 'codeFence' }),
      ])
      expect(result.settler).toBe('codeFence')
    })

    it('should use most specific settler (sentence > paragraph)', () => {
      const result = resolvePlugins([
        plugin('a', { settler: 'paragraph' }),
        plugin('b', { settler: 'sentence' }),
      ])
      expect(result.settler).toBe('sentence')
    })

    it('should use codeFence as highest precedence', () => {
      const result = resolvePlugins([
        plugin('a', { settler: 'paragraph' }),
        plugin('b', { settler: 'line' }),
        plugin('c', { settler: 'sentence' }),
        plugin('d', { settler: 'codeFence' }),
      ])
      expect(result.settler).toBe('codeFence')
    })

    it('should handle mixed specified/unspecified settlers', () => {
      const result = resolvePlugins([
        plugin('a'), // No settler (defaults to paragraph)
        plugin('b', { settler: 'line' }),
        plugin('c'), // No settler
      ])
      expect(result.settler).toBe('line')
    })
  })

  describe('preloadPlugins', () => {
    it('should call all preload functions', async () => {
      const preloadA = vi.fn(function* () {
        /* noop */
      })
      const preloadB = vi.fn(function* () {
        /* noop */
      })

      const plugins = [
        plugin('a', { preload: preloadA }),
        plugin('b', { preload: preloadB }),
      ]

      await run(function* () {
        yield* preloadPlugins(plugins)
      })

      expect(preloadA).toHaveBeenCalledTimes(1)
      expect(preloadB).toHaveBeenCalledTimes(1)
    })

    it('should skip plugins without preload', async () => {
      const preloadA = vi.fn(function* () {
        /* noop */
      })

      const plugins = [
        plugin('a', { preload: preloadA }),
        plugin('b'), // No preload
        plugin('c'), // No preload
      ]

      await run(function* () {
        yield* preloadPlugins(plugins)
      })

      expect(preloadA).toHaveBeenCalledTimes(1)
    })

    it('should handle empty plugin list', async () => {
      // Should not throw
      await run(function* () {
        yield* preloadPlugins([])
      })
    })

    it('should handle all plugins without preload', async () => {
      // Should not throw
      await run(function* () {
        yield* preloadPlugins([plugin('a'), plugin('b')])
      })
    })
  })

  describe('arePluginsReady', () => {
    it('should return true when all plugins are ready', () => {
      const plugins = [
        plugin('a', { isReady: () => true }),
        plugin('b', { isReady: () => true }),
      ]
      expect(arePluginsReady(plugins)).toBe(true)
    })

    it('should return false when any plugin is not ready', () => {
      const plugins = [
        plugin('a', { isReady: () => true }),
        plugin('b', { isReady: () => false }),
      ]
      expect(arePluginsReady(plugins)).toBe(false)
    })

    it('should return true when plugins have no isReady', () => {
      const plugins = [plugin('a'), plugin('b')]
      expect(arePluginsReady(plugins)).toBe(true)
    })

    it('should return true for empty list', () => {
      expect(arePluginsReady([])).toBe(true)
    })

    it('should handle mixed isReady/no-isReady', () => {
      const plugins = [
        plugin('a', { isReady: () => true }),
        plugin('b'), // No isReady = assumed ready
        plugin('c', { isReady: () => true }),
      ]
      expect(arePluginsReady(plugins)).toBe(true)
    })
  })

  describe('loadPlugins', () => {
    it('should resolve and preload plugins', async () => {
      const preloadA = vi.fn(function* () {
        /* noop */
      })

      const a = plugin('a', { preload: preloadA })
      const b = plugin('b', { dependencies: ['a'], settler: 'line' })

      const result = await run(function* () {
        return yield* loadPlugins([b, a])
      })

      // Should be sorted
      expect(result.plugins.map((p) => p.name)).toEqual(['a', 'b'])
      // Settler negotiated
      expect(result.settler).toBe('line')
      // Preload called
      expect(preloadA).toHaveBeenCalledTimes(1)
    })
  })

  describe('processor extraction', () => {
    it('should extract processors in dependency order', () => {
      const processorA = vi.fn()
      const processorB = vi.fn()
      const processorC = vi.fn()

      const a = plugin('a')
      a.processor = () => processorA as never

      const b = plugin('b', { dependencies: ['a'] })
      b.processor = () => processorB as never

      const c = plugin('c', { dependencies: ['b'] })
      c.processor = () => processorC as never

      const result = resolvePlugins([c, b, a])

      // Call each factory
      const factories = result.processors
      expect(factories).toHaveLength(3)
      expect(factories[0]()).toBe(processorA)
      expect(factories[1]()).toBe(processorB)
      expect(factories[2]()).toBe(processorC)
    })
  })
})
