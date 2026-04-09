import { describe, expect, it } from 'vitest'

import {
  deriveTurnKeyFromToolCalls,
  messageIdForAssistantFinal,
  messageIdForAssistantTools,
  messageIdForSystem,
  messageIdForTool,
  messageIdForUser,
} from '../message-identity.ts'

describe('message identity helpers', () => {
  it('derives the same turn key regardless of tool call order', () => {
    expect(deriveTurnKeyFromToolCalls(['call_b', 'call_a'])).toBe('call_a')
    expect(deriveTurnKeyFromToolCalls(['call_a', 'call_b'])).toBe('call_a')
  })

  it('builds deterministic assistant tools ids from sorted tool call ids', () => {
    expect(messageIdForAssistantTools(['call_b', 'call_a'])).toBe('assistant:tools:call_a,call_b')
    expect(messageIdForAssistantTools(['call_a', 'call_b'])).toBe('assistant:tools:call_a,call_b')
  })

  it('builds deterministic tool ids from tool call ids', () => {
    expect(messageIdForTool('call_pick')).toBe('tool:call_pick')
  })

  it('builds deterministic user and final assistant ids from a shared turn key', () => {
    expect(messageIdForUser('call_turn')).toBe('user:call_turn')
    expect(messageIdForAssistantFinal('call_turn')).toBe('assistant:final:call_turn')
  })

  it('builds deterministic system ids from transcript order', () => {
    expect(messageIdForSystem(0)).toBe('system:0')
    expect(messageIdForSystem(3)).toBe('system:3')
  })
})
