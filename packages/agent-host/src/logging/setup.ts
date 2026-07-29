/**
 * Logger Setup
 *
 * Provides setup helpers for initializing the logging infrastructure.
 */
import type { Operation } from "effection";
import { LoggerFactoryContext, type LoggerFactory } from "@sweatpants/durable-chat-runtime/logger";
import { createPinoLoggerFactory } from "./pino-logger.ts";

/**
 * Setup logger infrastructure as a chat setup operation.
 * Uses pino with debug level by default.
 *
 * This function can be used directly as a chat handler or application setup operation.
 *
 * @example
 * ```typescript
 * // Use default pino logger
 * createDurableChatHandler({
 *   setup: setupLogger,
 * })
 * ```
 */
export function* setupLogger(_ctx?: unknown): Operation<void> {
  const factory = createPinoLoggerFactory();
  yield* LoggerFactoryContext.set(factory);
}

/**
 * Create a custom logger setup hook with a specific factory.
 *
 * @param factory - Custom logger factory to use
 *
 * @example
 * ```typescript
 * createDurableChatHandler({
 *   setup: createLoggerSetup(myCustomLoggerFactory),
 * })
 * ```
 */
export function createLoggerSetup(factory: LoggerFactory) {
  return function* (_ctx?: unknown): Operation<void> {
    yield* LoggerFactoryContext.set(factory);
  };
}
