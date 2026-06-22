import type { Operation } from 'effection'
import {
  ModelProviderApi,
  type ExtendedMessage,
  type Message,
  type SamplingToolCall,
  type SamplingToolDefinition,
} from '@sweatpants/framework/chat'
import type {
  RawSampleResult,
  RawSampleResultBase,
  RawSampleResultWithParsed,
  RawSampleResultWithToolCalls,
  ToolSessionSamplingProvider,
} from '@sweatpants/framework/chat/mcp-tools'
import { extendedMessageToProviderMessage } from '@sweatpants/framework/chat/mcp-tools'
import {
  type AssistantMessage as ModelAssistantMessage,
  type Context as ModelContext,
  type Message as ModelMessage,
  type Tool as ModelTool,
} from '@sweatpants/model-provider-pi-ai'

interface SamplingOptions {
  systemPrompt?: string
  maxTokens?: number
  tools?: SamplingToolDefinition[]
  toolChoice?: 'auto' | 'required' | 'none'
  schema?: Record<string, unknown>
}

type ProviderAssistantToolCall = NonNullable<Message['tool_calls']>[number]

function providerMessageToModelMessage(message: Message): ModelMessage {
  if (message.role === 'system') {
    return { role: 'system', content: message.content }
  }

  if (message.role === 'user') {
    return { role: 'user', content: message.content }
  }

  if (message.role === 'tool') {
    return {
      role: 'toolResult',
      toolCallId: message.tool_call_id ?? '',
      toolName: message.replay?.toolName ?? '',
      content: [{ type: 'text', text: message.content }],
      isError: message.content.startsWith('Error:'),
    }
  }

  return {
    role: 'assistant',
    content: [
      ...(message.content ? [{ type: 'text' as const, text: message.content }] : []),
      ...(message.tool_calls ?? []).map((toolCall: ProviderAssistantToolCall) => ({
        type: 'toolCall' as const,
        id: toolCall.id,
        name: toolCall.function.name,
        arguments: toolCall.function.arguments,
      })),
    ],
  }
}

function assistantText(message: ModelAssistantMessage): string {
  return message.content
    .filter((block): block is Extract<ModelAssistantMessage['content'][number], { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

function assistantToolCalls(message: ModelAssistantMessage): SamplingToolCall[] {
  return message.content
    .filter((block): block is Extract<ModelAssistantMessage['content'][number], { type: 'toolCall' }> => block.type === 'toolCall')
    .map((block) => ({
      id: block.id,
      name: block.name,
      arguments: block.arguments,
    }))
}

function samplingTools(tools: SamplingToolDefinition[] | undefined): ModelTool[] | undefined {
  return tools?.map((tool) => ({
    name: tool.name,
    description: tool.description ?? '',
    parameters: typeof tool.inputSchema === 'object' && tool.inputSchema !== null
      ? tool.inputSchema as Record<string, unknown>
      : { type: 'object', properties: {}, required: [] },
  }))
}

function modelContext(messages: ModelMessage[], options: SamplingOptions | undefined): ModelContext {
  const context: ModelContext = {
    messages,
    ...(options?.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
  }

  const tools = samplingTools(options?.tools)
  if (tools) {
    context.tools = tools
  }

  return context
}

export function createPluginSamplingProvider(): ToolSessionSamplingProvider {
  return {
    *sample(messages: ExtendedMessage[], options: SamplingOptions | undefined): Operation<RawSampleResult> {
      const modelMessages = messages
        .map(extendedMessageToProviderMessage)
        .map(providerMessageToModelMessage)

      const model = yield* ModelProviderApi.model()
      const assistant = yield* ModelProviderApi.sample({
        model,
        context: modelContext(modelMessages, options),
        options: {
          ...(options?.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
          ...(options?.toolChoice ? { toolChoice: options.toolChoice } : {}),
          ...(options?.schema ? { responseFormat: { type: 'json_schema', name: 'plugin_sample', schema: options.schema } } : {}),
        },
      })

      const text = assistantText(assistant)
      const toolCalls = assistantToolCalls(assistant)
      if (toolCalls.length > 0) {
        return {
          text,
          model: model.id,
          stopReason: 'toolUse',
          toolCalls,
        } satisfies RawSampleResultWithToolCalls
      }

      if (options?.schema) {
        try {
          return {
            text,
            model: model.id,
            stopReason: 'endTurn',
            parsed: JSON.parse(text),
          } satisfies RawSampleResultWithParsed<unknown>
        } catch (error) {
          return {
            text,
            model: model.id,
            stopReason: 'endTurn',
            parsed: null,
            parseError: {
              message: error instanceof Error ? error.message : 'Failed to parse JSON',
              rawText: text,
            },
          } satisfies RawSampleResultWithParsed<unknown>
        }
      }

      return {
        text,
        model: model.id,
        stopReason: assistant.stopReason === 'maxTokens' ? 'maxTokens' : 'endTurn',
      } satisfies RawSampleResultBase
    },
  }
}

export const pluginSamplingProvider = createPluginSamplingProvider()
