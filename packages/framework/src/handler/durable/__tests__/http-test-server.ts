/**
 * HTTP Test Server for Durable Chat Handler
 *
 * Creates a minimal Node HTTP server that wraps a Fetch API handler.
 * Used for testing HTTP-level behavior like streaming, reconnection, etc.
 *
 * This uses the same pattern as TanStack Start's dev server:
 * - Convert Node IncomingMessage → Web Request
 * - Call handler.fetch(request) → Web Response
 * - Convert Web Response → Node ServerResponse
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http'
import { Readable } from 'stream'

// =============================================================================
// TYPES
// =============================================================================

export interface TestServerHandle {
  /** Base URL of the test server (e.g., http://localhost:3456) */
  url: string
  /** Port the server is listening on */
  port: number
  /** Close the server and release resources */
  close: () => Promise<void>
  /** The underlying Node HTTP server (for advanced use cases) */
  server: Server
}

export type FetchHandler = (request: Request) => Promise<Response>

// =============================================================================
// NODE ↔ WEB API BRIDGE
// =============================================================================

/**
 * Convert a Node IncomingMessage to a Web Request.
 */
function nodeRequestToWebRequest(
  req: IncomingMessage,
  baseUrl: string
): Request {
  const url = new URL(req.url ?? '/', baseUrl)

  // Build headers
  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (value) {
      if (Array.isArray(value)) {
        for (const v of value) {
          headers.append(key, v)
        }
      } else {
        headers.set(key, value)
      }
    }
  }

  // Build request init
  const init: RequestInit = {
    method: req.method ?? 'GET',
    headers,
  }

  // Add body for non-GET/HEAD requests
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    // Convert Node readable stream to Web ReadableStream
    init.body = Readable.toWeb(req) as ReadableStream<Uint8Array>
    // Required for streaming request bodies
    ;(init as RequestInit & { duplex: string }).duplex = 'half'
  }

  return new Request(url.toString(), init)
}

/**
 * Send a Web Response through a Node ServerResponse.
 */
async function sendWebResponse(
  res: ServerResponse,
  webRes: Response
): Promise<void> {
  // Set status
  res.statusCode = webRes.status
  res.statusMessage = webRes.statusText

  // Set headers
  webRes.headers.forEach((value, key) => {
    // Handle multiple values for same header
    const existing = res.getHeader(key)
    if (existing) {
      res.setHeader(key, Array.isArray(existing)
        ? [...existing, value]
        : [String(existing), value]
      )
    } else {
      res.setHeader(key, value)
    }
  })

  // Send body
  if (webRes.body) {
    const reader = webRes.body.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        res.write(value)
      }
    } finally {
      reader.releaseLock()
    }
  }

  res.end()
}

// =============================================================================
// TEST SERVER FACTORY
// =============================================================================

/**
 * Create an HTTP test server wrapping a Fetch API handler.
 *
 * @example
 * ```typescript
 * const handler = createDurableChatHandler({ ... })
 * const server = await createHttpTestServer(handler)
 *
 * try {
 *   const response = await fetch(`${server.url}/chat`, {
 *     method: 'POST',
 *     body: JSON.stringify({ messages: [...] })
 *   })
 *   // ... test streaming response
 * } finally {
 *   await server.close()
 * }
 * ```
 */
export async function createHttpTestServer(
  handler: FetchHandler
): Promise<TestServerHandle> {
  const server = createServer(async (req, res) => {
    const baseUrl = `http://localhost:${(server.address() as any)?.port ?? 0}`

    try {
      const webReq = nodeRequestToWebRequest(req, baseUrl)
      const webRes = await handler(webReq)
      await sendWebResponse(res, webRes)
    } catch (error) {
      console.error('[http-test-server] Handler error:', error)
      res.statusCode = 500
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({
        error: error instanceof Error ? error.message : 'Unknown error'
      }))
    }
  })

  // Start server on random available port
  await new Promise<void>((resolve, reject) => {
    server.on('error', reject)
    server.listen(0, () => {
      server.off('error', reject)
      resolve()
    })
  })

  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Failed to get server address')
  }

  const port = address.port
  const url = `http://localhost:${port}`

  return {
    url,
    port,
    server,
    close: () => new Promise((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err)
        else resolve()
      })
    }),
  }
}

/**
 * Create an HTTP test server as an async resource.
 * Automatically closes when the using block exits.
 *
 * @example
 * ```typescript
 * await using server = await createHttpTestServerResource(handler)
 * const response = await fetch(`${server.url}/chat`, { ... })
 * // server automatically closed when block exits
 * ```
 */
export async function createHttpTestServerResource(
  handler: FetchHandler
): Promise<TestServerHandle & AsyncDisposable> {
  const handle = await createHttpTestServer(handler)

  return {
    ...handle,
    [Symbol.asyncDispose]: async () => {
      await handle.close()
    },
  }
}
