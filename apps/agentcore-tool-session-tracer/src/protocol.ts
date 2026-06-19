import { z } from 'zod'

export const PROTOCOL_VERSION = 'sweatpants.agentcore.tool-session.v1' as const

const BaseRequestSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  commandId: z.string().min(1),
  toolSessionId: z.string().min(1),
})

export const RuntimeRequestSchema = z.discriminatedUnion('op', [
  BaseRequestSchema.extend({
    op: z.literal('start_tool_session'),
    toolName: z.string().min(1),
    params: z.unknown().optional(),
    context: z.object({
      conversationId: z.string().optional(),
      callId: z.string().optional(),
      parentMessages: z.array(z.unknown()).optional(),
      systemPrompt: z.string().optional(),
    }).optional(),
  }),
  BaseRequestSchema.extend({
    op: z.literal('respond_to_elicit'),
    elicitId: z.string().min(1),
    response: z.object({
      action: z.enum(['accept', 'decline', 'cancel']),
      content: z.unknown().optional(),
    }),
  }),
  BaseRequestSchema.extend({
    op: z.literal('respond_to_sample'),
    sampleId: z.string().min(1),
    response: z.object({
      text: z.string(),
      model: z.string().optional(),
      stopReason: z.string().optional(),
      parsed: z.unknown().optional(),
      parseError: z.unknown().optional(),
      toolCalls: z.array(z.unknown()).optional(),
    }),
  }),
  BaseRequestSchema.extend({
    op: z.literal('cancel_tool_session'),
    reason: z.string().optional(),
  }),
  BaseRequestSchema.extend({
    op: z.literal('inspect_tool_session'),
  }),
  BaseRequestSchema.extend({
    op: z.literal('drain_tool_session_events'),
    afterRuntimeEventSeq: z.number().int().min(0),
  }),
])

export type RuntimeRequest = z.infer<typeof RuntimeRequestSchema>

export type ToolStatus =
  | 'initializing'
  | 'running'
  | 'awaiting_elicit'
  | 'awaiting_sample'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'orphaned'

export type RuntimeEvent =
  | { type: 'progress'; message: string; progress?: number }
  | { type: 'log'; level: 'debug' | 'info' | 'warning' | 'error'; message: string }
  | { type: 'elicit_request'; elicitId: string; key: string; message: string; schema: Record<string, unknown>; context?: Record<string, unknown> }
  | { type: 'sample_request'; sampleId: string; messages: unknown[]; systemPrompt?: string; maxTokens?: number; tools?: unknown[]; toolChoice?: unknown; schema?: Record<string, unknown> }
  | { type: 'result'; result: unknown }
  | { type: 'error'; name: string; message: string; stack?: string }
  | { type: 'cancelled'; reason?: string }

export type RuntimeResponse =
  | { type: 'tool_event'; toolSessionId: string; runtimeEventSeq: number; runtimeEventId: string; event: RuntimeEvent }
  | { type: 'session_status'; toolSessionId: string; status: ToolStatus; pendingRequest?: { type: 'elicit'; elicitId: string } | { type: 'sample'; sampleId: string }; lastRuntimeEventSeq: number }
  | { type: 'session_not_found'; toolSessionId: string }
  | { type: 'command_duplicate'; toolSessionId: string; commandId: string; originalStatus: 'accepted' | 'rejected' }
  | { type: 'command_conflict'; toolSessionId: string; commandId: string; message: string }
  | { type: 'protocol_error'; message: string; details?: unknown }

export function parseRuntimeRequest(input: unknown): RuntimeRequest {
  return RuntimeRequestSchema.parse(input)
}
