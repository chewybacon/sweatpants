/**
 * @sweatpants/framework Vite Plugin
 *
 * Provides file-based discovery and registry generation for:
 * - Tools (isomorphic tools)
 * - Providers (future)
 * - Personas (future)
 * - Rendering pipelines (future)
 *
 * Inspired by TanStack Start's approach to type-safe, low-ceremony APIs.
 */
import type { Plugin } from 'vite'
import { toolDiscoveryPlugin } from './tool-discovery'
import type { ToolDiscoveryOptions } from './types'

export type { ToolDiscoveryOptions }
export { toolDiscoveryPlugin }

// Test utilities - exported for testing discovery logic without file I/O
export {
  discoverToolsInContent,
  generateRegistryContent,
  calculateImportPath,
  toCamelCase,
} from './tool-discovery'

export { resolveToolDiscoveryOptions } from './types'
export type { DiscoveredTool, ResolvedToolDiscoveryOptions } from './types'

export interface FrameworkOptions {
  /**
   * Tool discovery options.
   * Set to false to disable tool discovery.
   */
  tools?: ToolDiscoveryOptions | false
}

/**
 * Main framework plugin that composes all sub-plugins.
 *
 * @example
 * ```ts
 * // vite.config.ts
 * import { frameworkPlugin } from '@sweatpants/framework/vite'
 *
 * export default defineConfig({
 *   plugins: [
 *     frameworkPlugin({
 *       tools: {
 *         dir: 'src/tools',
 *         outFile: 'src/__generated__/tool-registry.gen.ts',
 *       },
 *     }),
 *   ],
 * })
 * ```
 */
export function frameworkPlugin(options: FrameworkOptions = {}): Plugin[] {
  const plugins: Plugin[] = []

  if (options.tools !== false) {
    plugins.push(toolDiscoveryPlugin(options.tools))
  }

  return plugins
}

export default frameworkPlugin
