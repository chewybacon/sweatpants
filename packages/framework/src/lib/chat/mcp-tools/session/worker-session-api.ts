/**
 * Worker Session API
 *
 * Provides middleware-decoratable operations for worker session request/response
 * handling using Effection's experimental createApi.
 */

import { createApi } from 'effection/experimental'
import { createChannel, type Operation } from 'effection'
import type {
  WorkerElicitRequest,
  WorkerElicitResponse,
  WorkerSampleRequest,
  WorkerSampleResponse,
} from '@sweatpants/core/transport/worker'
import type { RawElicitResult, Message } from '../mcp-tool-types.ts'
import type { RawSampleResult } from './types.ts'
import { WorkerSessionStateContext } from './worker-session-context.ts'

export const WorkerSessionApi = createApi('worker-session', {
  // ==========================================
  // Request side (worker → host)
  // ==========================================

  *handleElicitRequest(request: WorkerElicitRequest): Operation<WorkerElicitResponse> {
    const state = yield* WorkerSessionStateContext.expect()
    const elicitId = request.id

    yield* state.emitEvent({
      type: 'elicit_request',
      elicitId,
      key: request.key,
      message: request.message,
      schema: request.schema,
      ...(request.context !== undefined && { context: request.context }),
    })

    const channel = createChannel<RawElicitResult<unknown>, void>()
    state.pendingElicitChannels.set(elicitId, channel)

    const sub = yield* channel
    const result = yield* sub.next()

    state.pendingElicitChannels.delete(elicitId)

    if (result.done) {
      return { id: elicitId, type: 'elicit', status: 'cancelled' }
    }

    const rawResult = result.value
    state.setStatus('running')

    const responseStatus = rawResult.action === 'accept' ? 'accepted'
      : rawResult.action === 'decline' ? 'declined'
      : 'cancelled'

    return {
      id: elicitId,
      type: 'elicit',
      status: responseStatus,
      ...(rawResult.action === 'accept' && { content: rawResult.content }),
    }
  },

  *handleSampleRequest(request: WorkerSampleRequest): Operation<WorkerSampleResponse> {
    const state = yield* WorkerSessionStateContext.expect()
    const sampleId = request.id

    const messages: Message[] = request.messages.map((message) => {
      if (typeof message.content === 'string') {
        return { role: message.role, content: message.content }
      }
      return { role: message.role, content: JSON.stringify(message.content) }
    })

    yield* state.emitEvent({
      type: 'sample_request',
      sampleId,
      messages,
      ...(request.systemPrompt !== undefined && { systemPrompt: request.systemPrompt }),
      ...(request.maxTokens !== undefined && { maxTokens: request.maxTokens }),
      ...(request.modelPreferences !== undefined && { modelPreferences: request.modelPreferences }),
      ...(request.tools !== undefined && { tools: request.tools }),
      ...(request.toolChoice !== undefined && { toolChoice: request.toolChoice }),
      ...(request.schema !== undefined && { schema: request.schema }),
    })

    const channel = createChannel<RawSampleResult, void>()
    state.pendingSampleChannels.set(sampleId, channel)

    const sub = yield* channel
    const result = yield* sub.next()

    state.pendingSampleChannels.delete(sampleId)

    if (result.done) {
      return {
        id: sampleId,
        type: 'sample',
        status: 'accepted',
        text: '',
      }
    }

    const rawResult = result.value
    state.setStatus('running')

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
  },

  // ==========================================
  // Response side (host → worker)
  // ==========================================

  *respondToElicit(elicitId: string, response: RawElicitResult<unknown>): Operation<void> {
    const state = yield* WorkerSessionStateContext.expect()
    const channel = state.pendingElicitChannels.get(elicitId)
    if (channel) {
      yield* channel.send(response)
      yield* channel.close()
      state.pendingElicitChannels.delete(elicitId)
    }
  },

  *respondToSample(sampleId: string, response: RawSampleResult): Operation<void> {
    const state = yield* WorkerSessionStateContext.expect()
    const channel = state.pendingSampleChannels.get(sampleId)
    if (channel) {
      yield* channel.send(response)
      yield* channel.close()
      state.pendingSampleChannels.delete(sampleId)
    }
  },
})

export const {
  handleElicitRequest,
  handleSampleRequest,
  respondToElicit,
  respondToSample,
} = WorkerSessionApi.operations
