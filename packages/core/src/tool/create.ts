import { createApi } from "@effectionx/context-api";
import type { Operation, Subscription } from "effection";
import type { ZodSchema, infer as ZodInfer } from "zod";
import type {
  ToolConfig,
  ToolImplFn,
  Tool,
  ToolMiddleware,
  ToolFactoryWithImpl,
  ToolFactoryWithoutImpl,
} from "./types.ts";
import { TransportContext } from "../context/transport.ts";
import type { ElicitResponse } from "../types/transport.ts";

/**
 * Creates a tool with implementation provided in config.
 */
export function createTool<
  TInput extends ZodSchema,
  TProgress extends ZodSchema,
  TOutput extends ZodSchema,
>(
  config: ToolConfig<TInput, TProgress, TOutput> & {
    impl: ToolImplFn<TInput, TProgress, TOutput>;
  },
): ToolFactoryWithImpl<TInput, TOutput>;

/**
 * Creates a tool without implementation.
 * Implementation must be provided at activation, or tool routes to transport.
 */
export function createTool<
  TInput extends ZodSchema,
  TProgress extends ZodSchema | undefined,
  TOutput extends ZodSchema,
>(
  config: ToolConfig<TInput, TProgress, TOutput> & { impl?: never },
): ToolFactoryWithoutImpl<TInput, TProgress, TOutput>;

/**
 * Creates a tool that can be activated and invoked.
 *
 * @example
 * ```ts
 * // Tool with impl in config
 * const Search = createTool({
 *   name: "search",
 *   description: "Search for flights",
 *   input: z.object({ destination: z.string() }),
 *   output: z.object({ flights: z.array(FlightSchema) }),
 *   impl: function* ({ destination }) {
 *     const flights = yield* searchFlights(destination);
 *     return { flights };
 *   },
 * });
 *
 * const search = yield* Search();
 * const result = yield* search({ destination: "Tokyo" });
 *
 * // Tool without impl - provide at activation
 * const GetLocation = createTool({
 *   name: "get-location",
 *   description: "Get user location",
 *   input: z.object({ accuracy: z.enum(["high", "low"]) }),
 *   output: z.object({ lat: z.number(), lng: z.number() }),
 * });
 *
 * const getLocation = yield* GetLocation(implFn);
 * // or route to transport:
 * const getLocation = yield* GetLocation();
 * ```
 */
export function createTool<
  TInput extends ZodSchema,
  TProgress extends ZodSchema | undefined,
  TOutput extends ZodSchema,
>(
  config: ToolConfig<TInput, TProgress, TOutput>,
): ToolFactoryWithImpl<TInput, TOutput> | ToolFactoryWithoutImpl<TInput, TProgress, TOutput> {
  type Input = ZodInfer<TInput>;
  type Output = ZodInfer<TOutput>;

  // Create the API for this tool
  // The handler is the default impl or a placeholder that routes to transport
  const api = createApi(config.name, {
    *invoke(_args: Input): Operation<Output> {
      // This will be overridden when tool is activated
      throw new Error(
        `Tool "${config.name}" was invoked but not activated. ` +
        `Call yield* ${config.name}() or yield* ${config.name}(impl) first.`
      );
    },
  });

  // Factory function that activates the tool
  function factory(
    impl?: ToolImplFn<TInput, TProgress, TOutput>,
  ): Operation<Tool<TInput, TOutput>> {
    return {
      *[Symbol.iterator]() {
        // Determine which impl to use
        const actualImpl = impl ?? config.impl;

        if (actualImpl) {
          // Create a send function for progress (placeholder for now)
          const send = function* (_progress: unknown): Operation<void> {
            // TODO: Route progress through transport
            // For now, just a no-op
          };

          // Install the impl as middleware that replaces the default
          yield* api.around({
            *invoke([args], _next) {
              // @ts-expect-error - send typing is complex, will refine later
              return yield* actualImpl(args, send);
            },
          });
        } else {
          // No impl - route to transport
          yield* api.around({
            *invoke([args], _next) {
              // Get transport from context
              const transport = yield* TransportContext.expect();
              
              // Generate unique request ID
              const requestId = `${config.name}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
              
              // Send request through transport and get response stream
              const stream = transport.request<ZodInfer<TProgress>, ElicitResponse>({
                id: requestId,
                kind: "elicit",
                type: config.name,
                payload: args,
              });
              
              // Subscribe to the stream
              const subscription: Subscription<ZodInfer<TProgress>, ElicitResponse> = yield* stream;
              
              // Consume the stream until we get the final response
              // Progress updates are currently ignored (TODO: expose via callback or context)
              let result = yield* subscription.next();
              while (!result.done) {
                // Progress update - currently ignored
                // In the future, we could emit these via a progress context
                result = yield* subscription.next();
              }
              
              // result.value is the final response (ElicitResponse)
              const response = result.value;
              
              if (response.status === "accepted") {
                return response.content as Output;
              } else if (response.status === "declined") {
                throw new Error(`Tool "${config.name}" request was declined`);
              } else if (response.status === "cancelled") {
                throw new Error(`Tool "${config.name}" request was cancelled`);
              } else if (response.status === "denied") {
                throw new Error(`Tool "${config.name}" request was denied`);
              } else if (response.status === "other") {
                throw new Error(`Tool "${config.name}" request failed: ${response.content}`);
              }
              
              // TypeScript exhaustiveness check
              throw new Error(`Tool "${config.name}" received unexpected response status`);
            },
          });
        }

        // Return the activated tool function
        const tool: Tool<TInput, TOutput> = (args: Input): Operation<Output> => {
          return api.operations.invoke(args);
        };

        return tool;
      },
    };
  }

  // Attach decorate method
  factory.decorate = function (
    middleware: ToolMiddleware<TInput, TOutput>,
  ): Operation<void> {
    return api.around({
      *invoke([args], next) {
        return yield* middleware(args, (...a) => next(...a));
      },
    });
  };

  // Attach metadata
  Object.defineProperty(factory, "name", {
    value: config.name,
    writable: false,
  });
  Object.defineProperty(factory, "description", {
    value: config.description,
    writable: false,
  });

  return factory as ToolFactoryWithImpl<TInput, TOutput> | ToolFactoryWithoutImpl<TInput, TProgress, TOutput>;
}
