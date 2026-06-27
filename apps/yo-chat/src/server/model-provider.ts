import type { Operation } from 'effection'
import type { ChatHandlerSetupContext } from '@sweatpants/framework/server'
import {
  installPiAiModelProvider,
  parseAllowedModelsJson,
  parseRequestModelSelection,
  resolveModelSelection,
  resolvePiAiModel,
  type ModelSelection,
} from '@sweatpants/model-provider-pi-ai'
import { env } from '@/env'
import { installScriptedRenderingModelProvider } from './scripted-rendering-provider'

type ChatRequestModelBody = {
  model?: unknown
}

function defaultChatModel(): ModelSelection {
  return {
    provider: env.DEFAULT_CHAT_MODEL_PROVIDER,
    id: env.DEFAULT_CHAT_MODEL_ID,
  }
}

export function* setupYoChatModelProvider(ctx: ChatHandlerSetupContext): Operation<void> {
  const url = new URL(ctx.request.url)
  if (url.searchParams.get('scripted') === 'rendering') {
    yield* installScriptedRenderingModelProvider()
    return
  }

  const body = ctx.body as ChatRequestModelBody
  const requestModel = parseRequestModelSelection(body.model, 'model')
  const selection = resolveModelSelection({
    requestModel,
    defaultModel: defaultChatModel(),
    allowedModels: parseAllowedModelsJson(env.ALLOWED_CHAT_MODELS_JSON),
    unsafeAllowAny: env.UNSAFE_ALLOW_ANY_CHAT_MODEL === 'yes',
  })

  yield* installPiAiModelProvider({ model: resolvePiAiModel(selection) })
}
