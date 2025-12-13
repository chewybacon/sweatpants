// logger-context.ts
import type { Operation, Context } from 'effection';
import { main, createContext, spawn, sleep } from 'effection';

interface Logger {
  log: (message: string) => void;
  error: (message: string) => void;
}

const LoggerContext: Context<Logger> = createContext<Logger>('logger');

// Create a prefixed logger
function createLogger(prefix: string): Logger {
  return {
    log: (msg: string) => console.log(`[${prefix}] ${msg}`),
    error: (msg: string) => console.error(`[${prefix}] ERROR: ${msg}`),
  };
}

function* doWork(): Operation<void> {
  const logger: Logger = yield* LoggerContext.expect();
  logger.log('Starting work...');
  yield* sleep(100);
  logger.log('Work complete!');
}

function* handleRequest(requestId: string): Operation<void> {
  // Create a request-specific logger
  yield* LoggerContext.set(createLogger(`REQ-${requestId}`));
  
  yield* doWork();
}

await main(function*() {
  // Set default logger
  yield* LoggerContext.set(createLogger('APP'));
  
  const logger: Logger = yield* LoggerContext.expect();
  logger.log('Application starting');
  
  // Handle multiple requests concurrently
  yield* spawn(() => handleRequest('001'));
  yield* spawn(() => handleRequest('002'));
  
  yield* sleep(200);
  
  logger.log('All requests complete');
});
