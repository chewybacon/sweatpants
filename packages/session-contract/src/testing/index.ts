export type {
  BaseProfileConformanceAdapter,
  BaseProfileConformanceResult,
} from './conformance.ts'
export { runBaseProfileConformance } from './conformance.ts'

import type { Operation } from 'effection'

import { createAgent } from '../create-agent.ts'
import { deriveStatus } from '../derive.ts'
import { createInMemorySession, createSessionContractInMemoryStore, restoreInMemorySession } from '../in-memory-session.ts'
import { waitToken } from '../token.ts'
import { validateLog } from '../validator.ts'
import type { ConformanceAdapter, LogRecord } from '../types.ts'

export type ConformanceProfile = 'base' | 'full'

export interface RequirementCoverage {
  requirement: string
  profiles: ConformanceProfile[]
  tests: string[]
  status: 'implemented' | 'scaffolded' | 'planned'
}

const implementedCoverage: Record<string, Omit<RequirementCoverage, 'requirement'>> = {
  'REQ-001': { profiles: ['base', 'full'], tests: ['TC-001', 'contract.test.ts'], status: 'implemented' },
  'REQ-002': { profiles: ['base', 'full'], tests: ['TC-002', 'contract.test.ts'], status: 'implemented' },
  'REQ-003': { profiles: ['base', 'full'], tests: ['TC-003', 'contract.test.ts'], status: 'implemented' },
  'REQ-004': { profiles: ['base', 'full'], tests: ['TC-004', 'contract.test.ts'], status: 'implemented' },
  'REQ-005': { profiles: ['base', 'full'], tests: ['TC-005', 'contract.test.ts'], status: 'implemented' },
  'REQ-006': { profiles: ['full'], tests: ['TC-006', 'contract.test.ts'], status: 'implemented' },
  'REQ-007': { profiles: ['base', 'full'], tests: ['contract.test.ts'], status: 'implemented' },
  'REQ-008': { profiles: ['base', 'full'], tests: ['TC-008', 'contract.test.ts'], status: 'implemented' },
  'REQ-009': { profiles: ['base', 'full'], tests: ['TC-009', 'contract.test.ts'], status: 'implemented' },
  'REQ-010': { profiles: ['base', 'full'], tests: ['TC-010', 'contract.test.ts'], status: 'implemented' },
  'REQ-011': { profiles: ['base', 'full'], tests: ['TC-011', 'contract.test.ts'], status: 'implemented' },
  'REQ-012': { profiles: ['base', 'full'], tests: ['TC-012', 'contract.test.ts'], status: 'implemented' },
  'REQ-013': { profiles: ['base', 'full'], tests: ['TC-N01', 'contract.test.ts'], status: 'implemented' },
  'REQ-014': { profiles: ['base', 'full'], tests: ['TC-014', 'contract.test.ts'], status: 'implemented' },
  'REQ-015': { profiles: ['base', 'full'], tests: ['contract.test.ts'], status: 'implemented' },
  'REQ-016': { profiles: ['full'], tests: ['contract.test.ts'], status: 'implemented' },
  'REQ-017': { profiles: ['base', 'full'], tests: ['TC-008', 'TC-022', 'contract.test.ts'], status: 'implemented' },
  'REQ-018': { profiles: ['base', 'full'], tests: ['TC-018', 'contract.test.ts'], status: 'implemented' },
  'REQ-019': { profiles: ['full'], tests: ['TC-019', 'contract.test.ts'], status: 'implemented' },
  'REQ-020': { profiles: ['base', 'full'], tests: ['TC-020', 'contract.test.ts'], status: 'implemented' },
  'REQ-021': { profiles: ['base', 'full'], tests: ['TC-021', 'contract.test.ts'], status: 'implemented' },
  'REQ-022': { profiles: ['base', 'full'], tests: ['TC-022', 'contract.test.ts'], status: 'implemented' },
  'REQ-023': { profiles: ['base', 'full'], tests: ['TC-023', 'contract.test.ts'], status: 'implemented' },
  'REQ-024': { profiles: ['full'], tests: ['TC-024', 'contract.test.ts'], status: 'implemented' },
  'REQ-025': { profiles: ['full'], tests: ['contract.test.ts'], status: 'implemented' },
  'REQ-026': { profiles: ['full'], tests: ['contract.test.ts'], status: 'implemented' },
  'REQ-027': { profiles: ['full'], tests: ['contract.test.ts'], status: 'implemented' },
  'REQ-028': { profiles: ['full'], tests: ['contract.test.ts'], status: 'implemented' },
  'REQ-029': { profiles: ['full'], tests: ['contract.test.ts'], status: 'implemented' },
  'REQ-030': { profiles: ['full'], tests: ['contract.test.ts'], status: 'scaffolded' },
  'REQ-031': { profiles: ['full'], tests: ['contract.test.ts'], status: 'implemented' },
  'REQ-032': { profiles: ['full'], tests: ['contract.test.ts'], status: 'implemented' },
  'REQ-033': { profiles: ['full'], tests: ['contract.test.ts'], status: 'scaffolded' },
  'REQ-034': { profiles: ['full'], tests: ['contract.test.ts'], status: 'scaffolded' },
  'REQ-035': { profiles: ['full'], tests: ['contract.test.ts'], status: 'scaffolded' },
  'REQ-036': { profiles: ['full'], tests: ['contract.test.ts'], status: 'implemented' },
  'REQ-037': { profiles: ['full'], tests: ['contract.test.ts'], status: 'scaffolded' },
  'REQ-038': { profiles: ['full'], tests: ['contract.test.ts'], status: 'implemented' },
  'REQ-039': { profiles: ['full'], tests: ['contract.test.ts'], status: 'implemented' },
  'REQ-040': { profiles: ['base', 'full'], tests: ['contract.test.ts'], status: 'implemented' },
  'REQ-041': { profiles: ['full'], tests: ['contract.test.ts'], status: 'implemented' },
  'REQ-042': { profiles: ['full'], tests: ['contract.test.ts'], status: 'implemented' },
  'REQ-043': { profiles: ['full'], tests: ['contract.test.ts'], status: 'scaffolded' },
  'REQ-044': { profiles: ['full'], tests: ['contract.test.ts'], status: 'implemented' },
  'REQ-045': { profiles: ['base', 'full'], tests: ['contract.test.ts'], status: 'scaffolded' },
  'REQ-046': { profiles: ['full'], tests: ['contract.test.ts'], status: 'scaffolded' },
  'REQ-047': { profiles: [], tests: ['docs/authoring-contract.md'], status: 'implemented' },
  'REQ-048': { profiles: ['base', 'full'], tests: ['contract.test.ts', 'testing/conformance.ts'], status: 'implemented' },
  'REQ-049': { profiles: ['base', 'full'], tests: ['profiles', 'requirementCoverageMatrix'], status: 'implemented' },
  'REQ-050': {
    profiles: ['base'],
    tests: [
      'packages/tool-runtime-local/acceptance/session-contract-kit.acceptance.test.ts',
      'packages/tool-runtime-agentcore/acceptance/session-contract-kit.acceptance.test.ts',
    ],
    status: 'implemented',
  },
  'REQ-051': { profiles: ['full'], tests: ['packages/framework/src/handler/durable/__tests__/session-contract-adapter.test.ts'], status: 'scaffolded' },
  'REQ-052': { profiles: ['full'], tests: ['contract.test.ts'], status: 'scaffolded' },
  'REQ-053': { profiles: ['full'], tests: ['contract.test.ts'], status: 'implemented' },
  'REQ-054': { profiles: [], tests: ['package-boundaries.test.ts'], status: 'implemented' },
  'REQ-055': { profiles: [], tests: ['package-boundaries.test.ts'], status: 'implemented' },
  'REQ-056': { profiles: [], tests: ['docs/legacy-agent-salvage.md', 'package-boundaries.test.ts'], status: 'implemented' },
  'REQ-057': { profiles: [], tests: ['packages/framework/src/lib/chat/mcp-tools/session/contract-adapter.ts'], status: 'implemented' },
}

