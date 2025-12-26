/**
 * middleware-examples.ts
 *
 * Examples of how to use the extensible APIs with middleware.
 * Shows practical usage patterns for the rendering engine.
 */

// Example: Custom processor with logging and validation
import { processors, withProcessorLogging, withProcessorValidation } from './processor-api'
import { rendering, withRenderingMetrics, withRenderingValidation } from './rendering-pipeline'
import type { ProcessedOutput } from './types'

export function* useEnhancedProcessing() {
  // Apply multiple middleware layers to processors
  yield* withProcessorLogging()
  yield* withProcessorValidation()

  // Now all processor operations go through the middleware
  // yield* processors.operations.process(ctx)
}

export function* useEnhancedRendering() {
  // Apply multiple middleware layers to rendering pipeline
  yield* withRenderingMetrics()
  yield* withRenderingValidation()

  // Now all rendering operations go through the middleware
  // yield* rendering.operations.transformBuffer(options)
}

// Example: Custom processor middleware for caching
export function* withProcessorCaching(cache: Map<string, ProcessedOutput>) {
  yield* processors.around({
    process: function*([ctx, emit], next) {
      const cacheKey = `${ctx.chunk}-${ctx.accumulated.length}`

      // Check cache first
      if (cache.has(cacheKey)) {
        console.log('💾 Cache hit for processor')
        yield* emit(cache.get(cacheKey)!)
        return
      }

      // Create caching emit wrapper
      const cachingEmit = function*(output: ProcessedOutput) {
        cache.set(cacheKey, output)
        yield* emit(output)
      }

      // Compute with caching
      yield* next(ctx, cachingEmit)
      console.log('💾 Cached processor result')
    }
  })
}

// Example: Custom rendering middleware for A/B testing
export function* withRenderingABTest(experimentId: string, variant: 'A' | 'B') {
  yield* rendering.around({
    scheduleReveal: function*([content, strategy], next) {
      const result = yield* next(content, strategy)

      // Modify reveal timing based on experiment variant
      if (variant === 'B') {
        // Variant B: slower reveal for testing user engagement
        result.delay *= 1.5
      }

      console.log(`🧪 A/B Test ${experimentId}: variant ${variant}, delay: ${result.delay}ms`)
      return result
    }
  })
}

// Example: Custom processor middleware for content transformation
export function* withContentTransformation(transform: (content: string) => string) {
  yield* processors.around({
    process: function*([ctx, emit], next) {
      // Transform the input before processing
      const transformedCtx = {
        ...ctx,
        chunk: transform(ctx.chunk)
      }

      // Create transforming emit wrapper
      const transformingEmit = function*(output: ProcessedOutput) {
        const transformedOutput = {
          ...output,
          raw: output.raw ? transform(output.raw) : output.raw
        }
        yield* emit(transformedOutput)
      }

      // Process with transformation
      yield* next(transformedCtx, transformingEmit)
    }
  })
}

// Usage example
export function* exampleUsage() {
  // Set up enhanced processing with multiple middleware
  yield* useEnhancedProcessing()
  yield* withProcessorCaching(new Map())
  yield* withContentTransformation(content => content.toUpperCase())

  // Set up enhanced rendering with multiple middleware
  yield* useEnhancedRendering()
  yield* withRenderingABTest('reveal-timing', 'B')

  // Now all operations automatically go through all the middleware layers
  // const processed = yield* processors.operations.process(ctx)
  // const rendered = yield* rendering.operations.transformBuffer(options)
}
