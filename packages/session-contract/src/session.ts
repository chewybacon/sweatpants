import type { Operation, Stream } from 'effection'

import { publicEvents } from './projections.ts'
import type { CommandAck, CrankSession, CrankStore, Json, PublicEnvelope } from './types.ts'

export function createCrankSession(store: CrankStore, sessionId: string): CrankSession {
  return {
    id: sessionId,
    *send(message: Json, options: { commandId: string }): Operation<CommandAck> {
      return yield* store.appendCommand({ type: 'send', sessionId, commandId: options.commandId, message })
    },
    *respond(pullId: string, value: Json, options: { commandId: string }): Operation<CommandAck> {
      return yield* store.appendCommand({ type: 'respond', sessionId, commandId: options.commandId, pullId, value })
    },
    *cancelTurn(turnId: string, options: { commandId: string; reason?: string }): Operation<CommandAck> {
      return yield* store.appendCommand({
        type: 'cancel_turn', sessionId, commandId: options.commandId, turnId,
        ...(options.reason !== undefined ? { reason: options.reason } : {}),
      })
    },
    *close(options: { commandId: string; reason?: string }): Operation<CommandAck> {
      return yield* store.appendCommand({
        type: 'close_session', sessionId, commandId: options.commandId,
        ...(options.reason !== undefined ? { reason: options.reason } : {}),
      })
    },
    events(afterCursor = -1): Stream<PublicEnvelope, void> {
      return publicEvents(store, sessionId, afterCursor)
    },
  }
}
