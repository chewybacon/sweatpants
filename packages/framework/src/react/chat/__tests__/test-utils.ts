/**
 * test-utils.ts
 *
 * Shared test utilities for React chat testing.
 */
import { run } from 'effection'
import { codeFence } from '../settlers/code-fence'
import type { ProcessorContext, ProcessedOutput, SettleContext, Processor } from '../types'

/**
 * Helper to simulate settling code through the codeFence settler.
 * Used for testing code fence processing behavior.
 */
export function settleCode(chunks: string[]): Array<{ content: string; meta: any }> {
  const settler = codeFence()
  const results: Array<{ content: string; meta: any }> = []

  let pending = ''
  for (const chunk of chunks) {
    pending += chunk

    const ctx: SettleContext = {
      pending,
      elapsed: 0,
      settled: '',
      patch: { type: 'streaming_text', content: chunk },
    }

    for (const result of settler(ctx)) {
      results.push({ content: result.content, meta: result.meta || {} })
      // Remove settled content from pending
      pending = pending.slice(result.content.length)
    }
  }

  return results
}

/**
 * Helper to run a processor through multiple contexts (simulating a stream).
 * Generic version that works with any processor type.
 */
export async function runProcessorStream<TProcessor extends Processor>(
  processorFactory: () => TProcessor,
  contexts: ProcessorContext[]
): Promise<ProcessedOutput[][]> {
  const allEmissions: ProcessedOutput[][] = []
  const processor = processorFactory()

  for (const ctx of contexts) {
    const emissions: ProcessedOutput[] = []
    await run(function* () {
      yield* processor(ctx, function* (output) {
        emissions.push(output)
      })
    })
    allEmissions.push(emissions)
  }

  return allEmissions
}