import { SessionContractError, type LogRecord, type WaitRecord } from './types.ts'

const allowedKinds = new Set(['wait', 'answer', 'emission', 'checkpoint', 'terminal', 'fate'])
const allowedWaits = new Set(['message', 'elicit', 'sample', 'call'])
const forbiddenTopologyKeys = new Set([
  'endpoint',
  'url',
  'transport',
  'handle',
  'factory',
  'childSessionId',
  'childWaitSeq',
  'sessionId',
])

export interface ValidationResult {
  ok: true
}

export function validateLog(records: readonly LogRecord[]): ValidationResult {
  let lastLsn = 0
  let expectedWaitSeq = 1
  let terminalSeen = false
  const answered = new Set<number>()
  const fated = new Set<number>()
  const idempotency = new Set<string>()
  const waitKinds = new Map<number, string>()

  for (const record of records) {
    if (!allowedKinds.has(record.kind)) {
      throw new SessionContractError('invalid_log_record', `Unknown record kind ${(record as { kind?: unknown }).kind}`)
    }
    if (!Number.isInteger(record.lsn) || record.lsn <= lastLsn) {
      throw new SessionContractError('invalid_log_record', 'LSNs must be strictly increasing')
    }
    lastLsn = record.lsn
    if (terminalSeen) {
      throw new SessionContractError('terminal_session', 'Record appears after terminal')
    }

    if (record.kind === 'wait') {
      validateWait(record, expectedWaitSeq)
      waitKinds.set(record.waitSeq, record.wait)
      expectedWaitSeq += 1
    } else if (record.kind === 'answer') {
      if (idempotency.has(record.idempotencyKey)) {
        throw new SessionContractError('idempotency_conflict', 'Duplicate idempotency key')
      }
      idempotency.add(record.idempotencyKey)
      if (record.waitSeq !== undefined) {
        const waitKind = waitKinds.get(record.waitSeq)
        if (!waitKind) {
          throw new SessionContractError('unknown_wait', `Answer references unknown wait ${record.waitSeq}`)
        }
        if (record.wait !== undefined && record.wait !== waitKind) {
          throw new SessionContractError('wait_kind_mismatch', `Answer kind ${record.wait} does not match wait kind ${waitKind}`)
        }
        if (answered.has(record.waitSeq) || fated.has(record.waitSeq)) {
          throw new SessionContractError('resume_unavailable', 'Wait already resolved')
        }
        answered.add(record.waitSeq)
      }
    } else if (record.kind === 'checkpoint') {
      if ('pendingWaits' in record || 'pending' in record || 'pendingChildren' in record) {
        throw new SessionContractError('invalid_log_record', 'Checkpoint must not enumerate pending work')
      }
    } else if (record.kind === 'fate') {
      if (!waitKinds.has(record.waitSeq)) {
        throw new SessionContractError('unknown_wait', `Fate references unknown wait ${record.waitSeq}`)
      }
      if (answered.has(record.waitSeq) || fated.has(record.waitSeq)) {
        throw new SessionContractError('resume_unavailable', 'Wait already resolved')
      }
      fated.add(record.waitSeq)
    } else if (record.kind === 'terminal') {
      terminalSeen = true
    }
  }

  return { ok: true }
}

function validateWait(record: WaitRecord, expectedWaitSeq: number): void {
  if (!allowedWaits.has(record.wait)) {
    throw new SessionContractError('invalid_log_record', `Unknown wait kind ${(record as { wait?: unknown }).wait}`)
  }
  if (record.waitSeq !== expectedWaitSeq) {
    throw new SessionContractError('invalid_log_record', `Expected waitSeq ${expectedWaitSeq}, got ${record.waitSeq}`)
  }
  assertNoTopology(record.payload)
  if (record.wait === 'call') {
    const payload = record.payload
    const keys = Object.keys(payload).sort()
    if (keys.length !== 2 || keys[0] !== 'input' || keys[1] !== 'target') {
      throw new SessionContractError('invalid_log_record', 'Call wait payload must be exactly { target, input }')
    }
  }
}

function assertNoTopology(value: unknown): void {
  if (value == null || typeof value !== 'object') {
    return
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (forbiddenTopologyKeys.has(key)) {
      throw new SessionContractError('invalid_log_record', `Topology field ${key} is not allowed in wait payloads`)
    }
    assertNoTopology(nested)
  }
}
