import type { Handler, HandlerMiddleware } from "./primitives.ts";

/** First middleware is outermost; each layer receives the rest of the chain. */
export function withMiddleware<Request, Y, Reply = unknown>(
  handler: Handler<Request, Y, Reply>,
  layers: readonly HandlerMiddleware<Request, Y, Reply>[],
): Handler<Request, Y, Reply> {
  return layers.reduceRight<Handler<Request, Y, Reply>>(
    (next, layer) => (request) => layer([request], next),
    handler,
  );
}

export function trace<Request, Y, Reply = unknown>(
  log: (event: string, value: unknown) => void,
): HandlerMiddleware<Request, Y, Reply> {
  return function* ([request], next) {
    log("request", request);
    try {
      const reply = yield* next(request);
      log("reply", reply);
      return reply;
    } catch (error) {
      log("error", error);
      throw error;
    }
  };
}
