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
import type { ProcessorContext, ProcessorEmit } from './types'

// Define the processor operations interface
interface ProcessorOperations {
  process(ctx: ProcessorContext, emit: ProcessorEmit): Operation<void>
}

// Create the extensible processor API
const processorApi = createApi<ProcessorOperations>(
  'processor',
  {
    *process(ctx: ProcessorContext, emit: ProcessorEmit): Operation<void> {
      // Default implementation - passthrough
      yield* emit({ raw: ctx.chunk })
    }
  }
)

// Export the operations for easy use
export const { process } = processorApi.operations

// Export the API for middleware wrapping
export const processors = processorApi

// Helper to create a traditional processor that uses the extensible API
export function createApiProcessor(): (ctx: ProcessorContext, emit: ProcessorEmit) => Operation<void> {
  return function* (ctx: ProcessorContext, emit: ProcessorEmit) {
    yield* process(ctx, emit)
  }
}

// Example middleware: logging processor
export function* withProcessorLogging() {
  yield* processors.around({
    process: function* ([ctx, emit], next) {
      console.log(`🔄 Processing chunk: "${ctx.chunk.slice(0, 50)}${ctx.chunk.length > 50 ? '...' : ''}"`)
      const start = Date.now()

      yield* next(ctx, emit)

      const duration = Date.now() - start
      console.log(`✅ Processed in ${duration}ms`)
    }
  })
}

// Example middleware: validation processor
export function* withProcessorValidation() {
  yield* processors.around({
    process: function* ([ctx, emit], next) {
      if (!ctx.chunk || typeof ctx.chunk !== 'string') {
        throw new Error('Invalid processor context: chunk must be a string')
      }

      yield* next(ctx, emit)
    }
  })
}