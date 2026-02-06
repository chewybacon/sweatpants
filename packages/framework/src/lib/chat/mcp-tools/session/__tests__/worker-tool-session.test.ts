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

  // Extract the last non-empty line from stdout.
  // Worker threads (via web-worker) may write debug output to stdout
  // before the harness writes its JSON result on the final line.
  const lines = stdout.trim().split('\n')
  const jsonLine = lines[lines.length - 1]!
  return JSON.parse(jsonLine)
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
      expect(result.error).toContain('Tool not found')
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

  describe('multiple sample calls', () => {
    it('handles sequential sample requests', async () => {
      const result = await runScenario('multi_sample')

      expect(result.status).toBe('completed')
      expect(result.result).toEqual({
        responses: ['Response 1', 'Response 2', 'Response 3'],
      })
    })
  })

  describe('elicitation decline', () => {
    it('handles user declining elicitation', async () => {
      const result = await runScenario('elicit_decline')

      expect(result.status).toBe('completed')
      expect(result.result).toEqual({ cancelled: true })
    })
  })

  describe('elicitation cancel', () => {
    it('handles elicitation being cancelled (action: cancel)', async () => {
      const result = await runScenario('elicit_cancel')

      expect(result.status).toBe('completed')
      expect(result.result).toEqual({ action: 'delete all', wasCancelled: true })
    })
  })

  describe('complex flows', () => {
    it('handles sample followed by elicit', async () => {
      const result = await runScenario('sample_then_elicit')

      expect(result.status).toBe('completed')
      expect(result.result).toEqual({
        greeting: 'Hello Alice!',
        wasEdited: false,
      })
    })
  })

  // ===========================================================================
  // book_flight flow - matches the e2e book-flight.spec.ts code paths
  // ===========================================================================
  describe('book_flight flow (e2e blackbox)', () => {
    it('completes full flow: pickFlight → pickSeat → sample → result', async () => {
      const result = await runScenario('book_flight')

      // Should have received 2 elicits and 1 sample
      expect(result.elicitCount).toBe(2)
      expect(result.sampleCount).toBe(1)
      expect(result.elicitKeys).toEqual(['pickFlight', 'pickSeat'])

      // Status should transition through awaiting_elicit
      expect(result.statusAfterFirstElicit).toBe('awaiting_elicit')
      expect(result.finalStatus).toBe('completed')

      // Result should match expected booking confirmation
      expect(result.result).toEqual({
        success: true,
        ticketNumber: 'TKT-TEST123',
        flight: {
          id: 'FL001',
          airline: 'SkyHigh',
        },
        seat: '3A',
        price: 299,
        route: { from: 'NYC', to: 'LAX' },
        travelTip: 'Remember to check the weather before you travel!',
      })

      // Verify event sequence
      expect(result.eventTypes).toContain('elicit_request')
      expect(result.eventTypes).toContain('sample_request')
      expect(result.eventTypes).toContain('result')
    })

    it('handles user declining flight selection', async () => {
      const result = await runScenario('book_flight_decline_flight')

      expect(result.status).toBe('completed')
      expect(result.result).toEqual({
        success: false,
        reason: 'flight_not_selected',
      })

      // Should only have 1 elicit (pickFlight) since user declined
      expect(result.eventTypes.filter((t: string) => t === 'elicit_request').length).toBe(1)
      // Should NOT have any sample requests (user bailed early)
      expect(result.eventTypes).not.toContain('sample_request')
    })

    it('handles user declining seat selection after accepting flight', async () => {
      const result = await runScenario('book_flight_decline_seat')

      expect(result.status).toBe('completed')
      expect(result.elicitCount).toBe(2) // Both elicits were triggered
      expect(result.result).toEqual({
        success: false,
        reason: 'seat_not_selected',
      })

      // Should NOT have any sample requests (user bailed at seat selection)
      expect(result.eventTypes).not.toContain('sample_request')
    })
  })

  // ===========================================================================
  // elicit with context - tests the new context field in elicit requests
  // ===========================================================================
  describe('elicit with context data', () => {
    it('passes context data through elicit request events', async () => {
      const result = await runScenario('elicit_with_context')

      expect(result.status).toBe('completed')
      expect(result.result).toEqual({ selectedFlightId: 'FL001' })

      // Verify context was passed through the elicit event
      expect(result.capturedContext).toEqual({
        flights: [
          { id: 'FL001', airline: 'SkyHigh', price: 299 },
          { id: 'FL002', airline: 'CloudAir', price: 349 },
        ],
        totalOptions: 2,
      })
    })
  })

  // ===========================================================================
  // elicit with spread context - MCP-style format users write
  // ===========================================================================
  describe('elicit with spread context (MCP style)', () => {
    it('extracts spread fields as context', async () => {
      const result = await runScenario('elicit_spread_context')

      expect(result.status).toBe('completed')
      expect(result.result).toEqual({ selectedFlightId: 'FL001' })

      expect(result.capturedContext).toEqual({
        flights: [
          { id: 'FL001', airline: 'SkyHigh', price: 299 },
          { id: 'FL002', airline: 'CloudAir', price: 349 },
        ],
        totalOptions: 2,
      })
    })
  })

  // ===========================================================================
  // sample with optional fields - tests systemPrompt, maxTokens, modelPreferences
  // ===========================================================================
  describe('sample with optional fields', () => {
    it('passes systemPrompt, maxTokens, and modelPreferences through sample events', async () => {
      const result = await runScenario('sample_with_options')

      expect(result.status).toBe('completed')
      expect(result.result).toEqual({
        text: 'Hello there!',
        model: 'test-model',
      })

      // Verify optional fields were passed through the sample event
      expect(result.capturedSampleRequest).toEqual({
        systemPrompt: 'You are a helpful assistant',
        maxTokens: 100,
        modelPreferences: {
          hints: [{ name: 'claude-3-5-sonnet' }],
          intelligencePriority: 0.8,
          speedPriority: 0.2,
        },
      })
    })
  })

  // ===========================================================================
  // sample with parsed response - tests the parsed field in sample results
  // ===========================================================================
  describe('sample with parsed response', () => {
    it('passes schema to sample request and receives parsed data in response', async () => {
      const result = await runScenario('sample_with_parsed')

      expect(result.status).toBe('completed')
      expect(result.result).toEqual({
        text: '{"name": "Alice", "age": 30}',
        parsed: { name: 'Alice', age: 30 },
      })

      // Verify schema was passed through the sample event
      expect(result.capturedSchema).toEqual({
        type: 'object',
        properties: {
          name: { type: 'string' },
          age: { type: 'number' },
        },
        required: ['name', 'age'],
      })
    })
  })

  // ===========================================================================
  // sample with tool calls - tests the toolCalls field in sample results
  // ===========================================================================
  describe('sample with tool calls', () => {
    it('passes tools and toolChoice to sample request and receives toolCalls in response', async () => {
      const result = await runScenario('sample_with_tools')

      expect(result.status).toBe('completed')
      expect(result.result).toEqual({
        text: '',
        toolCalls: [
          {
            id: 'call-123',
            name: 'get_weather',
            arguments: { location: 'New York' },
          },
        ],
      })

      // Verify tools were passed through the sample event
      expect(result.capturedTools).toEqual([
        {
          name: 'get_weather',
          description: 'Get the current weather',
          inputSchema: {
            type: 'object',
            properties: {
              location: { type: 'string' },
            },
            required: ['location'],
          },
        },
      ])
      expect(result.capturedToolChoice).toEqual({ type: 'auto' })
    })
  })

  // ===========================================================================
  // events afterLSN - tests resumability feature
  // ===========================================================================
  describe('events resumability', () => {
    it('supports afterLSN parameter to resume from specific position', async () => {
      const result = await runScenario('events_after_lsn')

      // multi_sample with count=3 produces: 3 sample_requests + 1 result = at least 4 events
      expect(result.totalEventCount).toBeGreaterThanOrEqual(4)

      // Events after LSN 2 should have fewer events than total
      expect(result.eventsAfter2Count).toBeLessThan(result.totalEventCount)

      // First event after LSN 2 should have LSN 3
      expect(result.firstEventAfter2Lsn).toBe(3)
    })
  })
})
