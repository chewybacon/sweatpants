/**
 * pipeline/resolver.ts
 *
 * Processor resolver with DAG-based dependency resolution.
 *
 * The resolver:
 * 1. Topologically sorts processors by dependencies
 * 2. Validates the dependency graph (no cycles, no missing deps)
 * 3. Preloads processor assets in parallel
 *
 * This is similar to the old plugin loader, but simpler because
 * we no longer need settler negotiation.
 */
import { type Operation, all as effectionAll } from 'effection'
import type { Processor, ResolvedProcessors } from './types'

// =============================================================================
// Error Types
// =============================================================================

export class ProcessorResolutionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProcessorResolutionError'
  }
}

export class CircularDependencyError extends ProcessorResolutionError {
  constructor(public cycle: string[]) {
    super(`Circular dependency detected: ${cycle.join(' -> ')}`)
    this.name = 'CircularDependencyError'
  }
}

export class MissingDependencyError extends ProcessorResolutionError {
  constructor(
    public processor: string,
    public dependency: string
  ) {
    super(`Processor '${processor}' depends on '${dependency}' which was not found`)
    this.name = 'MissingDependencyError'
  }
}

export class DuplicateProcessorError extends ProcessorResolutionError {
  constructor(public processorName: string) {
    super(`Duplicate processor: '${processorName}'`)
    this.name = 'DuplicateProcessorError'
  }
}

// =============================================================================
// Built-in Processor Registry
// =============================================================================

// Lazy imports to avoid circular dependencies
let builtinProcessors: Map<string, () => Processor> | null = null

/**
 * Get the registry of built-in processors.
 * Used for auto-adding missing dependencies.
 */
function getBuiltinProcessors(): Map<string, () => Processor> {
  if (!builtinProcessors) {
    builtinProcessors = new Map()
    // Will be populated by processor modules when they register
  }
  return builtinProcessors
}

/**
 * Register a built-in processor.
 * Called by processor modules to make themselves available for auto-resolution.
 * @internal
 */
export function registerBuiltinProcessor(name: string, factory: () => Processor): void {
  getBuiltinProcessors().set(name, factory)
}

// =============================================================================
// DAG Topological Sort
// =============================================================================

/**
 * Topologically sort processors based on dependencies.
 *
 * Uses Kahn's algorithm:
 * 1. Find nodes with no incoming edges (no dependencies)
 * 2. Remove them and their outgoing edges
 * 3. Repeat until all nodes are processed
 * 4. If nodes remain, there's a cycle
 *
 * @param processors - Processors to sort
 * @param autoAddDeps - Whether to auto-add missing dependencies from built-ins
 * @returns Object with sorted processors and list of auto-added dependencies
 */
function topologicalSort(
  processors: readonly Processor[],
  autoAddDeps: boolean = true
): { sorted: Processor[]; added: string[] } {
  // Build mutable list and name index
  const allProcessors = [...processors]
  const byName = new Map<string, Processor>()
  const added: string[] = []

  // Check for duplicates and initialize
  for (const processor of allProcessors) {
    if (byName.has(processor.name)) {
      throw new DuplicateProcessorError(processor.name)
    }
    byName.set(processor.name, processor)
  }

  // Collect all dependencies and auto-add missing ones
  const builtins = getBuiltinProcessors()
  for (const processor of [...allProcessors]) {
    for (const dep of processor.dependencies ?? []) {
      if (!byName.has(dep)) {
        if (autoAddDeps && builtins.has(dep)) {
          // Auto-add the missing dependency
          const depProcessor = builtins.get(dep)!()
          allProcessors.push(depProcessor)
          byName.set(dep, depProcessor)
          added.push(dep)
        } else {
          throw new MissingDependencyError(processor.name, dep)
        }
      }
    }
  }

  // Build in-degree map and dependents list
  const inDegree = new Map<string, number>()
  const dependents = new Map<string, Set<string>>()

  for (const processor of allProcessors) {
    inDegree.set(processor.name, 0)
    dependents.set(processor.name, new Set())
  }

  for (const processor of allProcessors) {
    for (const dep of processor.dependencies ?? []) {
      dependents.get(dep)!.add(processor.name)
      inDegree.set(processor.name, inDegree.get(processor.name)! + 1)
    }
  }

  // Find all processors with no dependencies
  const queue: string[] = []
  for (const [name, degree] of inDegree) {
    if (degree === 0) {
      queue.push(name)
    }
  }

  // Process the queue
  const result: Processor[] = []
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

  // If we didn't process all processors, there's a cycle
  if (result.length !== allProcessors.length) {
    const remaining = allProcessors.filter((p) => !result.includes(p))
    const cycle = findCycle(remaining)
    throw new CircularDependencyError(cycle)
  }

  return { sorted: result, added }
}

/**
 * Find a cycle in the remaining (unprocessed) processors.
 * Uses DFS to find a back edge.
 */
function findCycle(processors: Processor[]): string[] {
  const byName = new Map(processors.map((p) => [p.name, p]))
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

    const processor = byName.get(name)
    if (processor) {
      for (const dep of processor.dependencies ?? []) {
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

  for (const processor of processors) {
    const cycle = dfs(processor.name)
    if (cycle) return cycle
  }

  // Shouldn't happen if topologicalSort correctly detected a cycle
  return processors.map((p) => p.name)
}

// =============================================================================
// Resolve Processors
// =============================================================================

/**
 * Resolve a set of processors into dependency order.
 *
 * This:
 * 1. Auto-adds missing dependencies from built-in processors
 * 2. Topologically sorts by dependencies (dependencies first)
 * 3. Returns the ordered list
 *
 * @example
 * ```typescript
 * const resolved = resolveProcessors([shikiProcessor, mermaidProcessor])
 * // resolved.processors = [markdown, shiki, mermaid] (sorted, markdown auto-added)
 * // resolved.addedDependencies = ['markdown']
 * ```
 */
export function resolveProcessors(processors: readonly Processor[]): ResolvedProcessors {
  if (processors.length === 0) {
    return {
      processors: [],
      addedDependencies: [],
    }
  }

  const { sorted, added } = topologicalSort(processors, true)

  return {
    processors: sorted,
    addedDependencies: added,
  }
}

// =============================================================================
// Preload Processors
// =============================================================================

/**
 * Preload all processor assets in parallel.
 *
 * This runs each processor's preload() in parallel using Effection's all().
 * Processors without preload are skipped.
 *
 * @example
 * ```typescript
 * yield* preloadProcessors(resolved.processors)
 * // Now all highlighters, renderers, etc. are ready
 * ```
 */
export function* preloadProcessors(processors: readonly Processor[]): Operation<void> {
  const preloads = processors.filter((p) => p.preload).map((p) => p.preload!())

  if (preloads.length > 0) {
    yield* effectionAll(preloads)
  }
}

/**
 * Check if all processors are ready.
 *
 * Returns true if all processors with isReady() return true,
 * or if they don't have an isReady() method (assumed ready).
 */
export function areProcessorsReady(processors: readonly Processor[]): boolean {
  return processors.every((p) => !p.isReady || p.isReady())
}

// =============================================================================
// Convenience: Resolve and Preload
// =============================================================================

/**
 * Resolve processors and preload their assets.
 *
 * Convenience function that combines resolveProcessors + preloadProcessors.
 *
 * @example
 * ```typescript
 * const resolved = yield* loadProcessors([markdownProcessor, shikiProcessor])
 * ```
 */
export function* loadProcessors(processors: readonly Processor[]): Operation<ResolvedProcessors> {
  const resolved = resolveProcessors(processors)
  yield* preloadProcessors(resolved.processors)
  return resolved
}
