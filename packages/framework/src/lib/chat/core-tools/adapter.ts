/**
 * Core Tool Adapter
 *
 * Adapts @sweatpants/core tools to work with the framework's isomorphic tool system.
 * Core tools are wrapped to appear as server-first isomorphic tools.
 */
import type { Operation } from 'effection'
import type { ZodSchema } from 'zod'
import type { ToolCtx, ToolDefinition } from '@sweatpants/core'
import type { AnyIsomorphicTool, ServerToolContext } from '../isomorphic-tools/types.ts'
import { withFrameworkTransport } from './framework-transport.ts'

/**
 * Union type for any core tool factory.
 * 
 * Core tools created with `createTool()` from @sweatpants/core have:
 * - A callable that returns an Operation to activate the tool
 * - `decorate()` for middleware
 * - `withContext()` for context binding
 * - `name` and `description` metadata
 * - `schemas` with input/output/progress schemas
 * 
 * Note: We use `any` for middleware and context types to allow any core tool factory
 * regardless of its specific generic parameters. The runtime behavior is correct.
 */
export type LegacyCoreToolFactory = {
  (...args: unknown[]): Operation<unknown>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  decorate: (middleware: any) => Operation<void>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  withContext: <T>(context: any, value: T) => LegacyCoreToolFactory
  readonly name: string
  readonly description: string
  readonly schemas: {
    readonly input: ZodSchema
    readonly output?: ZodSchema
    readonly progress?: ZodSchema
  }
}

export type CoreToolFactory = ToolDefinition | LegacyCoreToolFactory

/**
 * Detect if a value is a @sweatpants/core tool factory.
 *
 * Core tools have a specific shape with:
 * - Function callable for activation
 * - `decorate` and `withContext` methods
 * - `schemas` property with Zod schemas
 * - `name` and `description` strings
 */
export function isCoreToolFactory(value: unknown): value is CoreToolFactory {
  if (typeof value !== 'function') return false

  // Use bracket notation to access properties on the function
  const fn = value as unknown as Record<string, unknown>

  return (
    typeof fn['name'] === 'string' &&
    typeof fn['description'] === 'string' &&
    fn['schemas'] !== null &&
    typeof fn['schemas'] === 'object' &&
    'input' in (fn['schemas'] as object) &&
    ((typeof fn['decorate'] === 'function' && typeof fn['withContext'] === 'function') ||
      ('parameters' in fn && 'capabilities' in fn))
  )
}

/**
 * Wrap a @sweatpants/core tool to work with the framework registry.
 *
 * This adapter:
 * - Maps core tool's `input` schema to isomorphic tool's `parameters`
 * - Sets up FrameworkTransport so core's `notify()` calls emit patches
 * - Produces a server-first isomorphic tool (core tools run on server)
 * - Sets contextMode to 'headless' since core tools don't need browser APIs
 *
 * @param coreToolFactory - A core tool factory from `createTool()`
 * @returns An `AnyIsomorphicTool` that can be registered in the framework
 */
export function adaptCoreTool(coreToolFactory: CoreToolFactory): AnyIsomorphicTool {
  const adapted: AnyIsomorphicTool = {
    name: coreToolFactory.name,
    description: coreToolFactory.description,
    parameters: coreToolFactory.schemas.input,
    contextMode: 'headless',

    /**
     * Server-side execution of the core tool.
     *
     * Sets up FrameworkTransport in context so that:
     * - `notify()` calls emit ClientToolProgressPatch
     * - `elicit()` calls will be bridged (Phase 6)
     */
    *server(params: unknown, ctx: ServerToolContext): Operation<unknown> {
      return yield* withFrameworkTransport(ctx, function* () {
        if (isCanonicalCoreTool(coreToolFactory)) {
          const toolCtx = createFrameworkToolCtx(coreToolFactory, ctx)
          const tool = yield* coreToolFactory(toolCtx)
          return yield* tool(params as never)
        }

        // Activate legacy config-style core tools (no impl means they use their configured impl).
        const tool = yield* (coreToolFactory as LegacyCoreToolFactory as () => Operation<(args: unknown) => Operation<unknown>>)()
        return yield* tool(params)
      })
    },
  }

  return adapted
}

function isCanonicalCoreTool(value: CoreToolFactory): value is ToolDefinition {
  return 'parameters' in value && 'capabilities' in value
}

function createFrameworkToolCtx(tool: ToolDefinition, serverCtx: ServerToolContext): ToolCtx<any, any> {
  return {
    history: [],
    notify: function* (_message: string, _fraction?: number, _level?: 'debug' | 'info' | 'warning' | 'error') {
      // Framework stream projection is adapter-specific; the core adapter keeps
      // notify/log observable but non-fatal when no stream bridge is installed.
    },
    log: function* (_level: 'debug' | 'info' | 'warning' | 'error', _message: string) {},
    elicit: function* (key: string): Operation<never> {
      throw new Error(`Tool "${tool.name}" requires unsupported elicit capability "${key}" in framework core adapter for call "${serverCtx.callId}"`)
    },
    sample: function* (...args: unknown[]): Operation<never> {
      const key = typeof args[0] === 'string' ? ` "${args[0]}"` : ''
      throw new Error(`Tool "${tool.name}" requires unsupported sample capability${key} in framework core adapter for call "${serverCtx.callId}"`)
    },
  }
}
