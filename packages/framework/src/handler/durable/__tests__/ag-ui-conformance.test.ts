import { call } from 'effection'
import { describe, expect, it } from './vitest-effection.ts'

import { z } from 'zod'
import {
  createInMemoryBufferStore,
  createInMemoryRegistryStore,
  setupDurableStreams,
} from '../../../lib/chat/durable-streams/index.ts'
import { createDurableChatHandler } from '../handler.ts'
import type { ChatHandlerSetup } from '../types.ts'
import {
  consumeDurableResponse,
  createChatRequest,
  createMockProvider,
  createMockTool,
  setupMockModelProvider,
  setupMockTools,
} from './test-utils.ts'

type AgUiEvent = { type: string; [key: string]: unknown }

const agUiMessageSchema = z.discriminatedUnion('role', [
  z.object({ id: z.string(), role: z.literal('system'), content: z.string() }).passthrough(),
  z.object({ id: z.string(), role: z.literal('user'), content: z.union([z.string(), z.array(z.any())]) })
    .passthrough(),
  z.object({
    id: z.string(),
    role: z.literal('assistant'),
    content: z.string().optional(),
    toolCalls: z.array(z.object({
      id: z.string(),
      type: z.literal('function'),
      function: z.object({ name: z.string(), arguments: z.string() }),
    })).optional(),
  }).passthrough(),
  z.object({ id: z.string(), role: z.literal('tool'), content: z.string(), toolCallId: z.string() })
    .passthrough(),
  z.object({
    id: z.string(),
    role: z.literal('activity'),
    activityType: z.string(),
    content: z.record(z.any()),
  }).passthrough(),
  z.object({ id: z.string(), role: z.literal('reasoning'), content: z.string() }).passthrough(),
])

// Test-local mirror of the AG-UI core EventSchemas for event families emitted by
// Sweatpants public durable streams. Keep in lockstep with protocols/ag-ui
// sdks/typescript/packages/core/src/events.ts when adding new public event types.
const agUiEventSchemas = z.discriminatedUnion('type', [
  z.object({ type: z.literal('RUN_STARTED'), threadId: z.string(), runId: z.string(), input: z.any().optional() })
    .passthrough(),
  z.object({ type: z.literal('RUN_FINISHED'), threadId: z.string(), runId: z.string(), outcome: z.any().optional() })
    .passthrough(),
  z.object({ type: z.literal('RUN_ERROR'), message: z.string(), code: z.string().optional() }).passthrough(),
  z.object({ type: z.literal('MESSAGES_SNAPSHOT'), messages: z.array(agUiMessageSchema) }).passthrough(),
  z.object({ type: z.literal('STATE_SNAPSHOT'), snapshot: z.any() }).passthrough(),
  z.object({ type: z.literal('TEXT_MESSAGE_START'), messageId: z.string(), role: z.string().optional() })
    .passthrough(),
  z.object({ type: z.literal('TEXT_MESSAGE_CONTENT'), messageId: z.string(), delta: z.string() }).passthrough(),
  z.object({ type: z.literal('TEXT_MESSAGE_END'), messageId: z.string() }).passthrough(),
  z.object({ type: z.literal('REASONING_MESSAGE_START'), messageId: z.string(), role: z.literal('reasoning') })
    .passthrough(),
  z.object({ type: z.literal('REASONING_MESSAGE_CONTENT'), messageId: z.string(), delta: z.string() }).passthrough(),
  z.object({ type: z.literal('REASONING_MESSAGE_END'), messageId: z.string() }).passthrough(),
  z.object({ type: z.literal('TOOL_CALL_START'), toolCallId: z.string(), toolCallName: z.string() }).passthrough(),
  z.object({ type: z.literal('TOOL_CALL_ARGS'), toolCallId: z.string(), delta: z.string() }).passthrough(),
  z.object({ type: z.literal('TOOL_CALL_END'), toolCallId: z.string() }).passthrough(),
  z.object({
    type: z.literal('TOOL_CALL_RESULT'),
    messageId: z.string(),
    toolCallId: z.string(),
    content: z.string(),
    role: z.literal('tool').optional(),
  }).passthrough(),
  z.object({
    type: z.literal('ACTIVITY_SNAPSHOT'),
    messageId: z.string(),
    activityType: z.string(),
    content: z.record(z.any()),
    replace: z.boolean().optional(),
  }).passthrough(),
])

const legacyPublicEventTypes = new Set([
  'ag_ui_checkpoint',
  'ag_ui_state_snapshot',
  'ag_ui_messages_snapshot',
  'ag_ui_tool_call_result',
  'ag_ui_tool_call_error',
  'elicit_request',
  'conversation_state',
  'session_info',
])

