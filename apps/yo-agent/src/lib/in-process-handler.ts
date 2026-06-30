import { createChatHandler, type ChatHandlerSetupContext } from '@sweatpants/framework/server'
import {
  MaxIterationsContext,
  ToolInventoryContext,
  createToolInventory,
} from '@sweatpants/framework/chat'
import type { ToolDefinition } from '@sweatpants/core'
import {
  installPiAiModelProvider,
  resolvePiAiModel,
  type ModelSelection,
} from '@sweatpants/model-provider-pi-ai'
import { setupInMemoryDurableStreams } from '@sweatpants/framework/chat/durable-streams'
import {
  createToolInventoryEntry,
  installLocalToolRuntime,
} from '@sweatpants/tool-runtime-local'
import type { Operation } from 'effection'

export type AgentTool = ToolDefinition<string, unknown, unknown, any, any>

export interface InProcessHandlerConfig {
  model: ModelSelection
  tools: AgentTool[]
  maxIterations?: number
}

export function createInProcessHandler(config: InProcessHandlerConfig) {
  const { model: modelSelection, tools, maxIterations = 10 } = config

  const setupDurableStreams = function* (_ctx: ChatHandlerSetupContext): Operation<void> {
    yield* setupInMemoryDurableStreams<string>()
  }

  const setupProvider = function* (_ctx: ChatHandlerSetupContext): Operation<void> {
    yield* installPiAiModelProvider({ model: resolvePiAiModel(modelSelection) })
  }

  const setupTools = function* (_ctx: ChatHandlerSetupContext): Operation<void> {
    yield* ToolInventoryContext.set(createToolInventory(tools.map((tool) => createToolInventoryEntry(tool))))
    yield* installLocalToolRuntime({ tools })
  }

  const setupMaxIterations = function* (_ctx: ChatHandlerSetupContext): Operation<void> {
    yield* MaxIterationsContext.set(maxIterations)
  }

  const handler = createChatHandler({
    setup: function* setup(ctx) {
      yield* setupDurableStreams(ctx)
      yield* setupProvider(ctx)
      yield* setupTools(ctx)
      yield* setupMaxIterations(ctx)
    },
    maxToolIterations: maxIterations,
  })

  async function inProcessFetch(
    input: string | Request,
    init?: RequestInit
  ): Promise<Response> {
    const request = typeof input === 'string'
      ? new Request(input, init)
      : input

    const url = request.url
    if (url.endsWith('/api/chat') && request.method === 'POST') {
      return handler(request)
    }

    return new Response('Not found', { status: 404 })
  }

  return inProcessFetch
}

export const IN_PROCESS_BASE_URL = 'http://localhost:0'
