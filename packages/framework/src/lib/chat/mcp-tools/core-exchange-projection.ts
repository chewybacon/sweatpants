import type { ElicitExchange, InteractionExchange, SampleExchange } from '@sweatpants/core'
import type { McpMessage } from './protocol/types.ts'

function textMessage(role: 'user' | 'assistant', text: string): McpMessage {
  return { role, content: [{ type: 'text', text }] }
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}

/**
 * Project a protocol-neutral core elicit exchange into MCP-compatible transcript messages.
 * The projection is intentionally adapter-local; core exchange values remain unchanged.
 */
export function projectCoreElicitExchangeToMcpMessages(exchange: ElicitExchange): McpMessage[] {
  const request: McpMessage = {
    role: 'assistant',
    content: [{
      type: 'tool_use',
      id: `elicit:${exchange.key}`,
      name: `elicit:${exchange.key}`,
      input: {
        message: exchange.request.message,
        ...(exchange.request.context === undefined ? {} : { context: exchange.request.context }),
      },
    }],
  }

  const response: McpMessage = {
    role: 'user',
    content: [{
      type: 'tool_result',
      toolUseId: `elicit:${exchange.key}`,
      content: [{ type: 'text', text: stringify(exchange.response) }],
    }],
  }

  return [request, response]
}

/**
 * Project a protocol-neutral core sample exchange into MCP-compatible transcript messages.
 */
export function projectCoreSampleExchangeToMcpMessages(exchange: SampleExchange): McpMessage[] {
  const prompt = typeof (exchange.request as { prompt?: unknown } | undefined)?.prompt === 'string'
    ? ((exchange.request as { prompt: string }).prompt)
    : stringify(exchange.request)

  const responseText = typeof (exchange.response as { text?: unknown } | undefined)?.text === 'string'
    ? ((exchange.response as { text: string }).text)
    : typeof (exchange.response as { content?: unknown } | undefined)?.content === 'string'
      ? ((exchange.response as { content: string }).content)
      : stringify(exchange.response)

  return [
    textMessage('user', prompt),
    textMessage('assistant', responseText),
  ]
}

/**
 * Project any protocol-neutral core exchange into MCP-compatible transcript messages.
 */
export function projectCoreExchangeToMcpMessages(exchange: InteractionExchange): McpMessage[] {
  return exchange.kind === 'elicit'
    ? projectCoreElicitExchangeToMcpMessages(exchange)
    : projectCoreSampleExchangeToMcpMessages(exchange)
}

export function projectCoreExchangesToMcpMessages(exchanges: readonly InteractionExchange[]): McpMessage[] {
  return exchanges.flatMap(projectCoreExchangeToMcpMessages)
}
