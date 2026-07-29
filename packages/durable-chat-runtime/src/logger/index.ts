/**
 * Logger Module
 *
 * Provides logging infrastructure for the framework with:
 * - Pino-based default implementation
 * - Effection context-based DI
 * - Debug logging enabled by default
 *
 * @example
 * ```typescript
 * // Setup in chat handler/application setup
 * import { setupLogger } from '@sweatpants/chat-core'
 *
 * createDurableChatHandler({
 *   setup: setupLogger,
 * })
 *
 * // Use in operations
 * const log = yield* useLogger('handler:durable')
 * log.debug({ sessionId }, 'request received')
 * ```
 */
export type { Logger, LoggerFactory } from "./types.ts";
export { LoggerFactoryContext, useLogger } from "./context.ts";
export { createNoopLogger } from "./noop-logger.ts";
