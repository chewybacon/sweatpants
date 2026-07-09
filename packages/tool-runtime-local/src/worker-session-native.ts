/**
 * Session-Contract Native Worker Tool Session
 *
 * Hosts a `body`-mode session-contract `Session` per tool invocation. The host
 * process owns the `Session` and `TokenBufferStore`. The worker thread runs
 * the tool generator and proxies `ctx.elicit()`/`ctx.sample()`/`ctx.notify()`/
 * `ctx.log()` over the existing worker protocol to the host. The host
 * translates worker messages into `emitWait()`/`emitEmission()` on the session
 * log.
 *
 * The worker-to-host wire protocol (`WorkerElicitRequest`/`WorkerSampleRequest`
 * etc.) is unchanged from the prior implementation (REQ-065). Only the
 * host-side session manager is rewritten.
 *
 * @packageDocumentation
 */

import {
  type Operation,
  type Stream,
  resource,
  spawn,
} from 'effection'
import {
  createWorkerPrincipal,
  type WorkerRequest,
  type WorkerResponse,
  type WorkerResult,
} from '@sweatpants/core/transport/worker'
import type {
  InMemorySession,
  LogRecord,
  WaitRecord,
  AnswerRecord,
} from '@sweatpants/session-contract'
import {
  createInMemorySession,
  waitToken,
  type TokenBufferStore,
} from '@sweatpants/session-contract'
import type { WireElicitResult, ExtendedMessage } from '@sweatpants/framework/chat/mcp-tools'
import type { WireSampleResult } from '@sweatpants/framework/chat/mcp-tools'
import type { McpWorkerInitData } from './worker-types.ts'
import type { WorkerElicitRequest, WorkerElicitResponse, WorkerSampleRequest, WorkerSampleResponse } from '@sweatpants/core/transport/worker'

/**
 * Options for creating a native worker tool session.
 */
export interface NativeWorkerToolSessionOptions {
  /** Session ID */
  sessionId: string
  /** Tool name */
  toolName: string
  /** Tool parameters */
  params: unknown
  /** URL to the worker script */
  workerUrl: string | URL
  /** Optional system prompt */
  systemPrompt?: string
  /** Optional parent messages */
  parentMessages?: ExtendedMessage[]
  /** Extra execArgv for the worker thread */
  execArgv?: string[]
  /** Optional buffer store (defaults to in-memory) */
  bufferStore?: TokenBufferStore<LogRecord>
}

/**
 * Creates a session-contract-native `body`-mode `Session` backed by a worker
 * thread.
 *
 * The host owns the session and translates worker requests into session log
 * operations:
 * - `WorkerElicitRequest` → `emitWait('elicit', ...)` → wait for answer → `WorkerElicitResponse`
 * - `WorkerSampleRequest` → `emitWait('sample', ...)` → wait for answer → `WorkerSampleResponse`
 * - Worker result → `terminal('result', value)`
 * - Worker error → `terminal('error', { name, message })`
 * - Worker cancelled → `terminal('cancelled', { reason })`
 *
 * The host answers pending waits via `session.respond()` (called by the
 * handler when the client responds to an elicit or sample).
 */
