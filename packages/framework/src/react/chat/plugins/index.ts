/**
 * plugins/index.ts
 *
 * Plugin system exports.
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
