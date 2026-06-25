import type { Operation } from 'effection'
import { each } from 'effection'

import type { SampleProvider, SampleRequest } from '../ctx.ts'
import type { SampleResult } from '../events.ts'
import type { AgentEvent } from '../events.ts'
import type { AgentSession } from '../session.ts'

/** A mock sample provider that returns canned content. */
export function createMockSampleProvider(
  respond: (req: SampleRequest) => string,
): SampleProvider {
  return {
    *sample(req) {
      return { content: respond(req), raw: req } as SampleResult
    },
  }
}

/** Drain all currently-buffered events from a session (non-blocking snapshot). */
export function* snapshotEvents(
  session: AgentSession,
  afterLSN = 0,
): Operation<AgentEvent[]> {
  const events: AgentEvent[] = []
  const stream = session.events(afterLSN)
  const sub = yield* stream
  // Pull only what's already buffered; stop at the first wait.
  let result = yield* sub.next()
  while (!result.done) {
    events.push(result.value)
    result = yield* sub.next()
  }
  return events
}

/** Collect events until a predicate matches or the stream closes. */
export function* collectUntil(
  session: AgentSession,
  predicate: (events: AgentEvent[]) => boolean,
  afterLSN = 0,
): Operation<AgentEvent[]> {
  const events: AgentEvent[] = []
  const stream = session.events(afterLSN)
  for (const event of yield* each(stream)) {
    events.push(event)
    if (predicate(events)) break
    yield* each.next()
  }
  return events
}
