import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export type FetchHandler = (request: Request) => Promise<Response>

export function nodeRequestToWebRequest(req: IncomingMessage, baseUrl: string): Request {
  const url = new URL(req.url ?? '/', baseUrl)

  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) {
      continue
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(key, item)
      }
      continue
    }

    headers.set(key, value)
  }

  const init: RequestInit = {
    method: req.method ?? 'GET',
    headers,
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    init.body = Readable.toWeb(req) as ReadableStream<Uint8Array>
    ;(init as RequestInit & { duplex: 'half' }).duplex = 'half'
  }

  return new Request(url.toString(), init)
}

export async function sendWebResponse(res: ServerResponse, webRes: Response): Promise<void> {
  res.statusCode = webRes.status
  res.statusMessage = webRes.statusText

  webRes.headers.forEach((value, key) => {
    const existing = res.getHeader(key)
    if (existing === undefined) {
      res.setHeader(key, value)
      return
    }

    if (Array.isArray(existing)) {
      res.setHeader(key, [...existing, value])
      return
    }

    res.setHeader(key, [String(existing), value])
  })

  if (!webRes.body) {
    res.end()
    return
  }

  const nodeReadable = Readable.fromWeb(webRes.body as unknown as Parameters<typeof Readable.fromWeb>[0])
  await pipeline(nodeReadable, res)
}
