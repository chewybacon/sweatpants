import { run, spawn } from 'effection'
import { describe, expect, it } from 'vitest'

import {
  CapabilityResolverContext,
  createAgent,
  createInMemorySession,
  createLoopbackResolver,
  createSessionContractInMemoryStore,
  deriveStatus,
  listCapabilities,
  ModelProviderContext,
  parseWaitToken,
  PostOrphanPolicyContext,
  restoreInMemorySession,
  validateLog,
  waitToken,
} from '../index.ts'
import { createAgentAdapter, createReferenceAdapter, requirementCoverageMatrix, runBaseSmoke, runFullSmoke, syntheticValidLog } from '../testing/index.ts'
import type { InMemorySession } from '../index.ts'


describe('@sweatpants/session-contract', () => {
  it('derives wait identity from sessionId and waitSeq', () => {
    const token = waitToken('session/a', 3)
    expect(parseWaitToken(token)).toEqual({ sessionId: 'session/a', waitSeq: 3 })
  })

  it('validates the closed log grammar and waitSeq sequence', () => {
    const log = syntheticValidLog('s1')
    expect(validateLog(log)).toEqual({ ok: true })
    expect(deriveStatus('s1', log).state).toBe('parked')
    expect(() => validateLog([
      { kind: 'answer', lsn: 1, waitSeq: 1, wait: 'elicit', payload: { ok: true, value: true }, idempotencyKey: 'bad' },
    ])).toThrow(/unknown wait/i)
    expect(() => validateLog([
      { kind: 'wait', lsn: 1, waitSeq: 1, wait: 'elicit', payload: { key: 'confirm', message: 'Confirm?', responseSchema: {} } },
      { kind: 'answer', lsn: 2, waitSeq: 1, wait: 'sample', payload: { ok: true, value: true }, idempotencyKey: 'bad-kind' },
    ])).toThrow(/does not match/i)
  })

  it('runs a base in-memory wait/respond/cancel flow', async () => {
    await run(function* () {
      const session = yield* createInMemorySession({ sessionId: 's-flow' })
      const wait = yield* session.emitWait('elicit', {
        key: 'confirm',
        message: 'Confirm?',
        responseSchema: { type: 'boolean' },
      })

      expect(wait.waitSeq).toBe(1)
      let status = yield* session.status()
      expect(status.state).toBe('parked')
      expect(status.pendingWaits[0]?.token).toBe(waitToken('s-flow', 1))

      yield* session.respond(status.pendingWaits[0]!.token, true, { idempotencyKey: 'client:1', wait: 'elicit' })
      status = yield* session.status()
      expect(status.state).toBe('running')

      yield* session.cancel('done')
      status = yield* session.status()
      expect(status.state).toBe('cancelled')
      validateLog(yield* session.records())
    })
  })

  it('rejects appends after terminal records', async () => {
    await run(function* () {
      const session = yield* createInMemorySession({ sessionId: 's-terminal' })
      yield* session.terminal('result', { ok: true })
      expect((yield* session.status()).state).toBe('completed')
      try {
        yield* session.emitEmission({ late: true })
        throw new Error('expected terminal_session')
      } catch (error) {
        expect(error).toMatchObject({ code: 'terminal_session' })
      }
    })
  })

  // REQ-061: buffer fail() surfaces as session_lost in status()
  it('surfaces buffer fail() as session_lost terminal in status()', async () => {
    await run(function* () {
      const store = createSessionContractInMemoryStore()
      yield* store.create('s-fail')
      const buffer = yield* store.get('s-fail')!
      yield* buffer.fail(new Error('redis went away'))
      const session = yield* createInMemorySession({ sessionId: 's-fail', bufferStore: store })
      const status = yield* session.status()
      expect(status.state).toBe('failed')
      expect(status.terminal?.outcome).toBe('error')
      const payload = status.terminal?.payload as { ok: boolean; code: string }
      expect(payload.ok).toBe(false)
      expect(payload.code).toBe('session_lost')
    })
  })

  it('enforces per-session idempotency keys across sends and responds', async () => {
    await run(function* () {
      const session = yield* createInMemorySession({ sessionId: 's-idem' })
      const sendAck = yield* session.send({ role: 'user', content: 'hello' }, { idempotencyKey: 'dup-key' })
      const replayAck = yield* session.send({ role: 'user', content: 'hello' }, { idempotencyKey: 'dup-key' })
      expect(replayAck).toEqual(sendAck)

      yield* session.emitWait('elicit', {
        key: 'confirm',
        message: 'Confirm?',
        responseSchema: { type: 'boolean' },
      })
      const token = waitToken('s-idem', 1)
      try {
        yield* session.respond(token, true, { idempotencyKey: 'dup-key', wait: 'elicit' })
        throw new Error('expected idempotency conflict')
      } catch (error) {
        expect(error).toMatchObject({ code: 'idempotency_conflict' })
      }
    })
  })

  it('derives FIFO message binding regardless of append order', async () => {
    await run(function* () {
      const session = yield* createInMemorySession({ sessionId: 's-message-fifo' })
      yield* session.emitWait('message', {})
      yield* session.send({ role: 'user', content: 'first' }, { idempotencyKey: 'msg-first' })
      expect((yield* session.status()).state).toBe('running')
      expect((yield* session.status()).pendingWaits).toEqual([])

      yield* session.emitWait('message', {})
      expect((yield* session.status()).state).toBe('parked')
      yield* session.send({ role: 'user', content: 'second' }, { idempotencyKey: 'msg-second' })
      expect((yield* session.status()).state).toBe('running')
    })
  })

  it('expires waits lazily and rejects late answers with resume_unavailable', async () => {
    await run(function* () {
      const session = yield* createInMemorySession({ sessionId: 's-expire' })
      const wait = yield* session.emitWait(
        'elicit',
        { key: 'confirm', message: 'Confirm?', responseSchema: { type: 'boolean' } },
        { expiresAt: new Date(Date.now() - 1000).toISOString() },
      )

      try {
        yield* session.respond(waitToken('s-expire', wait.waitSeq), true, {
          idempotencyKey: 'expired-answer',
          wait: 'elicit',
        })
        throw new Error('expected resume_unavailable')
      } catch (error) {
        expect(error).toMatchObject({ code: 'resume_unavailable' })
      }

      const records = yield* session.records()
      expect(records.some((record) => record.kind === 'fate' && record.fate === 'expired')).toBe(true)
    })
  })

  it('orphans post-checkpoint waits on body-mode restore and parks for a fresh message', async () => {
    await run(function* () {
      const bufferStore = createSessionContractInMemoryStore()
      const session = yield* createInMemorySession({
        sessionId: 'body-restore',
        mode: 'body',
        bufferStore,
      })
      yield* session.checkpoint('body', { step: 'before-elicit' })
      yield* session.emitWait('elicit', {
        key: 'confirm',
        message: 'Confirm?',
        responseSchema: { type: 'boolean' },
      })

      const restored = yield* restoreInMemorySession({
        sessionId: 'body-restore',
        mode: 'body',
        bufferStore,
      })
      const records = yield* restored.records()
      expect(records.some((record) => record.kind === 'fate' && record.fate === 'orphaned')).toBe(true)
      expect((yield* restored.status()).pendingWaits[0]?.kind).toBe('message')
    })
  })

  it('uses scope-injected post-orphan policy when restoring body-mode sessions', async () => {
    await run(function* () {
      const bufferStore = createSessionContractInMemoryStore()
      const session = yield* createInMemorySession({ sessionId: 'body-auto-retry', mode: 'body', bufferStore })
      yield* session.checkpoint('body', { step: 'safe' })
      yield* session.emitWait('elicit', { key: 'confirm', message: 'Confirm?', responseSchema: {} })

      yield* PostOrphanPolicyContext.set('auto-retry')
      const restored = yield* restoreInMemorySession({ sessionId: 'body-auto-retry', mode: 'body', bufferStore })
      const records = yield* restored.records()
      expect(records.some((record) => record.kind === 'fate' && record.fate === 'orphaned')).toBe(true)
      expect((yield* restored.status()).state).toBe('running')
    })
  })

  it('restores fold-mode sessions with stable pending wait identity', async () => {
    await run(function* () {
      const bufferStore = createSessionContractInMemoryStore()
      const agent = createAgent({ name: 'fold-restore' })
      const session = yield* agent.createSession({ sessionId: 'fold-restore', bufferStore })
      yield* session.send({ role: 'user', content: 'hello' }, { idempotencyKey: 'fold-restore-msg' })
      const before = yield* session.status()
      const restored = yield* agent.createSession({ sessionId: 'fold-restore', bufferStore })
      const after = yield* restored.status()
      expect(after.pendingWaits).toHaveLength(before.pendingWaits.length)
      expect(after.pendingWaits[0]?.token).toBe(before.pendingWaits[0]?.token)
      expect(after.pendingWaits[0]?.kind).toBe('message')
    })
  })

  it('keeps capability listings declaration-derived', () => {
    expect(listCapabilities({ search: { input: { type: 'object' }, output: { type: 'string' } } })).toEqual([
      { name: 'search', input: { type: 'object' }, output: { type: 'string' } },
    ])
  })

  it('provides a small fold-mode createAgent over the same log grammar', async () => {
    await run(function* () {
      const agent = createAgent({ name: 'echo' })
      const session = yield* agent.createSession({ sessionId: 'agent-1' })
      yield* session.send({ role: 'user', content: 'hello' }, { idempotencyKey: 'msg:1' })
      const status = yield* session.status()
      expect(status.state).toBe('parked')
      expect(status.pendingWaits).toHaveLength(1)
      expect(status.pendingWaits[0]?.kind).toBe('message')
    })
  })

  it('prefers scope-injected model providers when the fold has no config-level model', async () => {
    await run(function* () {
      const agent = createAgent({ name: 'scoped-echo' })
      yield* ModelProviderContext.set({
        *sample() {
          return { ok: true, value: 'scoped-response' }
        },
      })
      const session = yield* agent.createSession({ sessionId: 'agent-scoped' })
      yield* session.send({ role: 'user', content: 'hello' }, { idempotencyKey: 'scoped-msg' })
      const events = yield* session.events()
      const seen: string[] = []
      for (let i = 0; i < 6; i += 1) {
        const next = yield* events.next()
        if (next.done) break
        if (next.value.kind === 'emission') {
          seen.push(JSON.stringify(next.value.payload))
        }
      }
      expect(seen.some((payload) => payload.includes('scoped-response'))).toBe(true)
    })
  })

  it('stores resolution metadata on answers only', async () => {
    await run(function* () {
      const session = yield* createInMemorySession({ sessionId: 'resolution-meta' })
      const wait = yield* session.emitWait('call', { target: 'worker', input: { q: 'x' } })
      yield* session.respond(waitToken('resolution-meta', wait.waitSeq), { ok: true }, {
        idempotencyKey: 'resolution-answer',
        wait: 'call',
        resolution: { provider: 'stub', childSessionId: 'child-1' },
      })
      const records = yield* session.records()
      const waitRecord = records.find((record) => record.kind === 'wait')
      const answerRecord = records.find((record) => record.kind === 'answer')
      expect(waitRecord).not.toHaveProperty('resolution')
      expect(answerRecord).toMatchObject({
        kind: 'answer',
        resolution: { provider: 'stub', childSessionId: 'child-1' },
      })
    })
  })

  it('routes symbolic call-waits through a scope-injected resolver', async () => {
    await run(function* () {
      const agent = createAgent({
        name: 'caller',
        capabilities: { worker: { input: { type: 'object' }, output: { type: 'object' } } },
        model: {
          *sample() {
            return { ok: true, value: { call: { target: 'worker', input: { topic: 'weather' } } } }
          },
        },
      })
      yield* CapabilityResolverContext.set({
        *call(target, input) {
          return { ok: true, value: { target, input, resolved: true } }
        },
      })

      const session = yield* agent.createSession({ sessionId: 'agent-call' })
      yield* session.send({ role: 'user', content: 'delegate' }, { idempotencyKey: 'agent-call-msg' })
      const events = yield* session.events()
      const kinds: string[] = []
      for (let i = 0; i < 10; i += 1) {
        const next = yield* events.next()
        if (next.done) break
        if (next.value.kind === 'wait') {
          kinds.push(next.value.wait)
        }
      }
      expect(kinds).toContain('sample')
      expect(kinds).toContain('call')
    })
  })

  it('rejects undeclared call targets before emitting a call-wait', async () => {
    await run(function* () {
      const agent = createAgent({
        name: 'caller',
        model: {
          *sample() {
            return { ok: true, value: { call: { target: 'missing', input: { topic: 'weather' } } } }
          },
        },
      })
      const session = yield* agent.createSession({ sessionId: 'agent-missing-call' })
      try {
        yield* session.send({ role: 'user', content: 'delegate' }, { idempotencyKey: 'agent-missing-call-msg' })
        throw new Error('expected unknown_target')
      } catch (error) {
        expect(error).toMatchObject({ code: 'unknown_target' })
      }
    })
  })

  it('reparents a child elicit wait through the loopback resolver', async () => {
    await run(function* () {
      const childStore = createSessionContractInMemoryStore()
      const agent = createAgent({
        name: 'parent',
        capabilities: { child: { input: { type: 'object' }, output: { type: 'object' } } },
        model: {
          *sample() {
            return { ok: true, value: { call: { target: 'child', input: { ask: true } } } }
          },
        },
        resolver: createLoopbackResolver({
          ttlPolicy() {
            return '2098-01-01T00:00:00.000Z'
          },
          *createChild() {
            const child = yield* createInMemorySession({ sessionId: 'loopback-child', mode: 'fold', bufferStore: childStore })
            yield* child.emitWait(
              'elicit',
              {
                key: 'approve',
                message: 'Approve child?',
                responseSchema: { type: 'object' },
              },
              { expiresAt: '2099-01-01T00:00:00.000Z' },
            )
            // Drive the child to terminal after the elicit is answered so the
            // loopback can drain to the child result (REQ-053).
            yield* spawn(function* () {
              const events = yield* child.events()
              let next = yield* events.next()
              while (!next.done) {
                if (next.value.kind === 'answer' && next.value.wait === 'elicit') {
                  yield* child.terminal('result', { approved: true })
                  return
                }
                next = yield* events.next()
              }
            })
            return child
          },
        }),
      })

      const parent = yield* agent.createSession({ sessionId: 'loopback-parent' })
      const events = yield* parent.events()
      const sendTask = yield* spawn(function* () {
        yield* parent.send({ role: 'user', content: 'delegate' }, { idempotencyKey: 'loopback-message' })
      })

      let reparentedToken: string | undefined
      let reparentedWaitJson = ''
      for (let i = 0; i < 12; i += 1) {
        const next = yield* events.next()
        if (next.done) break
        if (next.value.kind === 'wait' && next.value.wait === 'elicit') {
          expect(next.value.expiresAt).toBe('2098-01-01T00:00:00.000Z')
          expect(next.value.waitSeq).toBe(4)
          reparentedWaitJson = JSON.stringify(next.value)
          const status = yield* parent.status()
          reparentedToken = status.pendingWaits.find((wait) => wait.kind === 'elicit')?.token
          break
        }
      }
      expect(reparentedToken).toBeDefined()
      expect(reparentedWaitJson).not.toContain('loopback-child')
      expect(reparentedWaitJson).not.toContain('childWaitSeq')
      yield* parent.respond(reparentedToken!, { approved: true }, {
        idempotencyKey: 'loopback-approval',
        wait: 'elicit',
      })
      yield* sendTask

      let callAnswer: { payload: unknown } | undefined
      for (let i = 0; i < 8; i += 1) {
        const next = yield* events.next()
        if (next.done) break
        if (next.value.kind === 'answer' && next.value.wait === 'call') {
          callAnswer = next.value as { payload: unknown }
          break
        }
      }
      expect(callAnswer).toBeTruthy()
      // The parent call-wait MUST be answered with the child's terminal result,
      // not the relayed parent answer (REQ-053).
      expect(callAnswer!.payload).toMatchObject({ ok: true, value: { approved: true } })
    })
  })

  it('delivers unrecoverable child loss as a typed fold call failure', async () => {
    await run(function* () {
      const agent = createAgent({
        name: 'child-loss-parent',
        capabilities: { child: { input: { type: 'object' }, output: { type: 'object' } } },
        model: {
          *sample() {
            return { ok: true, value: { call: { target: 'child', input: {} } } }
          },
        },
        resolver: createLoopbackResolver({
          *createChild() {
            const child = yield* createInMemorySession({ sessionId: 'lost-child' })
            yield* child.terminal('error', { code: 'session_lost' })
            return child
          },
        }),
      })

      const parent = yield* agent.createSession({ sessionId: 'child-loss-parent' })
      yield* parent.send({ role: 'user', content: 'delegate' }, { idempotencyKey: 'child-loss-msg' })
      const events = yield* parent.events()
      let sawSessionLost = false
      for (let i = 0; i < 8; i += 1) {
        const next = yield* events.next()
        if (next.done) break
        if (next.value.kind === 'answer' && next.value.wait === 'call') {
          sawSessionLost = next.value.payload.ok === false && next.value.payload.code === 'session_lost'
          break
        }
      }
      expect(sawSessionLost).toBe(true)
    })
  })

  it('cascades parent cancellation into loopback child sessions', async () => {
    await run(function* () {
      let child: InMemorySession | undefined
      const agent = createAgent({
        name: 'cancelling-parent',
        capabilities: { child: { input: { type: 'object' }, output: { type: 'object' } } },
        model: {
          *sample() {
            return { ok: true, value: { call: { target: 'child', input: {} } } }
          },
        },
        resolver: createLoopbackResolver({
          *createChild() {
            child = yield* createInMemorySession({ sessionId: 'cancel-child' })
            yield* child.emitWait('elicit', { key: 'approve', message: 'Approve?', responseSchema: {} })
            return child
          },
        }),
      })

      const parent = yield* agent.createSession({ sessionId: 'cancel-parent' })
      const events = yield* parent.events()
      yield* spawn(function* () {
        yield* parent.send({ role: 'user', content: 'delegate' }, { idempotencyKey: 'cancel-parent-msg' })
      })

      for (let i = 0; i < 10; i += 1) {
        const next = yield* events.next()
        if (!next.done && next.value.kind === 'wait' && next.value.wait === 'elicit') break
      }
      expect(child).toBeDefined()
      yield* parent.cancel('user')
      expect((yield* parent.status()).state).toBe('cancelled')
      expect((yield* child!.status()).state).toBe('cancelled')
    })
  })

  it('clamps re-emitted TTL to the child deadline when the parent policy is later', async () => {
    await run(function* () {
      const childStore = createSessionContractInMemoryStore()
      const agent = createAgent({
        name: 'ttl-clamp-parent',
        capabilities: { child: { input: { type: 'object' }, output: { type: 'object' } } },
        model: {
          *sample() {
            return { ok: true, value: { call: { target: 'child', input: {} } } }
          },
        },
        resolver: createLoopbackResolver({
          ttlPolicy() {
            // Parent policy is later than the child deadline.
            return '2099-12-31T00:00:00.000Z'
          },
          *createChild() {
            const child = yield* createInMemorySession({ sessionId: 'ttl-clamp-child', mode: 'fold', bufferStore: childStore })
            yield* child.emitWait(
              'elicit',
              { key: 'approve', message: 'Approve?', responseSchema: {} },
              { expiresAt: '2098-01-01T00:00:00.000Z' },
            )
            yield* spawn(function* () {
              const events = yield* child.events()
              let next = yield* events.next()
              while (!next.done) {
                if (next.value.kind === 'answer' && next.value.wait === 'elicit') {
                  yield* child.terminal('result', { ok: true })
                  return
                }
                next = yield* events.next()
              }
            })
            return child
          },
        }),
      })

      const parent = yield* agent.createSession({ sessionId: 'ttl-clamp-parent' })
      const events = yield* parent.events()
      yield* spawn(function* () {
        yield* parent.send({ role: 'user', content: 'delegate' }, { idempotencyKey: 'ttl-clamp-msg' })
      })

      for (let i = 0; i < 12; i += 1) {
        const next = yield* events.next()
        if (next.done) break
        if (next.value.kind === 'wait' && next.value.wait === 'elicit') {
          // The re-emitted wait MUST NOT exceed the child's deadline (REQ-036).
          expect(next.value.expiresAt).toBe('2098-01-01T00:00:00.000Z')
          break
        }
      }
    })
  })

  it('validates wait payload shapes, topology-free waits, and checkpoint honesty', () => {
    expect(validateLog([
      { kind: 'wait', lsn: 1, waitSeq: 1, wait: 'sample', payload: { messages: [{ role: 'user', content: 'x' }], options: { model: 'stub' } } },
      { kind: 'wait', lsn: 2, waitSeq: 2, wait: 'call', payload: { target: 'worker', input: { x: 1 } } },
      { kind: 'checkpoint', lsn: 3, mode: 'fold', waitSeqWatermark: 2 },
    ])).toEqual({ ok: true })

    expect(() => validateLog([
      { kind: 'wait', lsn: 1, waitSeq: 1, wait: 'call', payload: { target: 'worker', input: {}, childSessionId: 'secret' } as never },
    ])).toThrow(/Topology field childSessionId/i)

    expect(() => validateLog([
      { kind: 'checkpoint', lsn: 1, mode: 'fold', waitSeqWatermark: 0, pendingWaits: [] } as never,
    ])).toThrow(/pending work/i)
  })

  it('keeps emissions inert for status, pending waits, and wait identity', () => {
    const withoutEmission = [
      { kind: 'wait' as const, lsn: 1, waitSeq: 1, wait: 'elicit' as const, payload: { key: 'confirm', message: 'Confirm?', responseSchema: {} } },
      { kind: 'wait' as const, lsn: 2, waitSeq: 2, wait: 'sample' as const, payload: { messages: [] } },
    ]
    const withEmission = [
      withoutEmission[0]!,
      { kind: 'emission' as const, lsn: 2, payload: { progress: 0.5 } },
      { ...withoutEmission[1]!, lsn: 3 },
    ]

    expect(validateLog(withEmission)).toEqual({ ok: true })
    expect(deriveStatus('emission-inert-a', withoutEmission).pendingWaits.map((wait) => wait.waitSeq)).toEqual([1, 2])
    expect(deriveStatus('emission-inert-b', withEmission).pendingWaits.map((wait) => wait.waitSeq)).toEqual([1, 2])
  })

  it('replays events after an LSN and gives concurrent subscribers ordered history', async () => {
    await run(function* () {
      const session = yield* createInMemorySession({ sessionId: 'events-replay' })
      yield* session.emitWait('elicit', { key: 'confirm', message: 'Confirm?', responseSchema: {} })
      yield* session.emitEmission({ chunk: 'a' })
      yield* session.emitWait('sample', { messages: [] })

      const afterOne = yield* session.events(1)
      expect((yield* afterOne.next()).value).toMatchObject({ lsn: 2, kind: 'emission' })
      expect((yield* afterOne.next()).value).toMatchObject({ lsn: 3, kind: 'wait' })

      const first = yield* session.events()
      const second = yield* session.events()
      const firstLsns = []
      const secondLsns = []
      for (let i = 0; i < 3; i += 1) {
        firstLsns.push((yield* first.next()).value?.lsn)
        secondLsns.push((yield* second.next()).value?.lsn)
      }
      expect(firstLsns).toEqual([1, 2, 3])
      expect(secondLsns).toEqual([1, 2, 3])
    })
  })

  it('edge-mints idempotency keys and distinguishes success from typed failure answers', async () => {
    await run(function* () {
      const session = yield* createInMemorySession({ sessionId: 'edge-keys' })
      yield* session.send({ role: 'user', content: 'hello' })
      const wait = yield* session.emitWait('sample', { messages: [] })
      yield* session.respond(waitToken('edge-keys', wait.waitSeq), { ok: false, code: 'session_lost' }, { wait: 'sample' })

      const records = yield* session.records()
      const answers = records.filter((record) => record.kind === 'answer')
      expect(answers).toHaveLength(2)
      expect(answers.every((record) => record.idempotencyKey.length > 0)).toBe(true)
      expect(answers[0]?.payload).toMatchObject({ ok: true })
      expect(answers[1]?.payload).toMatchObject({ ok: false, code: 'session_lost' })
    })
  })

  it('derives the complete status table from terminal/pending log conditions', async () => {
    await run(function* () {
      const running = yield* createInMemorySession({ sessionId: 'status-running' })
      expect((yield* running.status()).state).toBe('running')

      const parked = yield* createInMemorySession({ sessionId: 'status-parked' })
      yield* parked.emitWait('elicit', { key: 'confirm', message: 'Confirm?', responseSchema: {} })
      expect((yield* parked.status()).state).toBe('parked')

      const completed = yield* createInMemorySession({ sessionId: 'status-completed' })
      yield* completed.terminal('result', { ok: true })
      expect((yield* completed.status()).state).toBe('completed')

      const failed = yield* createInMemorySession({ sessionId: 'status-failed' })
      yield* failed.terminal('error', { code: 'boom' })
      expect((yield* failed.status()).state).toBe('failed')

      const cancelled = yield* createInMemorySession({ sessionId: 'status-cancelled' })
      yield* cancelled.emitWait('elicit', { key: 'confirm', message: 'Confirm?', responseSchema: {} })
      yield* cancelled.cancel('user')
      expect((yield* cancelled.status()).state).toBe('cancelled')
    })
  })

  it('cancels by appending pending fates before a cancelled terminal', async () => {
    await run(function* () {
      const session = yield* createInMemorySession({ sessionId: 'cancel-order' })
      yield* session.emitWait('elicit', { key: 'confirm', message: 'Confirm?', responseSchema: {} })
      yield* session.emitWait('sample', { messages: [] })
      yield* session.cancel('user')
      const records = yield* session.records()
      expect(records.slice(-3).map((record) => record.kind)).toEqual(['fate', 'fate', 'terminal'])
      expect(records.slice(-3).map((record) => record.kind === 'fate' ? record.fate : record.outcome)).toEqual([
        'cancelled',
        'cancelled',
        'cancelled',
      ])
    })
  })

  it('keeps fold bootstrap restore idempotent under repeated createSession calls', async () => {
    await run(function* () {
      const bufferStore = createSessionContractInMemoryStore()
      const agent = createAgent({ name: 'bootstrap-once' })
      yield* agent.createSession({ sessionId: 'bootstrap-once', bufferStore })
      const restored = yield* agent.createSession({ sessionId: 'bootstrap-once', bufferStore })
      const events = yield* restored.events()
      const lsns: number[] = []
      for (let i = 0; i < 2; i += 1) {
        const next = yield* events.next()
        if (next.done) break
        lsns.push(next.value.lsn)
      }
      expect(lsns).toEqual([1, 2])
    })
  })

  it('publishes a machine-readable requirement coverage matrix seed', () => {
    expect(requirementCoverageMatrix).toHaveLength(57)
    expect(requirementCoverageMatrix.find((entry) => entry.requirement === 'REQ-001')?.status).toBe('implemented')
    expect(requirementCoverageMatrix.find((entry) => entry.requirement === 'REQ-057')).toBeTruthy()
  })

  it('exports factory-adapter testing entrypoints for base and full profiles', async () => {
    await run(function* () {
      const baseResult = yield* runBaseSmoke(createReferenceAdapter('base'))
      const fullReference = yield* runFullSmoke(createReferenceAdapter('full'))
      const fullAgent = yield* runFullSmoke(createAgentAdapter())
      expect(baseResult.passed).toBe(true)
      expect(fullReference.passed).toBe(true)
      expect(fullAgent.passed).toBe(true)
    })
  })
})