function createTestHooks(
  provider: ReturnType<typeof createMockProvider>,
  tools: Array<ReturnType<typeof createMockTool>> = [],
): ChatHandlerSetup {
  const bufferStore = createInMemoryBufferStore<string>()
  const registryStore = createInMemoryRegistryStore()

  return function* setup() {
    yield* setupDurableStreams({ bufferStore, registryStore })
    yield* setupMockModelProvider(provider)
    yield* setupMockTools(tools)
  }
}

function assertSchemaValidPublicEvents(events: AgUiEvent[]) {
  expect(events.length).toBeGreaterThan(0)
  for (const event of events) {
    expect(legacyPublicEventTypes.has(event.type)).toBe(false)
    expect(event.type.startsWith('ag_ui_')).toBe(false)
    expect(() => agUiEventSchemas.parse(event)).not.toThrow()
  }
}

function assertAgUiLifecycle(events: AgUiEvent[]) {
  expect(events[0]?.type === 'RUN_STARTED' || events[0]?.type === 'RUN_ERROR').toBe(true)

  const activeTextMessages = new Set<string>()
  const activeToolCalls = new Set<string>()
  let runTerminal = false

  for (const event of events) {
    if (runTerminal && event.type !== 'RUN_STARTED') {
      throw new Error(`event after terminal run event: ${event.type}`)
    }
    if (event.type === 'RUN_STARTED') {
      runTerminal = false
    }

    switch (event.type) {
      case 'TEXT_MESSAGE_START': {
        const messageId = String(event.messageId)
        expect(activeTextMessages.has(messageId)).toBe(false)
        activeTextMessages.add(messageId)
        break
      }
      case 'TEXT_MESSAGE_CONTENT':
        expect(activeTextMessages.has(String(event.messageId))).toBe(true)
        break
      case 'TEXT_MESSAGE_END':
        expect(activeTextMessages.delete(String(event.messageId))).toBe(true)
        break
      case 'TOOL_CALL_START': {
        const toolCallId = String(event.toolCallId)
        expect(activeToolCalls.has(toolCallId)).toBe(false)
        activeToolCalls.add(toolCallId)
        break
      }
      case 'TOOL_CALL_ARGS':
        expect(activeToolCalls.has(String(event.toolCallId))).toBe(true)
        break
      case 'TOOL_CALL_END':
        expect(activeToolCalls.delete(String(event.toolCallId))).toBe(true)
        break
      case 'RUN_FINISHED':
      case 'RUN_ERROR':
        expect([...activeTextMessages]).toEqual([])
        expect([...activeToolCalls]).toEqual([])
        runTerminal = true
        break
    }
  }
}

function assertPublicConformance(events: AgUiEvent[]) {
  assertSchemaValidPublicEvents(events)
  assertAgUiLifecycle(events)
}

describe('strict AG-UI public conformance', () => {
  it('validates normal text runs against AG-UI schemas and lifecycle rules', function* () {
    const provider = createMockProvider({ responses: 'Hello schema world' })
    const handler = createDurableChatHandler({ setup: createTestHooks(provider) })

    const { request } = createChatRequest([
      { id: 'user:ag-ui-normal', role: 'user', content: 'Say hello' },
    ])
    const response = yield* call(() => handler(request))
    const result = yield* call(() => consumeDurableResponse(response))

    assertPublicConformance(result.events.map((entry) => entry.event as AgUiEvent))
  })

  it('validates tool runs against AG-UI schemas and lifecycle rules', function* () {
    const echoTool = createMockTool('echo', 'Echoes input')
    const provider = createMockProvider({
      responses: 'Calling tool',
      toolCalls: [{ id: 'call-ag-ui-tool', name: 'echo', arguments: { input: 'hello' } }],
    })
    const handler = createDurableChatHandler({ setup: createTestHooks(provider, [echoTool]) })

    const { request } = createChatRequest(
      [{ id: 'user:ag-ui-tool', role: 'user', content: 'Echo hello' }],
      { enabledTools: true },
    )
    const response = yield* call(() => handler(request))
    const result = yield* call(() => consumeDurableResponse(response))

    const events = result.events.map((entry) => entry.event as AgUiEvent)
    assertPublicConformance(events)
    expect(events.some((event) => event.type === 'TOOL_CALL_RESULT')).toBe(true)
  })

  it('rejects injected legacy public events in the conformance harness', function* () {
    expect(() =>
      assertPublicConformance([
        { type: 'RUN_STARTED', threadId: 'thread', runId: 'run' },
        { type: 'ag_ui_tool_call_result', toolCallId: 'call', content: 'legacy' },
      ]),
    ).toThrow()
  })
})
