/**
 * plugins/loader.ts
 *
 * Plugin loader with DAG-based dependency resolution and settler negotiation.
 *
 * The loader:
 * 1. Topologically sorts plugins by dependencies
 * 2. Negotiates the optimal settler (most specific wins)
 * 3. Preloads plugin assets in parallel
 */
import { type Operation, all as effectionAll } from 'effection'
import type { ProcessorPlugin, ResolvedPlugins, SettlerPreference } from './types'

// --- Settler Precedence ---

/**
 * Settler precedence - higher number = more specific.
 *
 * When combining plugins, we use the most specific settler.
 * codeFence is most specific because it handles both code and non-code.
 */
const SETTLER_PRECEDENCE: Record<SettlerPreference, number> = {
  paragraph: 1,
  sentence: 2,
  line: 3,
  codeFence: 4,
}

/**
 * Returns the higher-precedence settler.
 */
function maxSettler(a: SettlerPreference, b: SettlerPreference): SettlerPreference {
  return SETTLER_PRECEDENCE[a] >= SETTLER_PRECEDENCE[b] ? a : b
}

// --- Error Types ---

export class PluginResolutionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PluginResolutionError'
  }
}

export class CircularDependencyError extends PluginResolutionError {
  constructor(public cycle: string[]) {
    super(`Circular dependency detected: ${cycle.join(' -> ')}`)
    this.name = 'CircularDependencyError'
  }
}

export class MissingDependencyError extends PluginResolutionError {
  constructor(
    public plugin: string,
    public dependency: string
  ) {
    super(`Plugin '${plugin}' depends on '${dependency}' which is not in the plugin list`)
    this.name = 'MissingDependencyError'
  }
}

export class DuplicatePluginError extends PluginResolutionError {
  constructor(public pluginName: string) {
    super(`Duplicate plugin: '${pluginName}'`)
    this.name = 'DuplicatePluginError'
  }
}

// --- DAG Topological Sort ---

/**
 * Topologically sort plugins based on dependencies.
 *
 * Uses Kahn's algorithm:
 * 1. Find nodes with no incoming edges (no dependencies)
 * 2. Remove them and their outgoing edges
 * 3. Repeat until all nodes are processed
 * 4. If nodes remain, there's a cycle
 *
 * @returns Plugins in dependency order (dependencies come first)
 */
function topologicalSort(plugins: ProcessorPlugin[]): ProcessorPlugin[] {
  // Build adjacency list and in-degree map
  const byName = new Map<string, ProcessorPlugin>()
  const inDegree = new Map<string, number>()
  const dependents = new Map<string, Set<string>>()

  // Check for duplicates and initialize
  for (const plugin of plugins) {
    if (byName.has(plugin.name)) {
      throw new DuplicatePluginError(plugin.name)
    }
    byName.set(plugin.name, plugin)
    inDegree.set(plugin.name, 0)
    dependents.set(plugin.name, new Set())
  }

  // Build the graph
  for (const plugin of plugins) {
    for (const dep of plugin.dependencies ?? []) {
      if (!byName.has(dep)) {
        throw new MissingDependencyError(plugin.name, dep)
      }
      // dep -> plugin (plugin depends on dep)
      dependents.get(dep)!.add(plugin.name)
      inDegree.set(plugin.name, inDegree.get(plugin.name)! + 1)
    }
  }

  // Find all plugins with no dependencies
  const queue: string[] = []
  for (const [name, degree] of inDegree) {
    if (degree === 0) {
      queue.push(name)
    }
  }

  // Process the queue
  const result: ProcessorPlugin[] = []
  while (queue.length > 0) {
    const name = queue.shift()!
    result.push(byName.get(name)!)

    // "Remove" this node by decrementing in-degree of dependents
    for (const dependent of dependents.get(name)!) {
      const newDegree = inDegree.get(dependent)! - 1
      inDegree.set(dependent, newDegree)
      if (newDegree === 0) {
        queue.push(dependent)
      }
    }
  }

  // If we didn't process all plugins, there's a cycle
  if (result.length !== plugins.length) {
    // Find the cycle for a better error message
    const remaining = plugins.filter((p) => !result.includes(p))
    const cycle = findCycle(remaining)
    throw new CircularDependencyError(cycle)
  }

  return result
}

/**
 * Find a cycle in the remaining (unprocessed) plugins.
 * Uses DFS to find a back edge.
 */