export function createNativeWorkerToolSession(
  options: NativeWorkerToolSessionOptions,
): Operation<InMemorySession> {
  return resource<InMemorySession>(function* (provide) {
    const {
      sessionId,
      toolName,
      params,
      workerUrl,
      systemPrompt,
      parentMessages,
      execArgv,
      bufferStore,
    } = options

    // Create the body-mode session-contract session (host owns it)
    const session = yield* createInMemorySession({
      sessionId,
      mode: 'body',
      ...(bufferStore !== undefined ? { bufferStore } : {}),
    })

    // Emit a checkpoint to mark the start of the body-mode session
    yield* session.checkpoint('body', { toolName, params })

    // Map from elicitId/sampleId → waitSeq, so the host can answer the
    // correct wait when the client responds.
    const elicitWaitMap = new Map<string, number>()
    const sampleWaitMap = new Map<string, number>()

    // Helper: wait for an answer to a specific waitSeq on the session log
    function* waitForAnswer(waitSeq: number): Operation<AnswerRecord> {
      const events: Stream<LogRecord, void> = session.events(0)
      const sub = yield* events
      while (true) {
        const result = yield* sub.next()
        if (result.done) {
          throw new Error(`Session ended before wait ${waitSeq} was answered`)
        }
        const record = result.value
        if (
          record.kind === 'answer' &&
          record.waitSeq === waitSeq
        ) {
          return record as AnswerRecord
        }
      }
    }

    // Build init data for the worker
    const initData: McpWorkerInitData = {
      toolName,
      params,
      sessionId,
      ...(systemPrompt !== undefined && { systemPrompt }),
      ...(parentMessages !== undefined && { parentMessages }),
    }

    // Create the worker using core's createWorkerPrincipal
    const { result: workerResult } = yield* createWorkerPrincipal<unknown, McpWorkerInitData>({
      workerUrl,
      initData,
      ...(execArgv && execArgv.length > 0 ? { execArgv } : {}),
      requestHandler: function* (request: WorkerRequest): Operation<WorkerResponse> {
        if (request.type === 'elicit') {
          return yield* handleElicit(request)
        }
        if (request.type === 'sample') {
          return yield* handleSample(request)
        }
        throw new Error(`Unknown request type: ${(request as WorkerRequest).type}`)
      },
    })

    // Handle elicit requests: emit wait on session log, block for answer
    function* handleElicit(request: WorkerElicitRequest): Operation<WorkerElicitResponse> {
      const elicitId = request.id
      const waitRecord = yield* session.emitWait('elicit', {
        key: request.key,
        message: request.message,
        responseSchema: request.schema,
        ...(request.context !== undefined ? { context: request.context } : {}),
      })
      elicitWaitMap.set(elicitId, waitRecord.waitSeq)

      const answer = yield* waitForAnswer(waitRecord.waitSeq)
      elicitWaitMap.delete(elicitId)

      const payload = answer.payload as { ok: boolean; value?: WireElicitResult<unknown> }
      if (!payload.ok) {
        return { id: elicitId, type: 'elicit', action: 'cancel' }
      }

      const rawResult = payload.value as WireElicitResult<unknown>

      return {
        id: elicitId,
        type: 'elicit',
        action: rawResult.action,
        ...(rawResult.action === 'accept' && { content: rawResult.content }),
        ...((rawResult.action === 'decline' || rawResult.action === 'cancel') &&
          'reason' in rawResult &&
          rawResult.reason !== undefined && { reason: rawResult.reason }),
      }
    }

    // Handle sample requests: emit wait on session log, block for answer
    function* handleSample(request: WorkerSampleRequest): Operation<WorkerSampleResponse> {
      const sampleId = request.id
      const messages: ExtendedMessage[] = request.messages.map((m) => {
        if (typeof m.content === 'string') {
          return { role: m.role, content: m.content }
        }
        // Simplified conversion for the session log
        return { role: m.role, content: JSON.stringify(m.content) }
      })

      const sampleOptions: Record<string, unknown> = {}
      if (request.systemPrompt !== undefined) sampleOptions['system'] = request.systemPrompt
      if (request.maxTokens !== undefined) sampleOptions['maxTokens'] = request.maxTokens
      if (request.modelPreferences !== undefined) sampleOptions['modelPreferences'] = request.modelPreferences
      if (request.tools !== undefined) sampleOptions['tools'] = request.tools
      if (request.toolChoice !== undefined) sampleOptions['toolChoice'] = request.toolChoice
      if (request.schema !== undefined) sampleOptions['schema'] = request.schema

      const waitRecord = yield* session.emitWait('sample', {
        messages,
        options: sampleOptions,
      })
      sampleWaitMap.set(sampleId, waitRecord.waitSeq)

      const answer = yield* waitForAnswer(waitRecord.waitSeq)
      sampleWaitMap.delete(sampleId)

      const payload = answer.payload as { ok: boolean; value?: WireSampleResult }
      if (!payload.ok) {
        return { id: sampleId, type: 'sample', status: 'accepted', text: '' }
      }

      const rawResult = payload.value as WireSampleResult
      return {
        id: sampleId,
        type: 'sample',
        status: 'accepted',
        text: rawResult.text,
        ...(rawResult.model !== undefined && { model: rawResult.model }),
        ...(rawResult.stopReason !== undefined && { stopReason: rawResult.stopReason }),
        ...('parsed' in rawResult && rawResult.parsed !== undefined && { parsed: rawResult.parsed }),
        ...('parseError' in rawResult && rawResult.parseError !== undefined && { parseError: rawResult.parseError }),
        ...('toolCalls' in rawResult && rawResult.toolCalls !== undefined && { toolCalls: rawResult.toolCalls }),
      }
    }

    // Spawn a task to wait for the worker result and emit terminal
    yield* spawn(function* () {
      try {
        const result: WorkerResult<unknown> = yield* workerResult
        if (result.type === 'success') {
          yield* session.terminal('result', result.value)
        } else if (result.type === 'error') {
          yield* session.terminal('error', {
            name: result.error.name,
            message: result.error.message,
            ...(result.error.stack !== undefined && { stack: result.error.stack }),
          })
        } else if (result.type === 'cancelled') {
          yield* session.terminal('cancelled', {
            ...(result.reason !== undefined && { reason: result.reason }),
          })
        }
      } catch (error) {
        const err = error as Error
        yield* session.terminal('error', {
          name: err.name,
          message: err.message,
          ...(err.stack !== undefined && { stack: err.stack }),
        })
      }
    })

    try {
      yield* provide(session)
    } finally {
      // If the session is cancelled (scope halt), cancel the session log
      const status = yield* session.status()
      if (!status.terminal) {
        try {
          yield* session.cancel('host scope halted')
        } catch {
          // Session may already be terminal
        }
      }
    }
  })
}

