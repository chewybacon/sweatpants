/**
 * Test Server Manager
 *
 * A simpler approach to managing the test server lifecycle.
 * Uses module-level state instead of Effection resources.
 *
 * Usage:
 * ```typescript
 * import { startTestServer, stopTestServer, getServerUrl } from '../setup/test-server'
 *
 * beforeAll(async () => {
 *   await startTestServer()
 * })
 *
 * afterAll(async () => {
 *   await stopTestServer()
 * })
 *
 * it('should work', async () => {
 *   const url = getServerUrl()
 *   // use url...
 * })
 * ```
 */
import { spawn, type ChildProcess } from 'child_process'
import * as path from 'path'
import { e2eConfig } from './config'

let serverProcess: ChildProcess | null = null
let serverUrl: string | null = null
let serverOutput: string = ''

/**
 * Start the test server.
 * Returns the server URL once ready.
 */
export async function startTestServer(options?: {
  port?: number
  timeout?: number
  appDir?: string
}): Promise<string> {
  if (serverProcess) {
    console.log('[test-server] Server already running at', serverUrl)
    return serverUrl!
  }

  const port = options?.port ?? e2eConfig.serverPort
  const timeout = options?.timeout ?? e2eConfig.serverStartTimeout
  const monorepoRoot = path.resolve(__dirname, '../../../../')
  const appDir = options?.appDir ?? path.join(monorepoRoot, 'apps/yo-chat')

  console.log(`[test-server] Starting server on port ${port}...`)
  console.log(`[test-server] App directory: ${appDir}`)

  serverOutput = ''

  // Spawn the dev server process with explicit port
  // Use pnpm exec vite dev to bypass the package.json script's fixed port
  serverProcess = spawn('pnpm', ['exec', 'vite', 'dev', '--port', String(port)], {
    cwd: appDir,
    env: {
      ...process.env,
      FORCE_COLOR: '0',
      NO_COLOR: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
  })

  // Capture output
  serverProcess.stdout?.on('data', (data) => {
    const str = data.toString()
    serverOutput += str
    if (process.env['E2E_DEBUG']) {
      process.stdout.write(`[server] ${str}`)
    }
  })

  serverProcess.stderr?.on('data', (data) => {
    const str = data.toString()
    serverOutput += str
    if (process.env['E2E_DEBUG']) {
      process.stderr.write(`[server:err] ${str}`)
    }
  })

  // Handle process errors
  let procError: string | null = null
  serverProcess.on('error', (err) => {
    procError = err.message
    console.error(`[test-server] Process error:`, err)
  })

  serverProcess.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`[test-server] Process exited with code ${code}`)
    }
    serverProcess = null
    serverUrl = null
  })

  // Wait for the server to be ready
  serverUrl = `http://localhost:${port}`
  const deadline = Date.now() + timeout
  let lastError: Error | null = null

  while (Date.now() < deadline) {
    if (procError) {
      throw new Error(`Server process error: ${procError}`)
    }
    if (!serverProcess || serverProcess.exitCode !== null) {
      throw new Error(
        `Server process exited with code ${serverProcess?.exitCode}. Output:\n${serverOutput.slice(-2000)}`
      )
    }

    try {
      // Try root URL - TanStack Start dev server should respond to any route
      const res = await fetch(serverUrl, {
        signal: AbortSignal.timeout(2000),
      })
      // Any response (even 404) means server is up
      if (res.status < 500) {
        console.log(`[test-server] Server ready at ${serverUrl} (status: ${res.status})`)
        return serverUrl
      }
    } catch (err) {
      lastError = err as Error
    }
    await new Promise((r) => setTimeout(r, 500))
  }

  throw new Error(
    `Server failed to start within ${timeout}ms. Last error: ${lastError?.message}\nOutput:\n${serverOutput.slice(-2000)}`
  )
}

/**
 * Stop the test server.
 */
export async function stopTestServer(): Promise<void> {
  if (!serverProcess) {
    console.log('[test-server] No server to stop')
    return
  }

  console.log(`[test-server] Shutting down (PID: ${serverProcess.pid})...`)

  // Send SIGTERM first for graceful shutdown
  serverProcess.kill('SIGTERM')

  // Wait for process to exit (with timeout)
  const exitDeadline = Date.now() + 5000
  while (Date.now() < exitDeadline) {
    if (!serverProcess || serverProcess.exitCode !== null) {
      console.log('[test-server] Server stopped')
      serverProcess = null
      serverUrl = null
      return
    }
    await new Promise((r) => setTimeout(r, 100))
  }

  // Force kill if still running
  if (serverProcess) {
    console.log('[test-server] Force killing...')
    serverProcess.kill('SIGKILL')
    serverProcess = null
    serverUrl = null
  }
}

/**
 * Get the server URL.
 * Throws if server is not running.
 */
export function getServerUrl(): string {
  if (!serverUrl) {
    throw new Error('Test server is not running. Call startTestServer() first.')
  }
  return serverUrl
}

/**
 * Check if the server is running.
 */
export function isServerRunning(): boolean {
  return serverProcess !== null && serverProcess.exitCode === null
}

/**
 * Use an existing server URL instead of spawning one.
 */
export function useExistingServer(url: string): void {
  serverUrl = url
  console.log(`[test-server] Using existing server at ${url}`)
}
