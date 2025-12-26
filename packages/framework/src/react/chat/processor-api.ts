/**
 * processor-api.ts
 *
 * Extensible processor API using Effectionx context-api.
 * Allows processors to be wrapped with middleware for extensibility.
 *
 * This enables third-party processors to wrap existing processing
 * with logging, caching, validation, or other cross-cutting concerns.
 */
import { createApi } from '@effectionx/context-api'
import type { Operation } from 'effection'
import type { ProcessorContext, ProcessedOutput } from './types'

// Define the processor operations interface
interface ProcessorOperations {
  process(ctx: ProcessorContext): Operation<ProcessedOutput>
}

// Create the extensible processor API
const processorApi = createApi<ProcessorOperations>(
  'processor',
  {
    *process(ctx: ProcessorContext): Operation<ProcessedOutput> {
      // Default implementation - passthrough
      return { raw: ctx.chunk }
    }
  }
)

// Export the operations for easy use
export const { process } = processorApi.operations

// Export the API for middleware wrapping
export const processors = processorApi

// Helper to create a traditional processor that uses the extensible API
export function createApiProcessor(): (ctx: ProcessorContext, emit: (output: ProcessedOutput) => Operation<void>) => Operation<void> {
  return function* (ctx: ProcessorContext, emit: (output: ProcessedOutput) => Operation<void>) {
    const result = yield* process(ctx)
    yield* emit(result)
  }
}

// Example middleware: logging processor
export function* withProcessorLogging() {
  yield* processors.around({
    process: function* ([ctx], next) {
      console.log(`🔄 Processing chunk: "${ctx.chunk.slice(0, 50)}${ctx.chunk.length > 50 ? '...' : ''}"`)
      const start = Date.now()

      const result = yield* next(ctx)

      const duration = Date.now() - start
      console.log(`✅ Processed in ${duration}ms: ${result.raw.length} chars`)

      return result
    }
  })
}

// Example middleware: validation processor
export function* withProcessorValidation() {
  yield* processors.around({
    process: function* ([ctx], next) {
      if (!ctx.chunk || typeof ctx.chunk !== 'string') {
        throw new Error('Invalid processor context: chunk must be a string')
      }

      const result = yield* next(ctx)

      if (!result.raw || typeof result.raw !== 'string') {
        throw new Error('Invalid processor result: raw must be a string')
      }

      return result
    }
  })
}