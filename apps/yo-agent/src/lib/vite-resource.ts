/**
 * Vite Dev Server Resource
 *
 * Wraps Vite's dev server in an Effection resource for structured concurrency.
 * Provides HMR-aware module loading for tools and other dynamic code.
 *
 * ## Architecture
 *
 * The resource:
 * 1. Creates a Vite dev server in middleware mode (no HTTP server)
 * 2. Uses Vite's module runner for SSR-style module execution
 * 3. Exposes HMR events as an Effection Stream
 * 4. Cleans up on scope exit
 *
 * ## Usage
 *
 * ```typescript
 * yield* main(function* () {
 *   const vite = yield* useVite({ root: process.cwd() })
 *
 *   // Load a module
 *   const tools = yield* vite.import('./src/tools/index.ts')
 *
 *   // Subscribe to HMR events
 *   yield* spawn(function* () {
 *     for (const event of yield* each(vite.hmrEvents)) {
 *       console.log('HMR:', event.file)
 *       yield* each.next()
 *     }
 *   })
 * })
 * ```
 */
import { resource, call, createChannel, spawn, each } from 'effection'
import type { Operation, Channel } from 'effection'
import { createServer, type ViteDevServer, type InlineConfig } from 'vite'

/**
 * HMR event emitted when a file changes
 */
export interface HmrEvent {
  type: 'change' | 'add' | 'unlink'
  file: string
  timestamp: number
}

/**
 * Options for useVite resource
 */
export interface UseViteOptions {
  /** Root directory (defaults to cwd) */
  root?: string
  /** Path to vite config file, or false to disable */
  configFile?: string | false
  /** Log level */
  logLevel?: 'info' | 'warn' | 'error' | 'silent'
  /** Additional watch patterns to ignore */
  watchIgnore?: string[]
}

/**
 * Handle returned by useVite resource
 */
export interface ViteHandle {
  /**
   * Import a module through Vite's transform pipeline.
   * Supports HMR - module will be re-executed on file changes.
   */
  import<T = Record<string, unknown>>(url: string): Operation<T>

  /**
   * Invalidate a module in Vite's cache.
   * Next import will re-transform and re-execute the module.
   */
  invalidate(url: string): void

  /**
   * Stream of HMR events (file changes)
   */
  hmrEvents: Channel<HmrEvent, void>

  /**
   * The underlying Vite dev server (for advanced use)
   */
  server: ViteDevServer
}

/**
 * Effection resource that manages a Vite dev server.
 *
 * Creates a Vite server in middleware mode (no HTTP) with HMR support.
 * Modules loaded through this resource will hot-reload on file changes.
 */
export function useVite(options: UseViteOptions = {}): Operation<ViteHandle> {
  return resource(function* (provide) {
    const {
      root = process.cwd(),
      configFile = false,
      logLevel = 'silent',
      watchIgnore = [],
    } = options

    // Create Vite dev server in middleware mode
    const server = yield* call(() =>
      createServer({
        root,
        configFile,
        logLevel,
        server: {
          middlewareMode: true,
          hmr: true,
          watch: {
            ignored: ['**/node_modules/**', '**/.git/**', ...watchIgnore],
          },
        },
        optimizeDeps: {
          // Disable dependency pre-bundling for faster startup
          noDiscovery: true,
        },
      })
    )

    // Create channel for HMR events
    const hmrEvents = createChannel<HmrEvent, void>()

    // Watch for file changes and emit to channel
    const emitChange = (type: 'change' | 'add' | 'unlink') => (file: string) => {
      hmrEvents.send({
        type,
        file,
        timestamp: Date.now(),
      })
    }

    server.watcher.on('change', emitChange('change'))
    server.watcher.on('add', emitChange('add'))
    server.watcher.on('unlink', emitChange('unlink'))

    // Module cache for invalidation tracking
    const moduleCache = new Map<string, unknown>()

    // Create the handle
    const handle: ViteHandle = {
      *import<T>(url: string): Operation<T> {
        try {
          const mod = yield* call(() => server.ssrLoadModule(url))
          moduleCache.set(url, mod)
          return mod as T
        } catch (e) {
          if (e instanceof Error) {
            server.ssrFixStacktrace(e)
          }
          throw e
        }
      },

      invalidate(url: string) {
        moduleCache.delete(url)
        // Vite's SSR module graph handles the actual invalidation
        // This is a hint that we should re-import on next access
      },

      hmrEvents,

      server,
    }

    try {
      // Provide the handle to the caller
      yield* provide(handle)
    } finally {
      // Cleanup: close the Vite server
      hmrEvents.close()
      yield* call(() => server.close())
    }
  })
}

/**
 * Helper to create an auto-reloading module loader.
 *
 * Returns a getter that always returns the latest version of the module.
 * Automatically reloads when the file changes.
 *
 * ```typescript
 * const getTools = yield* autoReload(vite, './src/tools/index.ts')
 *
 * // Always gets the latest version
 * const tools = yield* getTools()
 * ```
 */
export function autoReload<T = Record<string, unknown>>(
  vite: ViteHandle,
  url: string
): Operation<() => Operation<T>> {
  return resource(function* (provide) {
    let current: T | undefined

    // Initial load
    current = yield* vite.import<T>(url)

    // Watch for changes and reload
    yield* spawn(function* () {
      for (const event of yield* each(vite.hmrEvents)) {
        // Check if this change affects our module
        // Normalize paths for comparison
        const normalizedUrl = url.replace(/^\.\//, '')
        const fileMatchesUrl =
          event.file.endsWith(normalizedUrl) ||
          event.file.includes(normalizedUrl)

        if (fileMatchesUrl) {
          vite.invalidate(url)
          current = yield* vite.import<T>(url)
        }
        yield* each.next()
      }
    })

    // Provide getter function
    yield* provide(function* (): Operation<T> {
      if (!current) {
        current = yield* vite.import<T>(url)
      }
      return current
    })
  })
}
