import { run } from 'effection'
import { describe, expect, it } from 'vitest'

import {
  createInMemoryBufferStore,
  createInMemoryRegistryStore,
} from '../in-memory-store.ts'
import { createProtocolMutationResponse } from '../mutation-transport.ts'

const log = {
  debug: () => {},
}

describe('mutation-transport', () => {
  it('handles protocol create/append/close/delete', async () => {
    await run(function* () {
      const bufferStore = createInMemoryBufferStore<string>()
      const registryStore = createInMemoryRegistryStore()
      const sessionId = 'session-1'

      const putCtx = {
        request: new Request('http://example.test/sessions/session-1', { method: 'PUT' }),
        headers: new Headers(),
        status: 200,
      }

      yield* createProtocolMutationResponse({
        ctx: putCtx,
        sessionId,
        method: 'PUT',
        bufferStore,
        registryStore,
        log,
      })

      expect(putCtx.status).toBe(201)

      const postCtx = {
        request: new Request('http://example.test/sessions/session-1', {
          method: 'POST',
          body: 'hello',
        }),
        headers: new Headers(),
        status: 200,
      }

      yield* createProtocolMutationResponse({
        ctx: postCtx,
        sessionId,
        method: 'POST',
        bufferStore,
        registryStore,
        log,
      })

      expect(postCtx.status).toBe(204)

      const closeCtx = {
        request: new Request('http://example.test/sessions/session-1', {
          method: 'POST',
          headers: { 'stream-closed': 'true' },
        }),
        headers: new Headers(),
        status: 200,
      }

      yield* createProtocolMutationResponse({
        ctx: closeCtx,
        sessionId,
        method: 'POST',
        bufferStore,
        registryStore,
        log,
      })

      expect(closeCtx.status).toBe(204)
      expect(closeCtx.headers.get('Stream-Closed')).toBe('true')

      const deleteCtx = {
        request: new Request('http://example.test/sessions/session-1', { method: 'DELETE' }),
        headers: new Headers(),
        status: 200,
      }

      yield* createProtocolMutationResponse({
        ctx: deleteCtx,
        sessionId,
        method: 'DELETE',
        bufferStore,
        registryStore,
        log,
      })

      expect(deleteCtx.status).toBe(204)
      expect(yield* bufferStore.get(sessionId)).toBeNull()
      expect(yield* registryStore.get(sessionId)).toBeNull()
    })
  })
})
