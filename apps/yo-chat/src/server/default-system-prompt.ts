import { env } from '@/env'

export async function withDefaultSystemPrompt(request: Request): Promise<Request> {
  if (request.method.toUpperCase() !== 'POST') {
    return request
  }

  const contentType = request.headers.get('content-type') ?? ''
  if (!contentType.includes('application/json')) {
    return request
  }

  let body: unknown
  try {
    body = await request.clone().json()
  } catch {
    return request
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return request
  }

  const record = body as Record<string, unknown>
  if (typeof record['systemPrompt'] === 'string' && record['systemPrompt'].trim().length > 0) {
    return request
  }

  const messages = record['messages']
  if (
    Array.isArray(messages)
    && messages.some((message) => {
      return !!message && typeof message === 'object' && (message as { role?: unknown }).role === 'system'
    })
  ) {
    return request
  }

  const headers = new Headers(request.headers)
  headers.delete('content-length')

  return new Request(request.url, {
    method: request.method,
    headers,
    body: JSON.stringify({ ...record, systemPrompt: env.CHAT_SYSTEM_PROMPT }),
    signal: request.signal,
  })
}
