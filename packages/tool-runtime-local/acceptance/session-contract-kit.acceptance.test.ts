import { run } from 'effection'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createTool } from '@sweatpants/core'
import { adaptToolSessionToSessionContract, type ToolSessionSamplingProvider } from '@sweatpants/framework/chat/mcp-tools'
import { runBaseProfileConformance } from '@sweatpants/session-contract/testing'

import { createToolSession } from '../src/index.ts'

const samplingProvider: ToolSessionSamplingProvider = {
  *sample() {
    return { text: 'kit-sample' }
  },
}

const ElicitTool = createTool('session_contract_kit_local_elicit')
  .description('Local conformance elicit tool')
  .parameters(z.object({}))
  .elicits({ confirm: z.object({ confirmed: z.boolean() }) })
  .execute(function* (_params, ctx) {
    const result = yield* ctx.elicit('confirm', { message: 'Confirm?' })
    return result.action === 'accept'
      ? { confirmed: result.content.confirmed }
      : { confirmed: false }
  })

const SampleTool = createTool('session_contract_kit_local_sample')
  .description('Local conformance sample tool')
  .parameters(z.object({}))
  .samples()
  .execute(function* (_params, ctx) {
    const result = yield* ctx.sample({ prompt: 'sample' })
    return { text: result.text }
  })

describe('@sweatpants/tool-runtime-local session-contract kit bootstrap', () => {
  it('passes the exported base-profile conformance runner', async () => {
    await run(function* () {
      const result = yield* runBaseProfileConformance({
        name: 'local-tool-session',
        *createElicitSession(sessionId) {
          const toolSession = yield* createToolSession(ElicitTool, {}, samplingProvider, { sessionId })
          return yield* adaptToolSessionToSessionContract(toolSession)
        },
        elicitPayload: { confirmed: true },
        *createSampleSession(sessionId) {
          const toolSession = yield* createToolSession(SampleTool, {}, samplingProvider, { sessionId })
          return yield* adaptToolSessionToSessionContract(toolSession)
        },
        samplePayload: { text: 'kit-sample' },
      })

      expect(result).toEqual({ name: 'local-tool-session', scenarios: ['elicit', 'sample'] })
    })
  })
})
