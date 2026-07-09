// @vitest-environment node
import { readFileSync } from 'node:fs'

import { run } from 'effection'
import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('yo-chat tool wiring', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  it('installs a shared fold-session buffer store in the durable host setup', async () => {
    vi.doMock('@/lib/shared-redis', () => ({
      getSharedRedisClient: async () => null,
    }))

    const { FoldSessionBufferStoreContext } = await import('@sweatpants/framework/server')
    const { setupYoChatDurableStreams } = await import('../server/durable-streams')

    await run(function* () {
      yield* setupYoChatDurableStreams()
      // Same context read path the durable handler uses for fold reopen.
      const store = yield* FoldSessionBufferStoreContext.get()
      expect(store).toBeDefined()
      expect(typeof store?.get).toBe('function')
      expect(typeof store?.create).toBe('function')
    })
  })

  it('registers every plugin-backed tool in the server plugin registries', async () => {
    vi.doMock('@/env', () => ({
      env: {
        MCP_TOOL_RUNTIME: 'local',
        AGENTCORE_TOOL_NAMES: undefined,
      },
    }))

    const { activePluginTools, pluginRegistry, mcpToolRegistry } = await import('../server/tools')
    const expected = ['ask_question', 'book_flight', 'pick_card', 'play_ttt', 'tictactoe']

    const activeNames = activePluginTools.map((tool) => tool.name).sort()
    expect(activeNames).toEqual(expected)
    expect(pluginRegistry.toolNames().sort()).toEqual(expected)
    expect(mcpToolRegistry.names().sort()).toEqual(expected)
  })

  it('generates a worker entry for every worker-compatible tool definition', () => {
    const workerEntry = readFileSync(new URL('../__generated__/tool-worker.gen.ts', import.meta.url), 'utf8')

    expect(workerEntry).toContain("name: 'ask_question'")
    expect(workerEntry).toContain("name: 'pick_card'")
    expect(workerEntry).toContain("name: 'book_flight'")
    expect(workerEntry).toContain("name: 'play_ttt'")
    expect(workerEntry).toContain("name: 'tictactoe'")
  })
})
