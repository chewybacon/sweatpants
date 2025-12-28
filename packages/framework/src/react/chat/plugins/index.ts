/**
 * plugins/index.ts
 *
 * Plugin system exports.
 *
 * ## Available Plugins
 *
 * - `markdownPlugin` - Parse markdown to HTML
 * - `smartMarkdownPlugin` - Parse markdown, skip code fences
 * - `shikiPlugin` - Progressive syntax highlighting with Shiki
 * - `mermaidPlugin` - Progressive mermaid diagram rendering
 * - `mathPlugin` - KaTeX math rendering with markdown
 * - `smartMathPlugin` - KaTeX math, skip code fences
 *
 * ## Usage
 *
 * ```typescript
 * import { markdownPlugin, shikiPlugin } from '@tanstack/framework/react/chat/plugins'
 *
 * useChat({
 *   plugins: [markdownPlugin, shikiPlugin]
 * })
 * ```
 */

// Types
export type { ProcessorPlugin, ResolvedPlugins, SettlerPreference } from './types'

// Loader functions
export {
  resolvePlugins,
  preloadPlugins,
  arePluginsReady,
  loadPlugins,
} from './loader'

// Error types
export {
  PluginResolutionError,
  CircularDependencyError,
  MissingDependencyError,
  DuplicatePluginError,
} from './loader'

// --- Built-in Plugins ---

// Markdown
export { markdownPlugin, smartMarkdownPlugin } from './markdown'

// Syntax Highlighting
export { shikiPlugin } from './shiki'

// Diagrams
export { mermaidPlugin } from './mermaid'

// Math
export { mathPlugin, smartMathPlugin } from './math'
