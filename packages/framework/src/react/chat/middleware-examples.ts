/**
 * middleware-examples.ts
 *
 * Examples of how to use the extensible APIs with middleware.
 * Shows practical usage patterns for the rendering engine.
 */

// Example: Custom processor with logging and validation
import { processors, withProcessorLogging, withProcessorValidation } from './processor-api'
import { rendering, withRenderingMetrics, withRenderingValidation } from './rendering-pipeline'
import type { ProcessorContext, ProcessedOutput } from './types'

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
    process: function* ([ctx], next) {
      const cacheKey = `${ctx.chunk}-${ctx.accumulated.length}`

      // Check cache first
      if (cache.has(cacheKey)) {
        console.log('💾 Cache hit for processor')
        return cache.get(cacheKey)!
      }

      // Compute and cache
      const result = yield* next(ctx)
      cache.set(cacheKey, result)

      console.log('💾 Cached processor result')
      return result
    }
  })
}

// Example: Custom rendering middleware for A/B testing
export function* withRenderingABTest(experimentId: string, variant: 'A' | 'B') {
  yield* rendering.around({
    scheduleReveal: function* ([content, strategy], next) {
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
    process: function* ([ctx], next) {
      // Transform the input before processing
      const transformedCtx = {
        ...ctx,
        chunk: transform(ctx.chunk)
      }

      const result = yield* next(transformedCtx)

      // Transform the output after processing
      return {
        ...result,
        raw: transform(result.raw)
      }
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