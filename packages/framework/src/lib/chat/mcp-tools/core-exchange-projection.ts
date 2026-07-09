import type { ElicitExchange, InteractionExchange, SampleExchange } from '@sweatpants/core'
import type { McpMessage } from './protocol/types.ts'

function textMessage(role: 'user' | 'assistant', text: string): McpMessage {
  return { role, content: [{ type: 'text', text }] }
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}

function asMcpMessages(messages: unknown): McpMessage[] | null {
  if (!Array.isArray(messages)) return null
  return messages as McpMessage[]
}

/**
 * Project an elicit exchange into MCP-compatible transcript messages.
 * Prefer the already-constructed message-pair shape; fall back to legacy fields.
 */
export function projectCoreElicitExchangeToMcpMessages(exchange: ElicitExchange<unknown>): McpMessage[] {
  const existing = asMcpMessages(exchange.messages)
  if (existing && existing.length >= 2) return existing

  // Legacy fallback (old kind/key/request shape) if present
  const legacy = exchange as unknown as {
    key?: string
    request?: { message?: string; context?: unknown }
    response?: unknown
  }
  const key = legacy.key ?? 'elicit'
  const request: McpMessage = {
    role: 'assistant',
    content: [{
      type: 'tool_use',
      id: `elicit:${key}`,
      name: `elicit:${key}`,
      input: {
        message: legacy.request?.message ?? '',
        ...(legacy.request?.context === undefined ? {} : { context: legacy.request.context }),
      },
    }],
  }
  const response: McpMessage = {
    role: 'user',
    content: [{
      type: 'tool_result',
      toolUseId: `elicit:${key}`,
      content: [{ type: 'text', text: stringify(legacy.response) }],
    }],
  }
  return [request, response]
}

/**
 * Project a sample exchange into MCP-compatible transcript messages.
 */
export function projectCoreSampleExchangeToMcpMessages(exchange: SampleExchange): McpMessage[] {
  const existing = asMcpMessages(exchange.messages)
  if (existing && existing.length > 0) return existing

  const legacy = exchange as unknown as { request?: unknown; response?: unknown }
  const messages: McpMessage[] = []
  if (legacy.request !== undefined) {
    messages.push(textMessage('user', stringify(legacy.request)))
  }
  if (legacy.response !== undefined) {
    messages.push(textMessage('assistant', stringify(legacy.response)))
  }
  return messages
}

export function projectCoreInteractionExchangeToMcpMessages(exchange: InteractionExchange): McpMessage[] {
  if ('messages' in exchange && Array.isArray(exchange.messages) && 'withArguments' in exchange) {
    return projectCoreElicitExchangeToMcpMessages(exchange as ElicitExchange<unknown>)
  }
  if ('messages' in exchange) {
    return projectCoreSampleExchangeToMcpMessages(exchange as SampleExchange)
  }
  // Discriminate by kind if present
  if ((exchange as { kind?: string }).kind === 'elicit') {
    return projectCoreElicitExchangeToMcpMessages(exchange as ElicitExchange<unknown>)
  }
  return projectCoreSampleExchangeToMcpMessages(exchange as SampleExchange)
}

/** @deprecated Prefer projectCoreInteractionExchangeToMcpMessages */
export function projectCoreExchangeToMcpMessages(exchange: InteractionExchange): McpMessage[] {
  return projectCoreInteractionExchangeToMcpMessages(exchange)
}

export function projectCoreExchangesToMcpMessages(exchanges: readonly InteractionExchange[]): McpMessage[] {
  return exchanges.flatMap(projectCoreInteractionExchangeToMcpMessages)
}
