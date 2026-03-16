import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { Readable } from 'node:stream'

export interface TestServerHandle {
  url: string
  port: number
  server: Server
  close: () => Promise<void>
}

export type FetchHandler = (request: Request) => Promise<Response>

function nodeRequestToWebRequest(req: IncomingMessage, baseUrl: string): Request {
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

async function sendWebResponse(res: ServerResponse, webRes: Response): Promise<void> {
  res.statusCode = webRes.status
  res.statusMessage = webRes.statusText

  webRes.headers.forEach((value, key) => {
    res.setHeader(key, value)
  })

  if (webRes.body) {
    const reader = webRes.body.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) {
          break
        }
        res.write(value)
      }
    } finally {
      reader.releaseLock()
    }
  }

  res.end()
}

export async function createHttpTestServer(handler: FetchHandler): Promise<TestServerHandle> {
  const server = createServer(async (req, res) => {
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    const baseUrl = `http://localhost:${port}`

    try {
      const request = nodeRequestToWebRequest(req, baseUrl)
      const response = await handler(request)
      await sendWebResponse(res, response)
    } catch (error) {
      res.statusCode = 500
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : 'Unknown server error',
        }),
      )
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.on('error', reject)
    server.listen(0, () => {
      server.off('error', reject)
      resolve()
    })
  })

  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Failed to obtain test server address')
  }

  return {
    url: `http://localhost:${address.port}`,
    port: address.port,
    server,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error)
            return
          }
          resolve()
        })
      }),
  }
}