function findCycle(plugins: ProcessorPlugin[]): string[] {
  const byName = new Map(plugins.map((p) => [p.name, p]))
  const visited = new Set<string>()
  const path: string[] = []
  const pathSet = new Set<string>()

  function dfs(name: string): string[] | null {
    if (pathSet.has(name)) {
      // Found cycle - extract it
      const cycleStart = path.indexOf(name)
      return [...path.slice(cycleStart), name]
    }
    if (visited.has(name)) return null

    visited.add(name)
    path.push(name)
    pathSet.add(name)

    const plugin = byName.get(name)
    if (plugin) {
      for (const dep of plugin.dependencies ?? []) {
        if (byName.has(dep)) {
          const cycle = dfs(dep)
          if (cycle) return cycle
        }
      }
    }

    path.pop()
    pathSet.delete(name)
    return null
  }

  for (const plugin of plugins) {
    const cycle = dfs(plugin.name)
    if (cycle) return cycle
  }

  // Shouldn't happen if topologicalSort correctly detected a cycle
  return plugins.map((p) => p.name)
}

// --- Settler Negotiation ---

/**
 * Negotiate the optimal settler from a set of plugins.
 *
 * Strategy: Use the most specific settler from all plugins.
 * codeFence > line > sentence > paragraph
 *
 * This works because more specific settlers are supersets of less specific:
 * - codeFence handles both code (line-by-line) and non-code (paragraph)
 * - line handles everything paragraph does, just more frequently
 */
function negotiateSettler(plugins: ProcessorPlugin[]): SettlerPreference {
  let result: SettlerPreference = 'paragraph' // Default

  for (const plugin of plugins) {
    if (plugin.settler) {
      result = maxSettler(result, plugin.settler)
    }
  }

  return result
}

// --- Resolve Plugins ---

/**
 * Resolve a set of plugins into a ready-to-use configuration.
 *
 * This:
 * 1. Topologically sorts by dependencies (dependencies first)
 * 2. Negotiates the optimal settler
 * 3. Extracts the ordered processor factories
 *
 * @example
 * ```typescript
 * const resolved = resolvePlugins([shikiPlugin, markdownPlugin, mermaidPlugin])
 * // resolved.plugins = [markdown, shiki, mermaid] (sorted)
 * // resolved.settler = 'codeFence' (from shiki)
 * // resolved.processors = [markdownProcessor, shikiProcessor, mermaidProcessor]
 * ```
 */
export function resolvePlugins(plugins: ProcessorPlugin[]): ResolvedPlugins {
  if (plugins.length === 0) {
    return {
      plugins: [],
      settler: 'paragraph',
      processors: [],
    }
  }

  const sorted = topologicalSort(plugins)
  const settler = negotiateSettler(sorted)
  const processors = sorted.map((p) => p.processor)

  return { plugins: sorted, settler, processors }
}

// --- Preload Plugins ---

/**
 * Preload all plugin assets in parallel.
 *
 * This runs each plugin's preload() in parallel using Effection's all().
 * Plugins without preload are skipped.
 *
 * @example
 * ```typescript
 * yield* preloadPlugins(resolved.plugins)
 * // Now all highlighters, renderers, etc. are ready
 * ```
 */
export function* preloadPlugins(plugins: ProcessorPlugin[]): Operation<void> {
  const preloads = plugins.filter((p) => p.preload).map((p) => p.preload!())

  if (preloads.length > 0) {
    yield* effectionAll(preloads)
  }
}

/**
 * Check if all plugins are ready.
 *
 * Returns true if all plugins with isReady() return true,
 * or if they don't have an isReady() method (assumed ready).
 */
export function arePluginsReady(plugins: ProcessorPlugin[]): boolean {
  return plugins.every((p) => !p.isReady || p.isReady())
}

// --- Convenience: Resolve and Preload ---

/**
 * Resolve plugins and preload their assets.
 *
 * Convenience function that combines resolvePlugins + preloadPlugins.
 *
 * @example
 * ```typescript
 * const resolved = yield* loadPlugins([markdownPlugin, shikiPlugin])
 * ```
 */
export function* loadPlugins(plugins: ProcessorPlugin[]): Operation<ResolvedPlugins> {
  const resolved = resolvePlugins(plugins)
  yield* preloadPlugins(resolved.plugins)
  return resolved
}
