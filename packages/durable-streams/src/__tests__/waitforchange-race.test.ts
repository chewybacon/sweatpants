import { run, spawn, sleep } from 'effection'
import { describe, it, expect } from 'vitest'
import { createInMemoryBuffer } from '../in-memory-store.ts'

describe('waitForChange race + leak (review B-2, D-9)', () => {
  it('wakes when a change already happened before subscribing (race window)', async () => {
    await run(function* () {
      const buf = createInMemoryBuffer<string>('race')
      const writer = yield* buf.claimWriter({ ownerId: 'test', activationEpoch: 1 })
      // Append *before* anyone subscribes. The pre-check should return at once.
      yield* writer.append(['x'])
      yield* buf.waitForChange(0) // tokens.length(1) > 0 → immediate return
      const { tokens } = yield* buf.read(0)
      expect(tokens).toEqual(['x'])
    })
  })

  it('wakes on a later append after subscribing', async () => {
    await run(function* () {
      const buf = createInMemoryBuffer<string>('late')
      const writer = yield* buf.claimWriter({ ownerId: 'test', activationEpoch: 1 })
      yield* spawn(function* () {
        yield* sleep(5)
        yield* writer.append(['y'])
      })
      yield* buf.waitForChange(0)
      const { tokens } = yield* buf.read(0)
      expect(tokens).toEqual(['y'])
    })
  })

  it('does not leak subscriptions across many waitForChange calls', async () => {
    // A long-lived consumer that re-parks (like the agents driver tail) should
    // not accumulate subscriptions. We approximate the leak by driving N wakes
    // and asserting the process completes promptly; a leaking implementation
    // would grow subscribers and send() would slow/O(N²). This is a regression
    // guard for the B-2 fix.
    await run(function* () {
      const buf = createInMemoryBuffer<number>('leak')
      const writer = yield* buf.claimWriter({ ownerId: 'test', activationEpoch: 1 })
      const consumer = yield* spawn(function* () {
        let seen = 0
        // Read until we've consumed 200 appends, re-parking each time.
        let cursor = 0
        while (seen < 200) {
          const { tokens } = yield* buf.read(cursor)
          if (tokens.length > 0) {
            seen += tokens.length
            cursor += tokens.length
            continue
          }
          yield* buf.waitForChange(cursor)
        }
        return seen
      })
      for (let i = 0; i < 200; i++) {
        yield* writer.append([i])
      }
      const seen = yield* consumer
      expect(seen).toBe(200)
    })
  })

  it('two concurrent waiters both wake on a single append', async () => {
    // The dual-tail scenario from the agents session: two consumers parked on
    // the same buffer must both wake when an append fires send().
    await run(function* () {
      const buf = createInMemoryBuffer<string>('dual')
      const writer = yield* buf.claimWriter({ ownerId: 'test', activationEpoch: 1 })
      const a = yield* spawn(function* () {
        yield* buf.waitForChange(0)
        return 'a-woke'
      })
      const b = yield* spawn(function* () {
        yield* buf.waitForChange(0)
        return 'b-woke'
      })
      yield* sleep(5) // let both park
      yield* writer.append(['x'])
      expect(yield* a).toBe('a-woke')
      expect(yield* b).toBe('b-woke')
    })
  })
})
