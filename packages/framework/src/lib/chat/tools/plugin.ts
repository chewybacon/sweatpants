/**
 * Tool Plugin System
 *
 * Re-exports the plugin system from mcp-tools.
 * Plugins bundle tools with their React UI handlers.
 *
 * @example Creating a plugin
 * ```typescript
 * import { createTool, makePlugin } from '@sweatpants/framework/chat/tools'
 *
 * const pickCardTool = createTool('pick_card')
 *   .description('Pick a card')
 *   .parameters(z.object({}))
 *   .elicit('pick', z.object({ card: z.string() }))
 *   .handoff({
 *     *before() { return { cards: ['A', 'K', 'Q'] } },
 *     *client(handoff, ctx) {
 *       const result = yield* ctx.elicit('pick', { message: 'Pick', cards: handoff.cards })
 *       return { picked: result.content.card }
 *     },
 *     *after(handoff, client) { return { selected: client.picked } }
 *   })
 *
 * export const pickCardPlugin = makePlugin(pickCardTool)
 *   .onElicit({
 *     pick: function* (req, ctx) {
 *       const response = yield* ctx.render(CardPicker, {
 *         cards: req.cards,
 *         message: req.message,
 *       })
 *       return { action: 'accept', content: response }
 *     },
 *   })
 *   .build()
 * ```
 *
 * @packageDocumentation
 */

// Re-export the plugin system from mcp-tools
export {
  makePlugin,
  type PluginBuilder,
  type PluginClientContext,
  type PluginClientRegistration,
  type PluginClientRegistrationInput,
  type PluginServerRegistration,
  type ElicitHandler,
  type ElicitHandlers,
} from '../mcp-tools/plugin.ts'

// Re-export renderable props for component authors
export type {
  RenderableProps,
  UserProps,
  ExtractResponse,
} from '../mcp-tools/plugin.ts'

// Re-export plugin registry
export {
  createPluginRegistryFrom,
  type PluginRegistry,
} from '../mcp-tools/plugin-registry.ts'
