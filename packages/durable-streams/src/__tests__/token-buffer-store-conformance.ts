import { run } from 'effection'
import { describe, expect, it } from 'vitest'

import type { TokenBufferStore } from '../types.ts'

export function defineTokenBufferStoreConformance(
  name: string,
  createStore: () => TokenBufferStore<string>,
  beforeTest: (skip: (note?: string) => never) => void = () => {},
): void {
  describe(`${name} TokenBufferStore conformance`, () => {
    it('uses 1-indexed total-length tail semantics for append/read', async ({ skip }) => {
      beforeTest(skip)
      const store = createStore()
      const buffer = await run(() => store.create(`${name}-tail-semantics`))

      expect(await run(() => buffer.append(['a', 'b', 'c']))).toBe(3)

      const all = await run(() => buffer.read(0))
      expect(all.tokens).toEqual(['a', 'b', 'c'])
      expect(all.lsn).toBe(3)

      const fromTwo = await run(() => buffer.read(2))
      expect(fromTwo.tokens).toEqual(['c'])
      expect(fromTwo.lsn).toBe(3)

      const pastTail = await run(() => buffer.read(10))
      expect(pastTail.tokens).toEqual([])
      expect(pastTail.lsn).toBe(3)
    })

    it('returns from waitForChange when the tail is already ahead of afterLSN', async ({ skip }) => {
      beforeTest(skip)
      const store = createStore()
      const buffer = await run(() => store.create(`${name}-wait-already-ahead`))

      await run(() => buffer.append(['a']))

      await run(() => buffer.waitForChange(0))
    })

    it('unblocks waitForChange when new data arrives after the current tail', async ({ skip }) => {
      beforeTest(skip)
      const store = createStore()
      const buffer = await run(() => store.create(`${name}-wait-new-data`))

      await run(() => buffer.append(['a']))
      const waitForChangePromise = run(() => buffer.waitForChange(1))

      await new Promise((resolve) => setTimeout(resolve, 20))
      await run(() => buffer.append(['b']))

      await waitForChangePromise
      const result = await run(() => buffer.read(1))
      expect(result.tokens).toEqual(['b'])
      expect(result.lsn).toBe(2)
    })

    it('unblocks waitForChange when the buffer completes without new data', async ({ skip }) => {
      beforeTest(skip)
      const store = createStore()
      const buffer = await run(() => store.create(`${name}-wait-complete`))

      const waitForChangePromise = run(() => buffer.waitForChange(0))

      await new Promise((resolve) => setTimeout(resolve, 20))
      await run(() => buffer.complete())

      await waitForChangePromise
      expect(await run(() => buffer.isComplete())).toBe(true)
    })
  })
}