export const requirementCoverageMatrix: RequirementCoverage[] = Array.from({ length: 57 }, (_, index) => {
  const requirement = `REQ-${String(index + 1).padStart(3, '0')}`
  const implemented = implementedCoverage[requirement]
  return implemented
    ? { requirement, ...implemented }
    : { requirement, profiles: [], tests: [], status: 'planned' }
})

export interface ConformanceCheckResult {
  name: string
  passed: true
}

export function* runBaseSmoke(adapter: ConformanceAdapter): Operation<ConformanceCheckResult> {
  const session = yield* adapter.createSession({ sessionId: `${adapter.name}-base-smoke` })
  if (session.id.length === 0) {
    throw new Error('session id is required')
  }
  return { name: adapter.name, passed: true }
}

export function* runFullSmoke(adapter: ConformanceAdapter): Operation<ConformanceCheckResult> {
  const sessionId = `${adapter.name}-full-smoke`
  const session = yield* adapter.createSession({ sessionId, mode: 'fold' })
  yield* session.send({ role: 'user', content: 'hello' }, { idempotencyKey: `${adapter.name}:message` })
  const status = yield* session.status()
  if (status.state === 'completed' || status.state === 'failed' || status.state === 'cancelled') {
    throw new Error('full-profile smoke expects a live session after one message')
  }
  if (adapter.simulateDeath) {
    const restored = yield* adapter.simulateDeath(sessionId)
    if (restored.id !== sessionId) {
      throw new Error('restored session id mismatch')
    }
  }
  return { name: adapter.name, passed: true }
}

