/**
 * Logger Setup
 *
 * Provides setup helpers for initializing the logging infrastructure.
 */
import type { Operation } from 'effection'
import type { LoggerFactory } from './types'
import { LoggerFactoryContext } from './context'
import { createPinoLoggerFactory } from './pino-logger'

/**
 * Setup logger infrastructure as an initializer hook.
 * Uses pino with debug level by default.
 *
 * This function conforms to the InitializerHook signature and can be used directly
 * in the initializerHooks array.
 *
 * @example
 * ```typescript
 * // Use default pino logger
 * createDurableChatHandler({
 *   initializerHooks: [setupLogger, ...otherHooks],
 * })
 * ```
 */
export function* setupLogger(_ctx?: unknown): Operation<void> {
  const factory = createPinoLoggerFactory()
  yield* LoggerFactoryContext.set(factory)
}

/**
 * Create a custom logger setup hook with a specific factory.
 *
 * @param factory - Custom logger factory to use
 *
 * @example
 * ```typescript
 * createDurableChatHandler({
 *   initializerHooks: [
 *     createLoggerSetup(myCustomLoggerFactory),
 *     ...otherHooks,
 *   ],
 * })
 * ```
 */
export function createLoggerSetup(factory: LoggerFactory) {
  return function* (_ctx?: unknown): Operation<void> {
    yield* LoggerFactoryContext.set(factory)
  }
}
