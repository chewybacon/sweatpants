import { SessionContractError } from './types.ts'

const TOKEN_PREFIX = 'sc1'

export function waitToken(sessionId: string, waitSeq: number): string {
  if (!Number.isInteger(waitSeq) || waitSeq < 1) {
    throw new SessionContractError('unknown_wait', `Invalid waitSeq ${waitSeq}`)
  }
  return `${TOKEN_PREFIX}:${encodeURIComponent(sessionId)}:${waitSeq}`
}

export function parseWaitToken(token: string): { sessionId: string; waitSeq: number } {
  const parts = token.split(':')
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) {
    throw new SessionContractError('unknown_wait', 'Unknown wait token')
  }

  const waitSeq = Number(parts[2])
  if (!Number.isInteger(waitSeq) || waitSeq < 1) {
    throw new SessionContractError('unknown_wait', 'Unknown wait token')
  }

  return { sessionId: decodeURIComponent(parts[1]!), waitSeq }
}

/**
 * Mint an edge-side idempotency key for external inputs that arrive without
 * a client-minted key. Uses `crypto.randomUUID()` so that keys never collide
 * across process restarts or session-wrapper recreation over the same buffer
 * (the prior `<sessionId>:<ordinal>` scheme reset on restore and could replay).
 */
export function mintEdgeIdempotencyKey(_sessionId: string): string {
  return `edge:${crypto.randomUUID()}`
}
