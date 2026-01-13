/**
 * Logger Context and Hook
 *
 * Provides Effection-based dependency injection for loggers.
 * Use setupLogger() to configure logging, then useLogger() to get loggers.
 */
import { createContext, type Operation } from 'effection'
import type { Logger, LoggerFactory } from './types.ts'
import { createNoopLogger } from './noop-logger.ts'

/**
 * Effection context for the logger factory.
 * Set via setupLogger() initializer hook.
 */
export const LoggerFactoryContext = createContext<LoggerFactory>('LoggerFactory')

/**
 * Get a logger for the given namespace.
 * Returns a no-op logger if LoggerFactoryContext is not configured.
 *
 * @param name - Logger namespace (e.g., 'handler:durable', 'durable-streams:registry')
 *
 * @example
 * ```typescript
 * const log = yield* useLogger('handler:durable')
 * log.debug({ sessionId }, 'request received')
 * ```
 */
export function* useLogger(name: string): Operation<Logger> {
  const factory = yield* LoggerFactoryContext.get()
  if (!factory) {
    return createNoopLogger()
  }
  return factory(name)
}
