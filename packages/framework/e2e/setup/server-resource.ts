/**
 * Test Server Resource
 * 
 * Effection resource that spawns a test server for E2E tests.
 * Uses the yo-chat app as the test server since it has all the necessary
 * chat API endpoints and tool integrations.
 */
import { resource, call, type Operation } from 'effection'
import { spawn as spawnProcess, type ChildProcess } from 'child_process'
import { e2eConfig } from './config'
import * as path from 'path'

export interface TestServerHandle {
  /** Base URL for the server */
  url: string
  /** Port the server is running on */
  port: number
}

/**
 * Create and start a test server as an Effection resource.
 * Spawns the yo-chat dev server as a subprocess.
 * The server is automatically cleaned up when the scope exits.
 * 
 * @example
 * ```typescript
 * describe('my tests', () => {
 *   let server: TestServerHandle
 * 
 *   beforeAll(function*() {
 *     server = yield* useTestServer()
 *   })
 * 
 *   it('should work', function*() {
 *     const response = yield* call(() => fetch(`${server.url}/api/chat`, { ... }))
 *   })
 * })
 * ```
 */
export function useTestServer(options?: {
  port?: number
  timeout?: number
  /** Path to the app directory (defaults to apps/yo-chat) */
  appDir?: string
}): Operation<TestServerHandle> {
  return resource<TestServerHandle>(function* (provide) {
    const port = options?.port ?? e2eConfig.serverPort
    const url = `http://localhost:${port}`
    const timeout = options?.timeout ?? e2eConfig.serverStartTimeout
    
    // Resolve app directory relative to monorepo root
    const monorepoRoot = path.resolve(__dirname, '../../../../')
    const appDir = options?.appDir ?? path.join(monorepoRoot, 'apps/yo-chat')

    console.log(`[test-server] Starting server on port ${port}...`)
    console.log(`[test-server] App directory: ${appDir}`)

    // Spawn the dev server process
    const proc: ChildProcess = spawnProcess('pnpm', ['dev'], {
      cwd: appDir,
      env: {
        ...process.env,
        PORT: String(port),
        // Disable color output for cleaner logs
        FORCE_COLOR: '0',
        NO_COLOR: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
    })

    // Capture stdout/stderr for debugging
    let serverOutput = ''
    proc.stdout?.on('data', (data) => {
      const str = data.toString()
      serverOutput += str
      if (process.env['E2E_DEBUG']) {
        process.stdout.write(`[server] ${str}`)
      }
    })
    proc.stderr?.on('data', (data) => {
      const str = data.toString()
      serverOutput += str
      if (process.env['E2E_DEBUG']) {
        process.stderr.write(`[server:err] ${str}`)
      }
    })

    // Handle process errors
    let procError: Error | null = null
    proc.on('error', (err) => {
      procError = err
      console.error(`[test-server] Process error:`, err)
    })

    proc.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        console.error(`[test-server] Process exited with code ${code}`)
      }
    })

    // Wait for the server to be ready
    yield* call(async () => {
      const deadline = Date.now() + timeout
      let lastError: Error | null = null

      while (Date.now() < deadline) {
        // Check if process died
        if (procError) {
          throw new Error(`Server process error: ${procError.message}`)
        }
        if (proc.exitCode !== null) {
          throw new Error(
            `Server process exited with code ${proc.exitCode}. Output:\n${serverOutput.slice(-2000)}`
          )
        }

        try {
          const res = await fetch(`${url}/healthcheck`, { 
            signal: AbortSignal.timeout(1000) 
          })
          if (res.ok) {
            console.log(`[test-server] Server ready at ${url}`)
            return
          }
        } catch (err) {
          lastError = err as Error
        }
        await new Promise((r) => setTimeout(r, 500))
      }

      throw new Error(
        `Server failed to start within ${timeout}ms. Last error: ${lastError?.message}\nOutput:\n${serverOutput.slice(-2000)}`
      )
    })

    try {
      // Provide the server handle to tests
      yield* provide({ url, port })
    } finally {
      // Cleanup: kill the server process
      console.log(`[test-server] Shutting down (PID: ${proc.pid})...`)
      
      // Send SIGTERM first for graceful shutdown
      proc.kill('SIGTERM')

      // Wait for process to exit (with timeout)
      yield* call(async () => {
        const exitDeadline = Date.now() + 5000
        while (Date.now() < exitDeadline) {
          if (proc.exitCode !== null) {
            console.log(`[test-server] Server stopped`)
            return
          }
          await new Promise((r) => setTimeout(r, 100))
        }
        // Force kill if still running
        console.log(`[test-server] Force killing...`)
        proc.kill('SIGKILL')
      })
    }
  })
}

/**
 * Variant that uses an existing server URL instead of spawning one.
 * Useful for running tests against a dev server that's already running.
 * 
 * @example
 * ```typescript
 * // Use existing server at http://localhost:8000
 * const server = yield* useExistingServer('http://localhost:8000')
 * ```
 */
export function useExistingServer(url?: string): Operation<TestServerHandle> {
  return resource<TestServerHandle>(function* (provide) {
    const serverUrl = url ?? e2eConfig.backendUrl

    // Verify the server is reachable
    yield* call(async () => {
      const deadline = Date.now() + 5000
      let lastError: Error | null = null

      while (Date.now() < deadline) {
        try {
          const res = await fetch(`${serverUrl}/healthcheck`, {
            signal: AbortSignal.timeout(1000),
          })
          if (res.ok) {
            console.log(`[test-server] Connected to existing server at ${serverUrl}`)
            return
          }
        } catch (err) {
          lastError = err as Error
        }
        await new Promise((r) => setTimeout(r, 100))
      }
      throw new Error(
        `Server at ${serverUrl} is not reachable. Last error: ${lastError?.message}`
      )
    })

    // Parse port from URL
    const urlObj = new URL(serverUrl)
    const port = parseInt(urlObj.port || '80', 10)

    yield* provide({
      url: serverUrl,
      port,
    })
  })
}
