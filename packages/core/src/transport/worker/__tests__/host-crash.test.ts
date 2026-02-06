import { describe, it, expect } from '@effectionx/vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { createWorkerPrincipal } from '../host.ts'

describe('createWorkerPrincipal crash handling', () => {
  it('returns WorkerResult.error when worker throws', function* () {
    const workerPath = resolve(
      __dirname,
      'fixtures/crash-worker.mjs'
    )
    const workerUrl = pathToFileURL(workerPath)

    const { result: workerResult } = yield* createWorkerPrincipal<unknown>({
      workerUrl,
      initData: { toolName: 'crash', params: {}, sessionId: 'crash-session' },
      requestHandler: function* () {
        throw new Error('unexpected request')
      },
    })

    const result = yield* workerResult
    expect(result.type).toBe('error')
    if (result.type === 'error') {
      expect(result.error.message).toContain('worker crash')
    }
  })
})
