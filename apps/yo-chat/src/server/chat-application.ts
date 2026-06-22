import { createChatApplication, createChatHandler } from '@sweatpants/framework/server'
import { setupLogger } from '@sweatpants/framework/chat'
import { setupYoChatDurableStreams } from './durable-streams'
import { setupYoChatModelProvider } from './model-provider'
import { setupYoChatBaseContexts } from './tools'
import { setupYoChatPluginsAndRuntime } from './tool-runtime'
export { withDefaultSystemPrompt } from './default-system-prompt'

export function createYoChatApplication() {
  return createChatApplication({
    setup: function* setupApplication() {
      yield* setupLogger()
      yield* setupYoChatDurableStreams()
      yield* setupYoChatBaseContexts()
      yield* setupYoChatPluginsAndRuntime()
    },
    handler: createChatHandler({
      setup: setupYoChatModelProvider,
      maxToolIterations: 10,
    }),
  })
}

export const chatApp = createYoChatApplication()
