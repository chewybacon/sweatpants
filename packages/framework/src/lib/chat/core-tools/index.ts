/**
 * Core Tools Integration
 *
 * This module provides integration between @sweatpants/core tools
 * and the framework's isomorphic tool system.
 *
 * Core tools can be registered alongside isomorphic tools in the
 * framework's tool registry, and they will be automatically adapted
 * to work with the framework's patch-based streaming.
 *
 * @example
 * ```ts
 * import { createTool, notify } from '@sweatpants/core'
 * import { createIsomorphicToolRegistry } from '@sweatpants/framework/chat/isomorphic-tools'
 * import { z } from 'zod'
 *
 * // Define a core tool
 * const ProcessData = createTool({
 *   name: 'process_data',
 *   description: 'Process data with progress updates',
 *   input: z.object({ dataId: z.string() }),
 *   output: z.object({ result: z.string() }),
 *   impl: function* ({ dataId }) {
 *     yield* notify({ message: 'Loading...', progress: 0.1 })
 *     // ... do work
 *     return { result: 'done' }
 *   },
 * })
 *
 * // Register with framework (automatically adapted)
 * const registry = createIsomorphicToolRegistry([
 *   ProcessData,  // Core tool
 *   myIsomorphicTool,  // Framework tool
 * ])
 * ```
 */

export { adaptCoreTool, isCoreToolFactory, type CoreToolFactory } from './adapter.ts'
export {
  withFrameworkTransport,
  withFrameworkTransportAndEmitter,
  FrameworkBridgeContext,
  type FrameworkBridgeConfig,
} from './framework-transport.ts'
