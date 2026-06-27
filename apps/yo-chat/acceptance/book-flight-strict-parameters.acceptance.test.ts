import { run } from 'effection'
import { describe, expect, it } from 'vitest'
import {
  createLocalToolRuntimeDriver,
} from '@sweatpants/tool-runtime-local'
import { bookFlightTool } from '../src/tools/book-flight/tool.ts'

type LocalMcpTool = NonNullable<Parameters<typeof createLocalToolRuntimeDriver>[0]['tools']>[number]

describe('yo-chat book_flight strict parameter acceptance', () => {
  it('rejects missing required route params before starting the booking UI flow', async () => {
    await run(function* () {
      const driver = yield* createLocalToolRuntimeDriver({
        tools: [bookFlightTool as LocalMcpTool],
        samplingProvider: { *sample() { return { text: 'unused' } } },
      })

      try {
        yield* driver.startToolCall({
          toolName: bookFlightTool.name,
          callId: 'call-missing-origin',
          arguments: { destination: 'NYC' },
        })
        throw new Error('expected validation failure')
      } catch (error) {
        expect(error).toMatchObject({
          code: 'TOOL_PARAMETER_VALIDATION_FAILED',
          payload: {
            toolName: 'book_flight',
            callId: 'call-missing-origin',
          },
        })
      }
    })
  })

  it('starts the authored flight picker flow when route params are complete', async () => {
    await run(function* () {
      const driver = yield* createLocalToolRuntimeDriver({
        tools: [bookFlightTool as LocalMcpTool],
        samplingProvider: { *sample() { return { text: 'unused' } } },
      })

      const session = yield* driver.startToolCall({
        toolName: bookFlightTool.name,
        callId: 'call-valid-route',
        arguments: { from: 'Boston', destination: 'NYC' },
      })

      const events = yield* session.events()
      while (true) {
        const next = yield* events.next()
        if (next.done) throw new Error('expected book_flight to request flight selection')
        if (next.value.type === 'elicit_request') {
          expect(next.value).toMatchObject({ key: 'pickFlight' })
          expect(next.value.message).toContain('Select a flight from Boston to NYC')
          break
        }
      }
    })
  })
})