/**
 * Respond to a pending elicit wait on a native worker tool session.
 *
 * The `elicitId` is the worker-generated ID; this function looks up the
 * corresponding `waitSeq` and calls `session.respond()`.
 */
export function* respondToNativeElicit(
  session: InMemorySession,
  elicitId: string,
  response: WireElicitResult<unknown>,
): Operation<void> {
  // We need to find the waitSeq from the session log by matching the elicit key
  // The elicitId is stored in the wait payload's key field
  const records = yield* session.records()
  for (const record of records) {
    if (record.kind === 'wait' && record.wait === 'elicit') {
      const waitRec = record as WaitRecord<'elicit'>
      if (waitRec.payload.key === elicitId) {
        const status = yield* session.status()
        const isPending = status.pendingWaits.some((w) => w.waitSeq === waitRec.waitSeq)
        if (isPending) {
          yield* session.respond(waitToken(session.id, waitRec.waitSeq), response)
        }
        return
      }
    }
  }
}

/**
 * Respond to a pending sample wait on a native worker tool session.
 */
export function* respondToNativeSample(
  session: InMemorySession,
  _sampleId: string,
  response: WireSampleResult,
): Operation<void> {
  // Sample IDs are mapped by waitSeq; we look up from the log
  const records = yield* session.records()
  for (const record of records) {
    if (record.kind === 'wait' && record.wait === 'sample') {
      const waitRec = record as WaitRecord<'sample'>
      // Sample waits don't have a natural ID field; we use the waitSeq
      // The caller needs to know the waitSeq. For now, answer the most recent
      // pending sample wait.
      const status = yield* session.status()
      const isPending = status.pendingWaits.some((w) => w.waitSeq === waitRec.waitSeq)
      if (isPending) {
        yield* session.respond(waitToken(session.id, waitRec.waitSeq), response)
        return
      }
    }
  }
}
