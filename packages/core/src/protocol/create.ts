import type { Operation } from "effection";
import type {
  Methods,
  Protocol,
  Handle,
  Inspector,
  Implementation,
  InvocationArgs,
  InvocationResult,
} from "./types.ts";

/**
 * Create a protocol definition from a set of methods.
 * 
 * A protocol is just a schema - it defines what methods exist and their
 * input/progress/output types, but doesn't include implementation.
 * 
 * @example
 * ```ts
 * const MyProtocol = createProtocol({
 *   search: {
 *     input: z.object({ query: z.string() }),
 *     progress: z.object({ percent: z.number() }),
 *     output: z.object({ results: z.array(z.string()) }),
 *   },
 *   notify: {
 *     input: z.object({ message: z.string() }),
 *     progress: z.never(),
 *     output: z.object({ ok: z.boolean() }),
 *   },
 * });
 * ```
 */
export function createProtocol<M extends Methods>(methods: M): Protocol<M> {
  return { methods };
}

/**
 * Create an inspector by binding an implementation to a protocol.
 * 
 * The implementation is a function that returns method handlers.
 * This allows handlers to be set up with access to the current scope/context.
 * 
 * Call `attach()` on the returned inspector to get a handle for invoking methods.
 * 
 * @example
 * ```ts
 * const inspector = createImplementation(MyProtocol, function*() {
 *   // Can set up resources, read context, etc.
 *   const db = yield* DatabaseContext.expect();
 *   
 *   return {
 *     search(args) {
 *       return resource(function*(provide) {
 *         const results = yield* db.search(args.query);
 *         yield* provide({ *next() { return { done: true, value: { results } }; } });
 *       });
 *     },
 *     notify(args) {
 *       return resource(function*(provide) {
 *         console.log(args.message);
 *         yield* provide({ *next() { return { done: true, value: { ok: true } }; } });
 *       });
 *     },
 *   };
 * });
 * 
 * // Later, attach to get a handle
 * const handle = yield* inspector.attach();
 * const stream = handle.invoke({ name: "search", args: { query: "hello" } });
 * ```
 */
export function createImplementation<M extends Methods>(
  protocol: Protocol<M>,
  implementation: Implementation<M>,
): Inspector<M> {
  return {
    protocol,
    *attach(): Operation<Handle<M>> {
      const methods = yield* implementation();
      
      return {
        protocol,
        methods,
        invoke<N extends keyof M>(invocation: InvocationArgs<M, N>): InvocationResult<M, N> {
          const { name, args } = invocation;
          const handler = methods[name];
          return handler(args) as InvocationResult<M, N>;
        },
      };
    },
  };
}
