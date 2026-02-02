// @vitest-environment node
/**
 * Worker Tool Session Tests (Worker Transport)
 */

import { describe, it, expect } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve } from 'node:path'
import { existsSync } from 'node:fs'

const execFileAsync = promisify(execFile)

const harnessCandidates = [
  resolve(
    process.cwd(),
    'src/lib/chat/mcp-tools/session/__tests__/fixtures/worker-tool-session-harness.ts'
  ),
  resolve(
    process.cwd(),
    'packages/framework/src/lib/chat/mcp-tools/session/__tests__/fixtures/worker-tool-session-harness.ts'
  ),
]

const harnessPath = (() => {
  const candidate = harnessCandidates.find((path) => existsSync(path))
  if (!candidate) {
    throw new Error('Failed to resolve worker-tool-session-harness.ts fixture path')
  }
  return candidate
})()

async function runScenario(scenario: string) {
  const { stdout } = await execFileAsync(
    process.execPath,
    ['--conditions=production', '--import', 'tsx', harnessPath, scenario],
    { cwd: process.cwd() }
  )

  return JSON.parse(stdout.trim())
}

describe('WorkerToolSession', () => {
  describe('simple tool', () => {
    it('executes a tool and returns result', async () => {
      const result = await runScenario('echo')

      expect(result.status).toBe('completed')
      expect(result.result).toEqual({ echoed: 'hello' })
    })
  })

  describe('unknown tool', () => {
    it('returns error when tool does not exist', async () => {
      const result = await runScenario('missing')

      expect(result.status).toBe('failed')
      expect(result.error).toContain('Unknown tool')
    })
  })

  describe('sampling backchannel', () => {
    it('pauses for sampling and resumes with response', async () => {
      const result = await runScenario('sample')

      expect(result.statusBefore).toBe('awaiting_sample')
      expect(result.statusAfter).toBe('completed')
      expect(result.result).toEqual({
        greeting: 'Hello, Alice!',
        model: 'test-model',
      })
    })
  })

  describe('elicitation backchannel', () => {
    it('pauses for elicitation and resumes with response', async () => {
      const result = await runScenario('elicit')

      expect(result.statusBefore).toBe('awaiting_elicit')
      expect(result.statusAfter).toBe('completed')
      expect(result.result).toEqual({
        action: 'delete files',
        confirmed: true,
      })
    })
  })
})
