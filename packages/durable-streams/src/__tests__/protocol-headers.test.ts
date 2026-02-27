import { describe, expect, it } from 'vitest'

import {
  applySnapshotHeaders,
  createStreamETag,
  parseLiveMode,
  parseOffsetParam,
  parseSessionIdFromPath,
  parseTimeoutMs,
  toOffsetString,
} from '../protocol-headers.ts'

describe('protocol-headers', () => {
  it('parses session id and offset sentinels', () => {
    expect(parseSessionIdFromPath('/sessions/a%2Fb')).toBe('a/b')
    expect(parseOffsetParam('now')).toEqual({ value: null, isNow: true })
    expect(parseOffsetParam('-1')).toEqual({ value: 0, isNow: false })
    expect(parseOffsetParam('7')).toEqual({ value: 7, isNow: false })
    expect(parseOffsetParam('-4')).toEqual({ value: null, isNow: false })
  })

  it('formats and applies snapshot headers', () => {
    const headers = new Headers()
    applySnapshotHeaders(headers, 3, { tailOffset: 3, closed: true })

    expect(headers.get('Stream-Next-Offset')).toBe(toOffsetString(3))
    expect(headers.get('Stream-Up-To-Date')).toBe('true')
    expect(headers.get('Stream-Closed')).toBe('true')
    expect(createStreamETag('s1', 0, { tailOffset: 3, closed: false })).toBe('"s1:0:3:o"')
  })

  it('parses live mode and timeout', () => {
    expect(parseLiveMode('long-poll')).toBe('long-poll')
    expect(parseLiveMode('sse')).toBe('sse')
    expect(parseLiveMode('invalid')).toBeUndefined()
    expect(parseTimeoutMs('5')).toBe(5000)
    expect(parseTimeoutMs('-1', 123)).toBe(123)
  })
})
