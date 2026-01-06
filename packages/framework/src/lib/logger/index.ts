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
 * // Setup in initializer hook
 * import { setupLogger } from '@sweatpants/framework/chat'
 *
 * createDurableChatHandler({
 *   initializerHooks: [setupLogger, ...],
 * })
 *
 * // Use in operations
 * const log = yield* useLogger('handler:durable')
 * log.debug({ sessionId }, 'request received')
 * ```
 */
export type { Logger, LoggerFactory } from './types'
export { LoggerFactoryContext, useLogger } from './context'
export { createNoopLogger } from './noop-logger'
export { createPinoLoggerFactory, type PinoLoggerOptions } from './pino-logger'
export { setupLogger, createLoggerSetup } from './setup'
