/**
 * rendering-pipeline.ts
 *
 * @deprecated This file is deprecated. Use the plugin system instead:
 * ```typescript
 * import { useChat } from '@tanstack/framework/react/chat'
 * import { markdownPlugin, shikiPlugin } from '@tanstack/framework/react/chat/plugins'
 *
 * useChat({ plugins: [markdownPlugin, shikiPlugin] })
 * ```
 *
 * Extensible rendering pipeline API using Effectionx context-api.
 * Allows the entire rendering pipeline to be wrapped with middleware.
 */
import { createApi } from '@effectionx/context-api'
import type { Operation } from 'effection'
import type { ChatPatch } from './types'
import type { DualBufferOptions } from './dualBuffer'

// Define the rendering pipeline operations
interface RenderingOperations {
  // Dual buffer transformation
  transformBuffer(options: DualBufferOptions): Operation<ChatPatch>

  // Content settling
  settleContent(content: string): Operation<{ settled: string; metadata?: any }>

  // Content processing
  processContent(ctx: { chunk: string; accumulated: string }): Operation<any>

  // Reveal timing
  scheduleReveal(content: string, strategy: string): Operation<{ delay: number; chunks: string[] }>
}

// Create the extensible rendering pipeline API
const renderingApi = createApi<RenderingOperations>(
  'rendering',
  {
    *transformBuffer(_options: DualBufferOptions): Operation<ChatPatch> {
      // Default implementation would delegate to dualBufferTransform
      throw new Error('transformBuffer not implemented - requires middleware')
    },

    *settleContent(content: string): Operation<{ settled: string; metadata?: any }> {
      // Default: immediate settling with no metadata
      return { settled: content }
    },

    *processContent(ctx: { chunk: string; accumulated: string }): Operation<any> {
      // Default: passthrough
      return { raw: ctx.chunk }
    },

    *scheduleReveal(content: string, _strategy: string): Operation<{ delay: number; chunks: string[] }> {
      // Default: immediate reveal
      return { delay: 0, chunks: [content] }
    }
  }
)

// Export the operations for easy use
export const {
  transformBuffer,
  settleContent,
  processContent,
  scheduleReveal
} = renderingApi.operations

// Export the API for middleware wrapping
export const rendering = renderingApi

// Example middleware: performance monitoring
export function* withRenderingMetrics() {
  yield* rendering.around({
    transformBuffer: function* ([options], next) {
      const start = Date.now()
      console.log('🎨 Starting buffer transformation...')

      const result = yield* next(options)

      const duration = Date.now() - start
      console.log(`🎨 Buffer transformation completed in ${duration}ms`)

      return result
    },

    settleContent: function* ([content], next) {
      const start = Date.now()
      const result = yield* next(content)
      const duration = Date.now() - start

      console.log(`📏 Content settled in ${duration}ms: ${result.settled.length} chars`)

      return result
    },

    processContent: function* ([ctx], next) {
      const start = Date.now()
      const result = yield* next(ctx)
      const duration = Date.now() - start

      console.log(`🔄 Content processed in ${duration}ms`)

      return result
    },

    scheduleReveal: function* ([content, strategy], next) {
      const result = yield* next(content, strategy)

      console.log(`⏰ Reveal scheduled: ${result.chunks.length} chunks, ${result.delay}ms delay, strategy: ${strategy}`)

      return result
    }
  })
}

// Example middleware: content validation
export function* withRenderingValidation() {
  yield* rendering.around({
    transformBuffer: function* ([options], next) {
      if (!options.settler) {
        throw new Error('Rendering validation: settler is required')
      }
      if (!options.processor && !Array.isArray(options.processor)) {
        throw new Error('Rendering validation: processor or processor array is required')
      }

      return yield* next(options)
    },

    settleContent: function* ([content], next) {
      if (typeof content !== 'string') {
        throw new Error('Rendering validation: content must be a string')
      }

      const result = yield* next(content)

      if (typeof result.settled !== 'string') {
        throw new Error('Rendering validation: settled content must be a string')
      }

      return result
    },

    processContent: function* ([ctx], next) {
      if (!ctx || typeof ctx.chunk !== 'string') {
        throw new Error('Rendering validation: context.chunk must be a string')
      }

      return yield* next(ctx)
    },

    scheduleReveal: function* ([content, strategy], next) {
      if (typeof content !== 'string') {
        throw new Error('Rendering validation: content must be a string')
      }
      if (typeof strategy !== 'string') {
        throw new Error('Rendering validation: strategy must be a string')
      }

      const result = yield* next(content, strategy)

      if (typeof result.delay !== 'number' || result.delay < 0) {
        throw new Error('Rendering validation: delay must be a non-negative number')
      }
      if (!Array.isArray(result.chunks)) {
        throw new Error('Rendering validation: chunks must be an array')
      }

      return result
    }
  })
}