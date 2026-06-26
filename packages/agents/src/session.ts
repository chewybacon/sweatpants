/**
 * AgentSession — a participant's durable handle on a stream (Spec REQ-007).
 *
 * `createAgentSession` mounts a long-lived driver loop over a durable stream
 * keyed by `contextId`. Participants append commands (`sendMessage`,
 * `respondElicit`, `respondSample`, `cancel`) and subscribe to `events(afterLSN)`.
 *
 * `sendMessage` carries `contextId` (stateful) OR `snapshot` (stateless) per
 * REQ-012; both-present semantics: contextId wins if the server has it, else
 * the snapshot seeds the stream.
 */

import { spawn, each, type Operation, type Task, type Stream } from 'effection'

import type { AgentFactory } from './types.ts'
import type { AgentEvent, AgentMessage, AgentState } from './events.ts'
import { createMessage, normalizeContent } from './events.ts'
import type { AgentCommand, SendMessageCommand } from './commands.ts'
import {
  createAgentStream,
  createInMemoryAgentStreamStore,
  type AgentStream,
  type AgentStreamStore,
} from './stream.ts'
import { createRequestRouter, type SampleProvider } from './ctx.ts'
import { driveEntry, emitCheckpointOp, restoreFromCheckpoint } from './driver.ts'
import { generateId } from './ctx.ts'

export interface CreateAgentSessionOptions {
  contextId: string
  store?: AgentStreamStore
  sampleProvider?: SampleProvider
}

export interface AgentSession {
  readonly contextId: string
  /** Append a command to the stream (REQ-007). */
  send(command: AgentCommand): Operation<void>
  /** Subscribe to events after an LSN (reconnect/replay semantics, REQ-007). */
  events(afterLSN?: number): Stream<AgentEvent, void>
  /** Current session status. */
  status(): SessionStatus
}

export type SessionStatus = 'idle' | 'running' | 'error'

export function* createAgentSession(
  agent: AgentFactory<any, any, any, any>,
  options: CreateAgentSessionOptions,
): Operation<AgentSession> {
  const store = options.store ?? createInMemoryAgentStreamStore()
  const buffer = yield* store.getOrCreate(options.contextId)
  const stream = createAgentStream(
    options.contextId,
    buffer,
    'checkpointIndex' in store
      ? (store as ReturnType<typeof createInMemoryAgentStreamStore>).checkpointIndex
      : undefined,
  )
  const router = createRequestRouter()

  const messages: AgentMessage[] = []
  const state: AgentState = {}
  let status: SessionStatus = 'idle'
  let currentRun: Task<unknown> | undefined

  // Seed from a snapshot if the stream is empty and a snapshot is provided
  // on the first sendMessage — handled per-command below.

  yield* spawn(function* () {
    const commands = stream.commands(0)
    for (const cmd of yield* each(commands)) {
      try {
        if (cmd.type === 'sendMessage') {
          yield* handleSendMessage(agent, stream, router, options.sampleProvider, messages, state, cmd, () => {
            // halt previous run if a new message supersedes it
            if (currentRun) {
              void currentRun.halt()
            }
          })
        } else if (cmd.type === 'respondElicit') {
          const resolved = router.resolveElicit(cmd.requestId, cmd.result)
          if (!resolved.ok) {
            yield* stream.append({
              type: 'error',
              message: resolved.message,
              code: resolved.code,
            } as AgentEvent)
          }
        } else if (cmd.type === 'respondSample') {
          const resolved = router.resolveSample(cmd.requestId, cmd.result)
          if (!resolved.ok) {
            yield* stream.append({
              type: 'error',
              message: resolved.message,
              code: resolved.code,
            } as AgentEvent)
          }
        } else if (cmd.type === 'cancel') {
          router.abort(cmd.reason)
          if (currentRun) {
            yield* currentRun.halt()
          }
          yield* stream.append({ type: 'aborted', reason: cmd.reason } as AgentEvent)
          // Migration alias for parent-spec consumers.
          yield* stream.append({ type: 'cancelled', reason: cmd.reason } as AgentEvent)
          status = 'idle'
        }
      } catch (err) {
        status = 'error'
        yield* stream.append({
          type: 'error',
          message: err instanceof Error ? err.message : String(err),
        } as AgentEvent)
      }
      yield* each.next()
    }
  })

  function* handleSendMessage(
    agent: AgentFactory<any, any, any, any>,
    stream: AgentStream,
    router: ReturnType<typeof createRequestRouter>,
    sampleProvider: SampleProvider | undefined,
    messages: AgentMessage[],
    state: AgentState,
    cmd: SendMessageCommand,
    onSupersede: () => void,
  ): Operation<void> {
    if (router.pendingCount() > 0) {
      yield* stream.append({
        type: 'error',
        message: 'Cannot accept new input while interrupts are pending',
        code: 'pending_interrupts',
      } as AgentEvent)
      return
    }

    // REQ-012: validate — need contextId or snapshot (this session always has
    // a contextId, so the command is valid; a bare snapshot-only send is also
    // accepted and seeds state).
    if (!cmd.message && cmd.message !== '') {
      yield* stream.append({
        type: 'error',
        message: 'sendMessage requires a message',
        code: 'invalid',
      } as AgentEvent)
      return
    }

    // Restore from checkpoint (stateful path) — REQ-011.
    const restored = yield* restoreFromCheckpoint(stream)
    if (restored) {
      messages.length = 0
      messages.push(...restored.messages)
      Object.assign(state, restored.state)
    } else if (cmd.snapshot && messages.length === 0) {
      // Stateless path: seed from client-carried snapshot (REQ-012 path 2).
      seedFromSnapshot(messages, state, cmd.snapshot)
    }

    // Append the user message.
    messages.push({
      ...createMessage('user', cmd.message, cmd.messageId ?? `msg-${generateId()}`),
    })

    onSupersede()
    status = 'running'
    currentRun = yield* spawn(function* () {
      try {
        const result = yield* driveEntry(agent, cmd.message, {
          stream,
          router,
          sampleProvider: sampleProvider ?? undefined,
          messages,
          state,
          subSessionId: undefined,
        })
        yield* stream.append({ type: 'result', value: result } as AgentEvent)
        // Checkpoint at turn boundary (REQ-013).
        yield* emitCheckpointOp(stream, options.contextId, messages, state)
        status = 'idle'
      } catch (err) {
        // Effection halts a Task by throwing Error("halted").
        if (err instanceof Error && err.message === 'halted') {
          status = 'idle'
          return
        }
        status = 'error'
        yield* stream.append({
          type: 'error',
          message: err instanceof Error ? err.message : String(err),
        } as AgentEvent)
        // Checkpoint even on error so the conversation is restorable.
        yield* emitCheckpointOp(stream, options.contextId, messages, state)
      }
    })
  }

  return {
    contextId: options.contextId,
    *send(command) {
      yield* stream.append({ ...(command as object), command: true } as never)
    },
    events(afterLSN = 0) {
      return stream.events(afterLSN)
    },
    status() {
      return status
    },
  }
}

function seedFromSnapshot(messages: AgentMessage[], state: AgentState, snapshot: unknown) {
  if (snapshot && typeof snapshot === 'object' && 'messages' in snapshot) {
    const sm = (snapshot as { messages?: AgentMessage[] }).messages
    if (Array.isArray(sm)) {
      messages.push(
        ...sm.map((m) => ({
          ...m,
          content: normalizeContent((m as { content: unknown }).content as never),
        } as AgentMessage)),
      )
    }
    const ss = (snapshot as { state?: AgentState }).state
    if (ss && typeof ss === 'object') Object.assign(state, ss)
  }
}


