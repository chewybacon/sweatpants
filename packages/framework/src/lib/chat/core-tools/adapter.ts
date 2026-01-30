/**
 * Core Tool Adapter
 *
 * Adapts @sweatpants/core tools to work with the framework's isomorphic tool system.
 * Core tools are wrapped to appear as server-authority isomorphic tools.
 */
import type { Operation } from 'effection'
import type { ZodSchema } from 'zod'
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
 */
export type CoreToolFactory = {
  (...args: unknown[]): Operation<unknown>
  decorate: (...args: unknown[]) => Operation<void>
  withContext: <T>(context: unknown, value: T) => CoreToolFactory
  readonly name: string
  readonly description: string
  readonly schemas: {
    readonly input: ZodSchema
    readonly output: ZodSchema
    readonly progress?: ZodSchema
  }
}

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
    typeof fn['decorate'] === 'function' &&
    typeof fn['withContext'] === 'function' &&
    typeof fn['name'] === 'string' &&
    typeof fn['description'] === 'string' &&
    fn['schemas'] !== null &&
    typeof fn['schemas'] === 'object' &&
    'input' in (fn['schemas'] as object) &&
    'output' in (fn['schemas'] as object)
  )
}

/**
 * Wrap a @sweatpants/core tool to work with the framework registry.
 *
 * This adapter:
 * - Maps core tool's `input` schema to isomorphic tool's `parameters`
 * - Sets up FrameworkTransport so core's `notify()` calls emit patches
 * - Produces a server-authority isomorphic tool (core tools run on server)
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
    authority: 'server',
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
        // Activate the core tool (no impl means it uses its configured impl)
        const tool = yield* (coreToolFactory as () => Operation<(args: unknown) => Operation<unknown>>)()

        // Invoke the tool with params
        return yield* tool(params)
      })
    },
  }

  return adapted
}