export function assertLogConforms(sessionId: string, records: readonly LogRecord[]): void {
  validateLog(records)
  deriveStatus(sessionId, records)
}

export function createReferenceAdapter(profile: ConformanceProfile = 'full'): ConformanceAdapter {
  const store = createSessionContractInMemoryStore()
  const modes = new Map<string, 'body' | 'fold'>()
  return {
    name: `reference-${profile}`,
    profile,
    *createSession(options = {}) {
      const sessionId = options.sessionId ?? `reference-${profile}`
      const mode = options.mode ?? 'fold'
      modes.set(sessionId, mode)
      const session = yield* createInMemorySession({
        sessionId,
        mode,
        bufferStore: store,
      })
      return session
    },
    *simulateDeath(sessionId: string) {
      const session = yield* restoreInMemorySession({
        sessionId,
        mode: modes.get(sessionId) ?? 'fold',
        bufferStore: store,
      })
      return session
    },
  }
}

export function createAgentAdapter(): ConformanceAdapter {
  const store = createSessionContractInMemoryStore()
  const agent = createAgent({
    name: 'reference-agent',
    model: {
      *sample(request) {
        const firstMessage = request.messages[0] as { content?: unknown } | undefined
        return { ok: true, value: firstMessage?.content ?? 'ok' }
      },
    },
  })
  return {
    name: 'create-agent',
    profile: 'full',
    *createSession(options = {}) {
      return yield* agent.createSession({
        sessionId: options.sessionId ?? 'create-agent',
        bufferStore: store,
      })
    },
    *simulateDeath(sessionId: string) {
      return yield* agent.createSession({ sessionId, bufferStore: store })
    },
  }
}

export function syntheticValidLog(sessionId: string): LogRecord[] {
  const records: LogRecord[] = [
    { kind: 'wait', lsn: 1, waitSeq: 1, wait: 'elicit', payload: { key: 'confirm', message: 'Confirm?', responseSchema: {} } },
    { kind: 'answer', lsn: 2, waitSeq: 1, wait: 'elicit', payload: { ok: true, value: true }, idempotencyKey: 'client:1' },
    { kind: 'wait', lsn: 3, waitSeq: 2, wait: 'message', payload: {} },
  ]
  return records.map((record) => {
    if (record.kind === 'wait') {
      waitToken(sessionId, record.waitSeq)
    }
    return record
  })
}
