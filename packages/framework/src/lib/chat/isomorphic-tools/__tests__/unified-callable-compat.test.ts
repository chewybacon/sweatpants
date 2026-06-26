/**
 * Regression tests for the unified-callable compat fixes (review Batch 0).
 *
 * CB-2: replayTrace (and other metadata) must remain writable so consumers can
 *   override post-finalization (the yo-chat app assigns replayTrace after build()).
 * CB-3: callable finalized tools must be detectable as unified (typeof === 'function'
 *   with capabilities) so the Vite worker and other guards route them correctly.
 * A-3: useChatSession tool-name detection accepts callable tools — covered by the
 *   same "function with name" shape asserted here.
 */
import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { createIsomorphicTool } from '../builder.ts'
import { createMCPTool } from '../../mcp-tools/builder.ts'

describe('Unified callable compat (review CB-2/CB-3)', () => {
  it('isomorphic finalized tool is a function with readable + writable metadata', () => {
    const tool = createIsomorphicTool('pick')
      .description('pick a thing')
      .parameters(z.object({ x: z.string() }))
      .context('headless')
      .server(function* () {
        return { ok: true }
      })
      .build()

    // CB-3: callable detection shape.
    expect(typeof tool).toBe('function')
    expect('capabilities' in tool).toBe(true)
    expect((tool as { name: string }).name).toBe('pick')

    // Legacy fields are readable.
    expect((tool as { description: string }).description).toBe('pick a thing')
    expect((tool as { contextMode: string }).contextMode).toBe('headless')

    // CB-2: replayTrace is writable post-finalization (the yo-chat app does this).
    const customTrace = function* () {
      return { hydrated: true } as never
    }
    ;(tool as { replayTrace?: unknown }).replayTrace = customTrace
    expect((tool as { replayTrace: unknown }).replayTrace).toBe(customTrace)
  })

  it('MCP finalized tool is a function with writable metadata', () => {
    const tool = createMCPTool('book')
      .description('book a thing')
      .parameters(z.object({ dest: z.string() }))
      .execute(function* () {
        return { booked: true }
      })

    expect(typeof tool).toBe('function')
    expect('capabilities' in tool).toBe(true)
    expect((tool as { name: string }).name).toBe('book')

    // CB-2: execute/requires remain writable.
    const originalExecute = (tool as { execute: unknown }).execute
    ;(tool as { execute?: unknown }).execute = function* () {
      return { overridden: true }
    }
    expect((tool as { execute: unknown }).execute).not.toBe(originalExecute)
    // Restore to avoid leaking into other tests.
    ;(tool as { execute: unknown }).execute = originalExecute
  })

  it('a unified callable satisfies the Vite-worker guard shape', () => {
    // Mirrors the guard added to packages/vite-plugin/src/tool-discovery.ts:
    //   if (tool && typeof tool === 'function' && 'capabilities' in tool) { … }
    const tool = createMCPTool('probe')
      .description('p')
      .parameters(z.object({ a: z.string() }))
      .execute(function* () {
        return 1
      })
    const isUnifiedCallable =
      typeof tool === 'function' && 'capabilities' in tool
    expect(isUnifiedCallable).toBe(true)
  })
})
