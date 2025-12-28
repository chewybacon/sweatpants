/**
 * processor-orchestrator.ts
 *
 * High-level processor orchestration API.
 * Coordinates processor pipelines and integrates with the transform system.
 */
import { createApi } from '@effectionx/context-api'
import type { Operation } from 'effection'
import type { ProcessorChain, ProcessorFactory } from './types'
import { tripleBufferTransform } from './tripleBuffer'
import { paragraph } from './settlers'
import { createProcessorChain } from './processor-chain'
import { withProcessorLogging } from './processor-api'

// Define orchestration operations
interface ProcessorOrchestration {
  createPipeline(processors: ProcessorChain): Operation<any>
  createTransform(settler?: any, processors?: ProcessorChain): Operation<any>
  applyMiddleware(pipeline: any): Operation<any>
}

// Create the orchestration API
const orchestrationApi = createApi<ProcessorOrchestration>(
  'processor-orchestration',
  {
    *createPipeline(processors: ProcessorChain): Operation<any> {
      // Create a processor chain with middleware applied
      yield* withProcessorLogging()
      return createProcessorChain(processors)
    },

    *createTransform(settler: any = paragraph, processors: ProcessorChain = []): Operation<any> {
      // Create a triple buffer transform with enhancer pipeline
      yield* withProcessorLogging()
      return tripleBufferTransform({
        chunker: settler,
        enhancer: processors
      })
    },

    *applyMiddleware(pipeline: any): Operation<any> {
      // Apply middleware to the processor orchestration
      yield* withProcessorLogging()
      return pipeline
    }
  }
)

// Export operations
export const {
  createPipeline,
  createTransform,
  applyMiddleware
} = orchestrationApi.operations

// Export the API for middleware
export const processorOrchestration = orchestrationApi



// Import processors statically
import { markdown, syntaxHighlight, characterReveal, wordReveal } from './processors'

// Convenience functions for common use cases
export function createMarkdownPipeline(): ProcessorFactory {
  return createProcessorChain([markdown, syntaxHighlight])
}

export function createRevealPipeline(): ProcessorFactory {
  return createProcessorChain([characterReveal(50)])
}

export function createFullProcessingPipeline(): ProcessorFactory {
  return createProcessorChain([markdown, syntaxHighlight, characterReveal(50)])
}

// Additional convenience pipelines
export function createMarkdownOnlyPipeline(): ProcessorFactory {
  return createProcessorChain([markdown])
}

export function createSyntaxHighlightOnlyPipeline(): ProcessorFactory {
  return createProcessorChain([syntaxHighlight])
}

export function createFastRevealPipeline(): ProcessorFactory {
  return createProcessorChain([characterReveal(25)])
}

export function createSlowRevealPipeline(): ProcessorFactory {
  return createProcessorChain([characterReveal(100)])
}

export function createWordRevealPipeline(): ProcessorFactory {
  return createProcessorChain([wordReveal(150)])
}

// Middleware for orchestration
export function* withOrchestrationLogging() {
  yield* processorOrchestration.around({
    createPipeline: function* ([processors], next) {
      console.log(`🔧 Creating processor pipeline with ${processors.length} processors`)
      const result = yield* next(processors)
      console.log('✅ Processor pipeline created')
      return result
    },

    createTransform: function* ([settler, processors], next) {
      console.log(`🎨 Creating transform with ${processors?.length || 0} processors`)
      const result = yield* next(settler, processors)
      console.log('✅ Transform created')
      return result
    }
  })
}