import { describe, expect, it } from 'vitest'
import type { ElicitExchange, SampleExchange } from '@sweatpants/core'
import {
  projectCoreElicitExchangeToMcpMessages,
  projectCoreExchangeToMcpMessages,
  projectCoreExchangesToMcpMessages,
  projectCoreSampleExchangeToMcpMessages,
} from '../core-exchange-projection.ts'

describe('core exchange to MCP projection', () => {
  it('projects core elicit exchanges without mutating the core exchange', () => {
    const exchange: ElicitExchange<{ flightId: string }, { ok: boolean }> = {
      kind: 'elicit',
      key: 'confirm',
      request: { message: 'Confirm?', context: { flightId: 'FL001' } },
      response: { action: 'accept', content: { ok: true } },
    }

    const messages = projectCoreElicitExchangeToMcpMessages(exchange)

    expect(messages).toHaveLength(2)
    expect(messages[0]).toMatchObject({
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'elicit:confirm', name: 'elicit:confirm' }],
    })
    expect(messages[1]).toMatchObject({
      role: 'user',
      content: [{ type: 'tool_result', toolUseId: 'elicit:confirm' }],
    })
    expect(exchange.kind).toBe('elicit')
    expect(exchange.request.context).toEqual({ flightId: 'FL001' })
  })

  it('projects core sample exchanges', () => {
    const exchange: SampleExchange<{ prompt: string }, { text: string }> = {
      kind: 'sample',
      key: 'summarize',
      request: { prompt: 'Summarize this' },
      response: { text: 'Summary' },
    }

    const messages = projectCoreSampleExchangeToMcpMessages(exchange)

    expect(messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Summarize this' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Summary' }] },
    ])
  })

  it('projects mixed core exchange arrays', () => {
    const elicit: ElicitExchange = {
      kind: 'elicit',
      key: 'confirm',
      request: { message: 'Confirm?' },
      response: { action: 'decline', reason: 'no' },
    }
    const sample: SampleExchange = {
      kind: 'sample',
      request: { prompt: 'Why?' },
      response: { content: 'Because.' },
    }

    expect(projectCoreExchangeToMcpMessages(elicit)).toHaveLength(2)
    expect(projectCoreExchangesToMcpMessages([elicit, sample])).toHaveLength(4)
  })
})
