import { run } from 'effection'
import { describe, expect, it } from 'vitest'

import { createInMemoryBufferStore, createInMemoryRegistryStore } from '../in-memory-store.ts'

describe('in-memory-store', () => {
  it('supports append/read/complete lifecycle', async () => {
    await run(function* () {
      const store = createInMemoryBufferStore<string>()
      const buffer = yield* store.create('b1')

      yield* buffer.append(['a', 'b'])
      const first = yield* buffer.read(0)
      expect(first.tokens).toEqual(['a', 'b'])
      expect(first.lsn).toBe(2)

      yield* buffer.complete()
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
