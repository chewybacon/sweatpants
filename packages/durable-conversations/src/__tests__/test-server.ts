import { createServer, type Server } from 'node:http'
import {
  nodeRequestToWebRequest,
  sendWebResponse,
  type FetchHandler,
} from '@sweatpants/stream-bridge'

export interface TestServerHandle {
  url: string
  port: number
  server: Server
  close: () => Promise<void>
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
      if (!res.headersSent && !res.writableEnded) {
        res.statusCode = 500
        res.setHeader('content-type', 'application/json')
        res.end(
          JSON.stringify({
            error: error instanceof Error ? error.message : 'Unknown server error',
          }),
        )
      }
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
