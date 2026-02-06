/**
 * Core Tool Adapter Tests
 *
 * Tests for the adapter that bridges @sweatpants/core tools
 * to the framework's isomorphic tool system.
 */
import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { createTool } from '@sweatpants/core'
import { isCoreToolFactory, adaptCoreTool } from '../adapter.ts'
import { createIsomorphicToolRegistry } from '../../isomorphic-tools/registry.ts'

describe('Core Tool Adapter', () => {
  describe('isCoreToolFactory', () => {
    it('should detect a core tool factory', function* () {
      const coreTool = createTool({
        name: 'test_tool',
        description: 'A test tool',
        input: z.object({ value: z.string() }),
        output: z.object({ result: z.string() }),
        impl: function* ({ value }) {
          return { result: value.toUpperCase() }
        },
      })

      expect(isCoreToolFactory(coreTool)).toBe(true)
    })

    it('should return false for plain objects', function* () {
      const notATool = {
        name: 'not_a_tool',
        description: 'Not a tool',
      }

      expect(isCoreToolFactory(notATool)).toBe(false)
    })

    it('should return false for functions without required properties', function* () {
      const fn = () => {}
      expect(isCoreToolFactory(fn)).toBe(false)
    })

    it('should return false for isomorphic tools', function* () {
      const isomorphicTool = {
        name: 'iso_tool',
        description: 'An isomorphic tool',
        parameters: z.object({ value: z.string() }),
        *server(params: { value: string }) {
          return { result: params.value }
        },
      }

      expect(isCoreToolFactory(isomorphicTool)).toBe(false)
    })
  })

  describe('adaptCoreTool', () => {
    it('should adapt a core tool to AnyIsomorphicTool', function* () {
      const coreTool = createTool({
        name: 'adapt_test',
        description: 'Test adaptation',
        input: z.object({ input: z.string() }),
        output: z.object({ output: z.string() }),
        impl: function* ({ input }) {
          return { output: `processed: ${input}` }
        },
      })

      const adapted = adaptCoreTool(coreTool)

      expect(adapted.name).toBe('adapt_test')
      expect(adapted.description).toBe('Test adaptation')
      expect(adapted.contextMode).toBe('headless')
      expect(adapted.parameters).toBe(coreTool.schemas.input)
      expect(adapted.server).toBeDefined()
      expect(adapted.client).toBeUndefined()
    })
  })

  describe('Registry Integration', () => {
    it('should accept core tools in createIsomorphicToolRegistry', function* () {
      const coreTool = createTool({
        name: 'core_in_registry',
        description: 'Core tool in registry',
        input: z.object({ data: z.string() }),
        output: z.object({ result: z.string() }),
        impl: function* ({ data }) {
          return { result: data }
        },
      })

      const isomorphicTool = {
        name: 'iso_in_registry',
        description: 'Isomorphic tool in registry',
        parameters: z.object({ value: z.number() }),
        *server(params: { value: number }) {
          return { doubled: params.value * 2 }
        },
      }

      const registry = createIsomorphicToolRegistry([
        coreTool,
        isomorphicTool,
      ])

      expect(registry.has('core_in_registry')).toBe(true)
      expect(registry.has('iso_in_registry')).toBe(true)
      expect(registry.names()).toContain('core_in_registry')
      expect(registry.names()).toContain('iso_in_registry')
    })

    it('should generate schemas for core tools', function* () {
      const coreTool = createTool({
        name: 'schema_test',
        description: 'Schema test tool',
        input: z.object({
          query: z.string().describe('Search query'),
          limit: z.number().optional().describe('Max results'),
        }),
        output: z.object({ results: z.array(z.string()) }),
        impl: function* () {
          return { results: [] }
        },
      })

      const registry = createIsomorphicToolRegistry([coreTool])
      const schemas = registry.toToolSchemas()

      expect(schemas).toHaveLength(1)
      expect(schemas[0].name).toBe('schema_test')
      expect(schemas[0].description).toBe('Schema test tool')
      expect(schemas[0].isIsomorphic).toBe(true)
      expect(schemas[0].parameters).toBeDefined()
    })

    it('should extract server tools for core tools', function* () {
      const coreTool = createTool({
        name: 'server_extract',
        description: 'Server extraction test',
        input: z.object({ id: z.string() }),
        output: z.object({ found: z.boolean() }),
        impl: function* () {
          return { found: true }
        },
      })

      const registry = createIsomorphicToolRegistry([coreTool])
      const serverTools = registry.toServerTools()

      expect(serverTools).toHaveLength(1)
      expect(serverTools[0].name).toBe('server_extract')
      expect(serverTools[0].execute).toBeDefined()
    })

    it('should reject duplicate tool names', function* () {
      const coreTool = createTool({
        name: 'duplicate',
        description: 'First tool',
        input: z.object({}),
        output: z.object({}),
        impl: function* () {
          return {}
        },
      })

      const isomorphicTool = {
        name: 'duplicate',
        description: 'Second tool',
        parameters: z.object({}),
        *server() {
          return {}
        },
      }

      expect(() => {
        createIsomorphicToolRegistry([coreTool, isomorphicTool])
      }).toThrow('Duplicate tool name: duplicate')
    })
  })
})
