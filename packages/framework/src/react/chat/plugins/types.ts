/**
 * plugins/types.ts
 *
 * Types for the processor plugin system.
 *
 * Plugins are self-contained units that combine:
 * - A processor (the transformation logic)
 * - A settler preference (what settler this plugin works best with)
 * - Preload logic (for async assets like highlighters)
 * - Dependencies (other plugins that must run before this one)
 */
import type { Operation } from 'effection'
import type { ProcessorFactory } from '../types/processor'
import type { BaseSettleMeta } from '../types/settler'

/**
 * Settler preference for a plugin.
 *
 * Higher specificity settlers take precedence when combining plugins:
 * - codeFence: Most specific (line-by-line in fences, line outside)
 * - line: More specific than paragraph
 * - sentence: More specific than paragraph
 * - paragraph: Default, least specific
 */
export type SettlerPreference = 'paragraph' | 'line' | 'sentence' | 'codeFence'

/**
 * A processor plugin is a self-contained processing unit.
 *
 * Plugins declare:
 * - What settler they work best with
 * - What other plugins they depend on
 * - How to preload their assets
 * - The actual processor logic
 *
 * The plugin loader resolves dependencies via DAG topological sort
 * and negotiates the optimal settler for the combined plugin set.
 *
 * ## Example
 *
 * ```typescript
 * const shikiPlugin: ProcessorPlugin = {
 *   name: 'shiki',
 *   description: 'Syntax highlighting with Shiki',
 *   settler: 'codeFence',
 *   dependencies: ['markdown'],
 *
 *   *preload() {
 *     yield* preloadHighlighter(['typescript', 'python'])
 *   },
 *
 *   isReady: () => isHighlighterReady(),
 *
 *   processor: shikiProcessor,
 * }
 * ```
 */
export interface ProcessorPlugin<TMeta extends BaseSettleMeta = BaseSettleMeta> {
  /**
   * Unique identifier for this plugin.
   * Used for dependency resolution and error messages.
   */
  name: string

  /**
   * Human-readable description.
   */
  description?: string

  /**
   * Preferred settler for this plugin.
   *
   * When combining plugins, the most specific settler wins:
   * codeFence > line > sentence > paragraph
   *
   * If multiple plugins want incompatible settlers, an error is thrown.
   */
  settler?: SettlerPreference

  /**
   * Plugins that must run before this one.
   *
   * The loader performs a topological sort based on dependencies.
   * If a dependency is missing, an error is thrown.
   *
   * @example
   * dependencies: ['markdown'] // Shiki needs markdown to run first
   */
  dependencies?: string[]

  /**
   * Preload async assets (highlighters, renderers, etc.)
   *
   * Called eagerly when plugins are initialized.
   * Runs in parallel with other plugin preloads.
   */
  preload?: () => Operation<void>

  /**
   * Check if this plugin's assets are ready.
   *
   * Used to show loading states or defer rendering.
   */
  isReady?: () => boolean

  /**
   * The processor factory.
   *
   * This creates a fresh processor instance for each streaming session.
   */
  processor: ProcessorFactory<TMeta>
}

/**
 * Result of resolving a set of plugins.
 */
export interface ResolvedPlugins {
  /**
   * The ordered list of plugins (topologically sorted by dependencies).
   */
  plugins: ProcessorPlugin[]

  /**
   * The negotiated settler preference.
   * This is the most specific settler from all plugins.
   */
  settler: SettlerPreference

  /**
   * The ordered list of processor factories.
   */
  processors: ProcessorFactory[]
}
