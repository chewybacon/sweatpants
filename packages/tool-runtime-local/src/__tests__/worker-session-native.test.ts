// @vitest-environment node
/**
 * Native Worker Tool Session Tests (Session-Contract Native)
 *
 * Tests that the session-contract-native worker tool session correctly:
 * - Creates body-mode sessions (REQ-065)
 * - Emits elicit/sample waits on the session log when the worker calls ctx.elicit()/ctx.sample()
 * - Emits terminal records on tool completion
 * - Preserves the worker protocol (unchanged worker fixture)
 */

import { describe, it, expect, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'

const execFileAsync = promisify(execFile)

vi.setConfig({ testTimeout: 15_000 })

const harnessCandidates = [
  resolve(process.cwd(), 'src/__tests__/fixtures/worker-session-native-harness.ts'),
  resolve(process.cwd(), 'packages/tool-runtime-local/src/__tests__/fixtures/worker-session-native-harness.ts'),
]

const harnessPath = (() => {
  const candidate = harnessCandidates.find((path) => existsSync(path))
  if (!candidate) {
    throw new Error('Failed to resolve worker-session-native-harness.ts fixture path')
  }
  return candidate
})()

async function runScenario(scenario: string) {
  const { stdout } = await execFileAsync(
    process.execPath,
    ['--conditions=production', '--import', 'tsx', harnessPath, scenario],
    { cwd: process.cwd() },
  )

  const lines = stdout.trim().split('\n')
  const jsonLine = lines[lines.length - 1]!
  return JSON.parse(jsonLine)
}

describe('NativeWorkerToolSession (session-contract native)', () => {
  describe('echo tool (no ctx calls)', () => {
    it('executes a tool and produces a terminal(result) record', async () => {
      const result = await runScenario('echo')

      expect(result.status).toBe('completed')
      expect(result.outcome).toBe('result')
      expect(result.result).toEqual({ echoed: 'hello' })
    })
  })

  describe('greeter tool (uses ctx.sample)', () => {
    it('emits a sample wait on the session log and produces a result', async () => {
      const result = await runScenario('greeter')

      expect(result.status).toBe('completed')
      expect(result.outcome).toBe('result')
      expect(result.hasSampleWait).toBe(true)
      expect(result.hasSampleAnswer).toBe(true)
      expect(result.result).toMatchObject({ greeting: 'Hello from the model!' })
    })
  })

  describe('confirmer tool (uses ctx.elicit)', () => {
    it('emits an elicit wait on the session log and produces a result', async () => {
      const result = await runScenario('confirmer')

      expect(result.status).toBe('completed')
      expect(result.outcome).toBe('result')
      expect(result.hasElicitWait).toBe(true)
      expect(result.hasElicitAnswer).toBe(true)
      expect(result.result).toMatchObject({ action: 'proceed', confirmed: true })
    })
  })

  // TC-N05 / REQ-065: the worker must not directly access the session log
  describe('worker does not directly access the session log', () => {
    it('worker source does not import TokenBufferStore or call emitWait', () => {
      const packageRoot = resolve(process.cwd())
      const workerFiles = [
        resolve(packageRoot, 'src/worker.ts'),
        resolve(packageRoot, 'src/worker-runner.ts'),
      ]
      for (const file of workerFiles) {
        if (!existsSync(file)) continue
        const source = readFileSync(file, 'utf8')
        expect(source, `${file} must not import TokenBufferStore`).not.toContain('TokenBufferStore')
        expect(source, `${file} must not call emitWait`).not.toContain('emitWait')
        expect(source, `${file} must not call emitEmission`).not.toContain('emitEmission')
      }
    })
  })
})
