/**
 * processor-chain.ts
 *
 * Utilities for composing multiple processors together.
 */
import type { Operation } from 'effection'
import type { ProcessorContext, ProcessorEmit, ProcessorFactory, ProcessedOutput } from './types'

/**
 * Chain multiple processors together so they run in sequence.
 * Each processor receives the output from the previous processor as input.
 *
 * This enables composition like: markdown → syntax highlighting → animations
 */
export function createProcessorChain(processors: ProcessorFactory[]): ProcessorFactory {
  return () => {
    // Create instances of all processors in the chain
    const processorInstances = processors.map(factory => factory())

    return function* chainedProcessor(ctx: ProcessorContext, emit: ProcessorEmit): Operation<void> {
      if (processorInstances.length === 0) {
        // No processors - passthrough
        yield* emit({ raw: ctx.chunk })
        return
      }

      if (processorInstances.length === 1) {
        // Single processor - direct call
        yield* processorInstances[0]!(ctx, emit)
        return
      }

      // Chain multiple processors sequentially
      let currentContext = ctx

      for (let i = 0; i < processorInstances.length; i++) {
        const processor = processorInstances[i]
        const isLastProcessor = i === processorInstances.length - 1

        if (!isLastProcessor) {
          // Intermediate processor - collect its output and create new context for next processor
          const intermediateOutputs: ProcessedOutput[] = []

          const intermediateEmit: ProcessorEmit = (output) => ({
            *[Symbol.iterator]() {
              intermediateOutputs.push(output)
            }
          })

          // Run this processor
          yield* processor!(currentContext, intermediateEmit)

          // Create new context for next processor based on this processor's output
          if (intermediateOutputs.length > 0) {
            const lastOutput = intermediateOutputs[intermediateOutputs.length - 1]!

            // Merge metadata from all intermediate outputs
            const mergedMeta = mergeProcessorMetadata(intermediateOutputs)

            currentContext = {
              ...currentContext,
              // The next processor sees the processed content as input
              chunk: lastOutput.raw || ctx.chunk,
              // Update accumulated content
              accumulated: currentContext.accumulated + (lastOutput.raw || ''),
              // Merge metadata
              meta: { ...currentContext.meta, ...mergedMeta } as any,
            }
          }
        } else {
          // Last processor - use the final emit
          yield* processor!(currentContext, emit)
        }
      }
    }
  }
}

/**
 * Merge metadata from multiple processor outputs.
 * Later processors can override earlier ones.
 */
export function mergeProcessorMetadata(outputs: ProcessedOutput[]): Record<string, unknown> {
  const result: Record<string, unknown> = {}

  for (const output of outputs) {
    for (const [key, value] of Object.entries(output)) {
      if (key !== 'raw') {
        result[key] = value
      }
    }
  }

  return result
}

/**
 * Create a processor that merges multiple processor outputs.
 * Useful for combining results from parallel processing.
 */
export function mergeProcessors(processors: ProcessorFactory[]): ProcessorFactory {
  return () => {
    const processorInstances = processors.map(factory => factory())

    return function* mergedProcessor(ctx: ProcessorContext, emit: ProcessorEmit): Operation<void> {
      const allOutputs: ProcessedOutput[] = []

      // Create emit collector that gathers all outputs
      const collectEmit: ProcessorEmit = (output) => ({
        *[Symbol.iterator]() {
          allOutputs.push(output)
        }
      })

      // Run all processors sequentially (for now - parallel would be more complex)
      for (const processor of processorInstances) {
        yield* processor!(ctx, collectEmit)
      }

      // Merge and emit final result
      if (allOutputs.length > 0) {
        const merged = mergeProcessorOutputs(allOutputs)
        yield* emit(merged)
      } else {
        // Fallback - emit raw if nothing was processed
        yield* emit({ raw: ctx.chunk })
      }
    }
  }
}

/**
 * Merge multiple ProcessedOutput objects into one.
 * Rules:
 * - raw: take from first output (they should all be the same)
 * - Other properties: merge, with later outputs taking precedence
 */
export function mergeProcessorOutputs(outputs: ProcessedOutput[]): ProcessedOutput {
  if (outputs.length === 0) {
    throw new Error('Cannot merge empty outputs')
  }

  const firstOutput = outputs[0]!
  const result: ProcessedOutput = {
    raw: firstOutput.raw, // All outputs should have the same raw content
  }

  // Merge all other properties
  for (const output of outputs) {
    for (const [key, value] of Object.entries(output)) {
      if (key !== 'raw') {
        result[key] = value
      }
    }
  }

  return result
}