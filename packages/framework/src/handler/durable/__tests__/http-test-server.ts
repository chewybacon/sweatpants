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
import { createServer, type Server } from 'node:http'
import {
  nodeRequestToWebRequest,
  sendWebResponse,
  type FetchHandler,
} from '@sweatpants/stream-bridge'

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
      if (res.headersSent || res.destroyed) {
        return
      }
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
