import type { Operation } from 'effection'
import type { ChatHandlerSetupContext } from '@sweatpants/framework/server'
import { installPiAiModelProvider, resolveRuntimeModel } from '@sweatpants/model-provider-pi-ai'
import { env } from '@/env'

export function* setupYoChatModelProvider(ctx: ChatHandlerSetupContext): Operation<void> {
  const body = ctx.body as { provider?: string; model?: string }
  const providerName = body.provider || env.CHAT_PROVIDER
  yield* installPiAiModelProvider({ model: resolveRuntimeModel(providerName, body.model) })
}
