import { createStreamResponse } from '@sweatpants/stream-bridge'
import { run, type Stream } from 'effection'

import type { EventFrame } from './tail-stream.ts'

export async function createStreamingNDJSONResponse(
  frameStream: Stream<EventFrame, void>,
  status: number,
  headers: Headers,
): Promise<Response> {
  const bridge = await run(function* () {
    return yield* createStreamResponse(frameStream, {
      contentType: 'application/x-ndjson',
      serialize: (frame) => new TextEncoder().encode(`${JSON.stringify(frame)}\n`),
    })
  })

  const response = new Response(bridge.response.body, {
    status,
    headers,
  })

  headers.forEach((value, key) => {
    response.headers.set(key, value)
  })

  return response
}
