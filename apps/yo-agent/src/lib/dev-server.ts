/**
 * Dev Server Resource
 *
 * Combines Vite HMR with the framework handler for a full dev experience.
 * Tools and handler configuration hot-reload on file changes.
 *
 * ## Usage
 *
 * ```typescript
 * yield* main(function* () {
 *   const dev = yield* useDevServer({
 *     root: process.cwd(),
 *     toolsPath: './src/tools',
 *   })
 *
 *   // Handler auto-reloads when tools change
 *   const response = yield* dev.fetch(request)
 * })
 * ```
 */
import { resource, call, spawn, each, createSignal } from 'effection'
import type { Operation, Stream } from 'effection'
import { useVite, type ViteHandle, type HmrEvent } from './vite-resource.ts'

/**
 * Options for the dev server
 */
export interface DevServerOptions {
  /** Root directory */
  root?: string
  /** Path to tools directory (relative to root) */
  toolsPath?: string
  /** LLM provider: 'ollama' | 'openai' */
  provider?: 'ollama' | 'openai'
}

/**
 * Handle returned by useDevServer
 */
export interface DevServerHandle {
  /**
   * Fetch-like function that calls the handler.
   * Handler uses latest tool definitions (hot-reloaded).
   */
  fetch: (request: Request) => Promise<Response>

  /**
   * Stream of reload events
   */
  reloadEvents: Stream<{ type: 'tools' | 'config'; file: string }, void>

  /**
   * Force reload all tools
   */
  reloadTools: () => Operation<void>

  /**
   * The underlying Vite handle (for advanced use)
   */
  vite: ViteHandle
}

/**
 * Resource that provides a hot-reloading dev server.
 *
 * Watches for file changes and reloads tools automatically.
 * The fetch handler always uses the latest tool definitions.
 */
export function useDevServer(options: DevServerOptions = {}): Operation<DevServerHandle> {
  return resource(function* (provide) {
    const {
      root = process.cwd(),
      toolsPath = './src/tools',
      provider = 'ollama',
    } = options

    // Start Vite in middleware mode for HMR
    const vite = yield* useVite({ root, logLevel: 'warn' })

    // Signal for reload events
    const reloadSignal = createSignal<{ type: 'tools' | 'config'; file: string }, void>()

    // Current handler (will be replaced on reload)
    let currentHandler: ((req: Request) => Promise<Response>) | null = null

    // Load/reload the handler with current tools
    function* loadHandler(): Operation<void> {
      // Import tools through Vite (gets HMR support)
      const toolsModule = yield* vite.import<{ tools?: unknown[]; toolList?: unknown[] }>(
        `${toolsPath}/index.ts`
      )

      const tools = toolsModule.tools ?? toolsModule.toolList ?? []

      // Import the handler factory
      // This would come from the framework
      const { createInProcessHandler } = yield* call(() =>
        import('./in-process-handler.ts')
      )

      // Create new handler with loaded tools
      currentHandler = createInProcessHandler({
        provider,
        tools: tools as any[],
      })
    }

    // Initial load
    yield* loadHandler()

    // Watch for changes and reload
    yield* spawn(function* () {
      for (const event of yield* each(vite.hmrEvents)) {
        // Check if this affects our tools
        const isToolChange = event.file.includes(toolsPath.replace('./', ''))
        
        if (isToolChange) {
          console.log(`[HMR] Tool changed: ${event.file}`)
          
          // Invalidate and reload
          vite.invalidate(`${toolsPath}/index.ts`)
          yield* loadHandler()
          
          reloadSignal.send({ type: 'tools', file: event.file })
        }
        
        yield* each.next()
      }
    })

    // Create the handle
    const handle: DevServerHandle = {
      async fetch(request: Request): Promise<Response> {
        if (!currentHandler) {
          return new Response('Handler not ready', { status: 503 })
        }
        return currentHandler(request)
      },

      reloadEvents: reloadSignal,

      *reloadTools(): Operation<void> {
        vite.invalidate(`${toolsPath}/index.ts`)
        yield* loadHandler()
      },

      vite,
    }

    try {
      yield* provide(handle)
    } finally {
      reloadSignal.close()
    }
  })
}
