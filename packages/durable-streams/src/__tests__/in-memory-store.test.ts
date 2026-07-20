import { run } from 'effection'
import { describe, expect, it } from 'vitest'
import { appendTestTokens, completeTestBuffer } from './test-writer.ts'

import { createInMemoryBufferStore, createInMemoryRegistryStore } from '../in-memory-store.ts'
import { defineTokenBufferStoreConformance } from './token-buffer-store-conformance.ts'

defineTokenBufferStoreConformance('in-memory', () => createInMemoryBufferStore<string>())

describe('in-memory-store', () => {
  it('supports append/read/complete lifecycle', async () => {
    await run(function* () {
      const store = createInMemoryBufferStore<string>()
      const buffer = yield* store.create('b1')

      yield* appendTestTokens(buffer, ['a', 'b'])
      const first = yield* buffer.read(0)
      expect(first.tokens).toEqual(['a', 'b'])
      expect(first.lsn).toBe(2)

      yield* completeTestBuffer(buffer)
      expect(yield* buffer.isComplete()).toBe(true)
      expect(yield* store.get('b1')).toBeTruthy()

      yield* store.delete('b1')
      expect(yield* store.get('b1')).toBeNull()
    })
  })

  it('tracks session registry refcounts', async () => {
    await run(function* () {
      const store = createInMemoryRegistryStore()
      yield* store.set('s1', { refCount: 1, createdAt: Date.now() })
      expect(yield* store.updateRefCount('s1', 2)).toBe(3)
      expect((yield* store.get('s1'))?.refCount).toBe(3)

      yield* store.delete('s1')
      expect(yield* store.get('s1')).toBeNull()
    })
  })
})
