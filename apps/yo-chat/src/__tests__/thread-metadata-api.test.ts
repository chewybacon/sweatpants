import { beforeEach, describe, expect, it } from 'vitest'
import { handleThreadMetadataRequest } from '@/lib/thread-metadata-api'
import { getThreadMetadataStore } from '@/lib/thread-metadata-store'

describe('thread metadata API', () => {
  beforeEach(() => {
    const store = getThreadMetadataStore()
    for (const thread of store.list()) {
      store.delete(thread.id)
    }
  })

  it('creates and lists thread metadata without transcript state', async () => {
    const createResponse = await handleThreadMetadataRequest(
      new Request('http://localhost/api/threaded-chat/threads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Discuss durable adapters',
          lastMessagePreview: 'Starting a new durable thread',
          messageCount: 0,
        }),
      }),
    )

    expect(createResponse.status).toBe(201)
    const createdPayload = (await createResponse.json()) as {
      thread: { id: string; title: string; lastMessagePreview: string; messageCount: number }
    }

    expect(createdPayload.thread.id).toBeTruthy()
    expect(createdPayload.thread.title).toBe('Discuss durable adapters')
    expect(createdPayload.thread.messageCount).toBe(0)

    const listResponse = await handleThreadMetadataRequest(
      new Request('http://localhost/api/threaded-chat/threads', { method: 'GET' }),
    )

    expect(listResponse.status).toBe(200)
    const listPayload = (await listResponse.json()) as {
      threads: Array<{ id: string; title: string }>
    }

    expect(listPayload.threads).toHaveLength(1)
    expect(listPayload.threads[0]?.id).toBe(createdPayload.thread.id)
    expect(listPayload.threads[0]?.title).toBe('Discuss durable adapters')
  })

  it('updates and deletes thread metadata by id', async () => {
    const store = getThreadMetadataStore()
    const thread = store.create({ id: 'thread-abc', title: 'Initial title' })

    const patchResponse = await handleThreadMetadataRequest(
      new Request(`http://localhost/api/threaded-chat/threads/${thread.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Renamed thread',
          lastMessagePreview: 'Now with metadata only',
          messageCount: 2,
        }),
      }),
    )

    expect(patchResponse.status).toBe(200)
    const patchedPayload = (await patchResponse.json()) as {
      thread: { title: string; lastMessagePreview: string; messageCount: number }
    }

    expect(patchedPayload.thread.title).toBe('Renamed thread')
    expect(patchedPayload.thread.lastMessagePreview).toBe('Now with metadata only')
    expect(patchedPayload.thread.messageCount).toBe(2)

    const deleteResponse = await handleThreadMetadataRequest(
      new Request(`http://localhost/api/threaded-chat/threads/${thread.id}`, {
        method: 'DELETE',
      }),
    )

    expect(deleteResponse.status).toBe(204)

    const missingResponse = await handleThreadMetadataRequest(
      new Request(`http://localhost/api/threaded-chat/threads/${thread.id}`, {
        method: 'GET',
      }),
    )

    expect(missingResponse.status).toBe(404)
  })

  it('supports PUT upsert semantics for thread metadata', async () => {
    const putResponse = await handleThreadMetadataRequest(
      new Request('http://localhost/api/threaded-chat/threads/thread-put', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'PUT-created thread',
          lastMessagePreview: 'Created via idempotent metadata route',
          messageCount: 1,
        }),
      }),
    )

    expect(putResponse.status).toBe(201)

    const secondPutResponse = await handleThreadMetadataRequest(
      new Request('http://localhost/api/threaded-chat/threads/thread-put', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'PUT-updated thread',
        }),
      }),
    )

    expect(secondPutResponse.status).toBe(200)
    const secondPutPayload = (await secondPutResponse.json()) as {
      thread: { id: string; title: string }
    }

    expect(secondPutPayload.thread.id).toBe('thread-put')
    expect(secondPutPayload.thread.title).toBe('PUT-updated thread')
  })
})
