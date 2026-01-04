/**
 * Logger Types
 *
 * Defines the logger interface used throughout the framework.
 * Implementations can use pino, console, or any other logging library.
 */

/**
 * Logger interface compatible with pino's API.
 */
export interface Logger {
  trace(msg: string, ...args: unknown[]): void
  trace(obj: object, msg?: string, ...args: unknown[]): void
  debug(msg: string, ...args: unknown[]): void
  debug(obj: object, msg?: string, ...args: unknown[]): void
  info(msg: string, ...args: unknown[]): void
  info(obj: object, msg?: string, ...args: unknown[]): void
  warn(msg: string, ...args: unknown[]): void
  warn(obj: object, msg?: string, ...args: unknown[]): void
  error(msg: string, ...args: unknown[]): void
  error(obj: object, msg?: string, ...args: unknown[]): void
  child(bindings: Record<string, unknown>): Logger
}

/**
 * Factory function that creates loggers for a given namespace.
 */
export interface LoggerFactory {
  (name: string): Logger
}
