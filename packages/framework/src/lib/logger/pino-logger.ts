/**
 * Pino Logger Implementation
 *
 * Default logger implementation using pino with pretty output in development.
 */
import pino from 'pino'
import type { Logger, LoggerFactory } from './types.ts'

const ROOT_NAME = 'framework'

export interface PinoLoggerOptions {
  /** Log level (default: process.env.LOG_LEVEL || 'debug') */
  level?: string
  /** Use pretty printing (default: true in development) */
  pretty?: boolean
}

/**
 * Create a pino-based logger factory.
 *
 * @example
 * ```typescript
 * const factory = createPinoLoggerFactory({ level: 'debug' })
 * const logger = factory('handler:durable')
 * logger.debug({ sessionId: '123' }, 'request received')
 * ```
 */
export function createPinoLoggerFactory(options: PinoLoggerOptions = {}): LoggerFactory {
  const {
    level = process.env['LOG_LEVEL'] || 'debug',
    pretty = process.env['NODE_ENV'] !== 'production',
  } = options

  const rootLogger = pretty
    ? pino({
        name: ROOT_NAME,
        level,
        transport: { target: 'pino-pretty', options: { colorize: true } },
      })
    : pino({
        name: ROOT_NAME,
        level,
      })

  return (name: string): Logger => {
    return rootLogger.child({ module: name }) as Logger
  }
}
