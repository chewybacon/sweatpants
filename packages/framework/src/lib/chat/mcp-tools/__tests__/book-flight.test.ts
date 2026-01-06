/**
 * Tests for the Book Flight example tool
 *
 * Demonstrates testing a complex multi-turn MCP tool.
 */
import { z } from 'zod'
import { describe, it, expect } from '../../isomorphic-tools/__tests__/vitest-effection'
import { createMockMCPClient, runMCPTool } from '../mock-runtime'
import { bookFlightTool } from '../examples/book-flight'

describe('Book Flight Tool', () => {
  describe('happy path', () => {
    it('should complete booking when user confirms', function*() {
      const client = createMockMCPClient({
        elicitResponses: [
          // First elicit: flight selection
          {
            action: 'accept',
            content: { flightId: 'FL001', seatPreference: 'window' }
          },
          // Second elicit: confirmation
          {
            action: 'accept',
            content: { confirmed: true }
          },
        ],
        sampleResponses: [
          'Your SkyHigh flight FL001 departs at 08:00 and arrives at 11:00. Price: $299. Window seat requested.',
        ],
      })

      const result = yield* runMCPTool(
        bookFlightTool,
        { destination: 'NYC', date: '2024-06-15' },
        client
      )

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.booking.flightId).toBe('FL001')
        expect(result.booking.seatPreference).toBe('window')
        expect(result.booking.confirmationNumber).toBeDefined()
        expect(result.message).toContain('Successfully booked')
      }

      // Verify the interaction flow
      expect(client.elicitCalls).toHaveLength(2)
      expect(client.sampleCalls).toHaveLength(1)
      expect(client.notifyCalls.length).toBeGreaterThan(0)
    })
  })

  describe('cancellation scenarios', () => {
    it('should handle user declining flight selection', function*() {
      const client = createMockMCPClient({
        elicitResponses: [
          { action: 'decline' },
        ],
      })

      const result = yield* runMCPTool(
        bookFlightTool,
        { destination: 'LAX', date: '2024-07-01' },
        client
      )

      expect(result.success).toBe(false)
      expect(result.reason).toBe('user_declined_selection')

      // Should have logged the decline
      expect(client.logCalls).toContainEqual({
        level: 'info',
        message: 'User declined flight selection',
      })
    })

    it('should handle user cancelling (dismissing dialog)', function*() {
      const client = createMockMCPClient({
        elicitResponses: [
          { action: 'cancel' },
        ],
      })

      const result = yield* runMCPTool(
        bookFlightTool,
        { destination: 'SFO', date: '2024-08-01' },
        client
      )

      expect(result.success).toBe(false)
      expect(result.reason).toBe('user_cancelled')
    })

    it('should handle user not confirming booking', function*() {
      const client = createMockMCPClient({
        elicitResponses: [
          // Select flight
          { action: 'accept', content: { flightId: 'FL002', seatPreference: 'aisle' } },
          // Decline confirmation
          { action: 'accept', content: { confirmed: false } },
        ],
        sampleResponses: ['Flight summary...'],
      })

      const result = yield* runMCPTool(
        bookFlightTool,
        { destination: 'BOS', date: '2024-09-01' },
        client
      )

      expect(result.success).toBe(false)
      expect(result.reason).toBe('not_confirmed')
    })

    it('should handle invalid flight ID', function*() {
      const client = createMockMCPClient({
        elicitResponses: [
          { action: 'accept', content: { flightId: 'INVALID', seatPreference: 'window' } },
        ],
      })

      const result = yield* runMCPTool(
        bookFlightTool,
        { destination: 'SEA', date: '2024-10-01' },
        client
      )

      expect(result.success).toBe(false)
      expect(result.reason).toBe('invalid_flight_id')
    })
  })

  describe('progress tracking', () => {
    it('should send progress notifications throughout flow', function*() {
      const client = createMockMCPClient({
        elicitResponses: [
          { action: 'accept', content: { flightId: 'FL003', seatPreference: 'middle' } },
          { action: 'accept', content: { confirmed: true } },
        ],
        sampleResponses: ['Summary text'],
      })

      yield* runMCPTool(
        bookFlightTool,
        { destination: 'DEN', date: '2024-11-01' },
        client
      )

      // Should have multiple progress updates
      expect(client.notifyCalls.length).toBeGreaterThanOrEqual(4)

      // Check for expected progress messages
      const messages = client.notifyCalls.map(n => n.message)
      expect(messages).toContain('Found available flights')
      expect(messages).toContain('Processing selection...')
      expect(messages).toContain('Please confirm booking')
      expect(messages).toContain('Creating booking...')
    })
  })

  describe('elicitation details', () => {
    it('should include flight options in selection message', function*() {
      const client = createMockMCPClient({
        elicitResponses: [
          { action: 'decline' },
        ],
      })

      yield* runMCPTool(
        bookFlightTool,
        { destination: 'MIA', date: '2024-12-01' },
        client
      )

      const selectionElicit = client.elicitCalls[0]
      expect(selectionElicit.message).toContain('FL001')
      expect(selectionElicit.message).toContain('FL002')
      expect(selectionElicit.message).toContain('FL003')
      expect(selectionElicit.message).toContain('MIA')
    })

    it('should include summary in confirmation message', function*() {
      const summaryText = 'Your amazing flight awaits!'
      const client = createMockMCPClient({
        elicitResponses: [
          { action: 'accept', content: { flightId: 'FL001', seatPreference: 'aisle' } },
          { action: 'decline' },
        ],
        sampleResponses: [summaryText],
      })

      yield* runMCPTool(
        bookFlightTool,
        { destination: 'ATL', date: '2024-12-15' },
        client
      )

      const confirmElicit = client.elicitCalls[1]
      expect(confirmElicit.message).toContain(summaryText)
      expect(confirmElicit.message).toContain('Confirm')
    })
  })
})
