/**
 * No-op Logger Implementation
 *
 * A logger that does nothing. Used as a fallback when logging
 * is not configured or in production environments where logging
 * should be disabled.
 */
import type { Logger } from './types.ts'

const noop = () => {}

/**
 * Create a no-op logger that discards all log messages.
 */
export function createNoopLogger(): Logger {
  const logger: Logger = {
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => logger,
  }
  return logger
}
