import {
  getThreadMetadataStore,
  type CreateThreadMetadataInput,
  type UpdateThreadMetadataInput,
} from '@/lib/thread-metadata-store'

function parseJsonBody<T>(request: Request): Promise<T | null> {
  return request.json().catch(() => null)
}

function extractThreadId(pathname: string): string | null {
  const match = pathname.match(/^\/api\/threaded-chat\/threads\/([^/]+)$/)
  return match ? decodeURIComponent(match[1] as string) : null
}

export async function handleThreadMetadataRequest(request: Request): Promise<Response> {
  const store = getThreadMetadataStore()
  const url = new URL(request.url)
  const pathname = url.pathname.replace(/\/$/, '')
  const method = request.method.toUpperCase()

  if (pathname === '/api/threaded-chat/threads') {
    if (method === 'GET') {
      return Response.json({ threads: store.list() })
    }

    if (method === 'POST') {
      const body = (await parseJsonBody<CreateThreadMetadataInput>(request)) ?? {}
      const thread = store.create(body)
      return Response.json({ thread }, { status: 201 })
    }

    return new Response('Method Not Allowed', { status: 405 })
  }

  const threadId = extractThreadId(pathname)
  if (!threadId) {
    return new Response('Not Found', { status: 404 })
  }

  if (method === 'GET') {
    const thread = store.get(threadId)
    if (!thread) {
      return new Response('Not Found', { status: 404 })
    }

    return Response.json({ thread })
  }

  if (method === 'PUT') {
    const body = (await parseJsonBody<CreateThreadMetadataInput>(request)) ?? {}
    const existing = store.get(threadId)
    if (existing) {
      const updated = store.update(threadId, body)
      return Response.json({ thread: updated }, { status: 200 })
    }

    const thread = store.create({ ...body, id: threadId })
    return Response.json({ thread }, { status: 201 })
  }

  if (method === 'PATCH') {
    const body = (await parseJsonBody<UpdateThreadMetadataInput>(request)) ?? {}
    const updated = store.update(threadId, body)
    if (!updated) {
      return new Response('Not Found', { status: 404 })
    }

    return Response.json({ thread: updated })
  }

  if (method === 'DELETE') {
    const deleted = store.delete(threadId)
    if (!deleted) {
      return new Response('Not Found', { status: 404 })
    }

    return new Response(null, { status: 204 })
  }

  return new Response('Method Not Allowed', { status: 405 })
}
