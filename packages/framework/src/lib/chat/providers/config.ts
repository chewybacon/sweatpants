import type { Operation } from 'effection'
import { ChatStreamConfigContext, ChatApiKeyContext } from './contexts'
import type { ChatStreamOptions } from './types'

export interface ResolveConfigDefaults {
  baseUri: string
  model: string
  /** Optional environment variable name to pull an API key from */
  envApiKeyName?: string
}

/**
 * Resolve chat stream configuration by merging (in order):
 * 1) explicit options passed to the provider
 * 2) context-provided config (ChatStreamConfigContext)
 * 3) environment-derived defaults provided by the caller
 */
export function* resolveChatStreamConfig(
  options: ChatStreamOptions | undefined,
  defaults: ResolveConfigDefaults
): Operation<ChatStreamOptions> {
  const ctxConfig = yield* ChatStreamConfigContext.get()
  const ctxApiKey = yield* ChatApiKeyContext.get()

  const envApiKey = defaults.envApiKeyName
    ? (process.env[defaults.envApiKeyName] as string | undefined)
    : undefined

  return {
    baseUri: options?.baseUri ?? ctxConfig?.baseUri ?? defaults.baseUri,
    model: options?.model ?? ctxConfig?.model ?? defaults.model,
    apiKey: options?.apiKey ?? ctxApiKey ?? envApiKey ?? null,
    isomorphicToolSchemas:
      options?.isomorphicToolSchemas ?? ctxConfig?.isomorphicToolSchemas ?? [],
  }
}
