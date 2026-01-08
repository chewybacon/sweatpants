#!/usr/bin/env node
/**
 * yo-mcp CLI
 *
 * MCP server demonstrating the durable HTTP handler with generator-based tools.
 *
 * Usage:
 *   # Run HTTP server
 *   pnpm dev
 *
 *   # Test with curl
 *   curl -X POST http://localhost:3001/mcp \
 *     -H "Content-Type: application/json" \
 *     -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"echo","arguments":{"message":"hello"}}}'
 */
import { run } from 'effection'
import {
  createMcpHandler,
  createInMemoryToolSessionStore,
  createToolSessionRegistry,
  type ToolSessionSamplingProvider,
  type SampleResult,
} from '@sweatpants/framework/chat/mcp-tools'
import { createToolsMap, allTools } from './tools/index.js'

const SERVER_NAME = 'yo-mcp'
const SERVER_VERSION = '0.1.0'
const PORT = parseInt(process.env['PORT'] || '3001', 10)

/**
 * Create a mock sampling provider.
 * In production, this would call an actual LLM.
 */
function createMockSamplingProvider(): ToolSessionSamplingProvider {
  return {
    *sample(_messages, options) {
      // Simple mock that echoes the prompt
      const maxTokens = options?.maxTokens ?? 100
      return {
        text: `[Mock LLM response - would generate up to ${maxTokens} tokens]`,
        model: 'mock-model',
        stopReason: 'endTurn',
      } as SampleResult
    },
  }
}

async function main() {
  // Use stderr for informational messages since MCP STDIO transport
  // expects only JSON-RPC messages on stdout
  console.error(`Starting ${SERVER_NAME} v${SERVER_VERSION}...`)
  console.error(`Registered ${allTools.length} tools:`)
  for (const tool of allTools) {
    console.error(`  - ${tool.name}: ${tool.description}`)
  }

  // Create the HTTP handler
  const { handler, cleanup } = await run(function* () {
    const store = createInMemoryToolSessionStore()
    const samplingProvider = createMockSamplingProvider()
    const registry = yield* createToolSessionRegistry(store, { samplingProvider })
    const tools = createToolsMap()

    const { handler, manager } = createMcpHandler({
      registry,
      tools,
      sessionTimeout: 300000, // 5 minutes
      sseRetryMs: 1000,
    })

    return {
      handler,
      cleanup: async () => {
        await run(function* () {
          yield* manager.cleanup()
        })
      },
    }
  })

  // Start HTTP server (Node.js)
  const server = await startNodeServer(handler, PORT)

  console.error(`\nHTTP server running on http://localhost:${PORT}`)
  console.error(`\nTest with:`)
  console.error(`  curl -X POST http://localhost:${PORT}/mcp \\`)
  console.error(`    -H "Content-Type: application/json" \\`)
  console.error(`    -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"echo","arguments":{"message":"hello"}}}'`)

  // Handle shutdown
  process.on('SIGINT', async () => {
    console.error('\nShutting down...')
    await cleanup()
    if ('close' in server) {
      (server as { close: () => void }).close()
    }
    process.exit(0)
  })
}

/**
 * Start a Node.js HTTP server (fallback when not using Bun)
 */
async function startNodeServer(
  handler: (request: Request) => Promise<Response>,
  port: number
): Promise<{ close: () => void }> {
  const { createServer } = await import('node:http')

  const server = createServer(async (req, res) => {
    // Add CORS headers for all responses
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Mcp-Session-Id, Last-Event-ID, Accept')
    res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id')

    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
      res.statusCode = 204
      res.end()
      return
    }

    try {
      // Convert Node request to Fetch Request
      const url = new URL(req.url || '/', `http://localhost:${port}`)
      const headers = new Headers()
      for (const [key, value] of Object.entries(req.headers)) {
        if (value) {
          headers.set(key, Array.isArray(value) ? value.join(', ') : value)
        }
      }

      // Read body for POST requests
      let body: string | undefined
      if (req.method === 'POST') {
        body = await new Promise<string>((resolve, reject) => {
          let data = ''
          req.on('data', (chunk) => (data += chunk))
          req.on('end', () => resolve(data))
          req.on('error', reject)
        })
      }

      const requestInit: RequestInit = {
        method: req.method || 'GET',
        headers,
      }
      if (body !== undefined) {
        requestInit.body = body
      }
      const request = new Request(url.toString(), requestInit)

      // Call handler
      const response = await handler(request)

      // Convert Fetch Response to Node response
      res.statusCode = response.status

      // Set headers
      response.headers.forEach((value, key) => {
        res.setHeader(key, value)
      })

      // Handle streaming vs regular response
      if (response.body) {
        const reader = response.body.getReader()
        const pump = async () => {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            res.write(value)
          }
          res.end()
        }
        pump().catch((err) => {
          console.error('Stream error:', err)
          res.end()
        })
      } else {
        const text = await response.text()
        res.end(text)
      }
    } catch (error) {
      console.error('Request error:', error)
      res.statusCode = 500
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ error: 'Internal server error' }))
    }
  })

  server.listen(port)
  return server
}

main().catch((error) => {
  console.error('Fatal error:', error)
  process.exit(1)
})
