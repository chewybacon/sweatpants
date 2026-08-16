import {
  createContext,
  useScope,
  type Api,
  type Context,
  type Operation,
  type Scope,
} from "effection";
import { createApi } from "effection/experimental";

export type ResolverImplementation<TInput, TOutput> = (input: TInput) => Operation<TOutput>;

export interface Resolver<TInput, TOutput> {
  resolve(input: TInput): Operation<TOutput>;
}

type ResolverHandler<TInput, TOutput> = Resolver<TInput, TOutput>;

export interface ResolverFacade<TInput, TOutput> extends Resolver<TInput, TOutput> {
  around: Api<ResolverHandler<TInput, TOutput>>["around"];
}

export interface DefinedResolver<TInput, TOutput> {
  readonly api: Api<ResolverHandler<TInput, TOutput>>;
  readonly context: Context<ResolverFacade<TInput, TOutput>>;
  use(): Operation<ResolverFacade<TInput, TOutput>>;
  install(implementation: ResolverImplementation<TInput, TOutput>): Operation<void>;
  with<T>(
    implementation: ResolverImplementation<TInput, TOutput> | undefined,
    body: () => Operation<T>,
  ): Operation<T>;
}

/**
 * Defines a scoped policy resolver with a middleware-preserving facade.
 *
 * The raw implementation is private to the terminal API handler. Trusted
 * callers receive the facade from `use()`/`context.expect()`, so their calls
 * continue through the current scope's resolver middleware without capturing a
 * Scope. A fallback is optional and domain-owned: absence without one fails
 * closed with `resolver_unavailable`.
 */
export function defineResolver<TInput, TOutput>(
  name: string,
  fallback?: ResolverImplementation<TInput, TOutput>,
): DefinedResolver<TInput, TOutput> {
  const rawImplementation = createContext<ResolverImplementation<TInput, TOutput> | undefined>(
    `${name}:implementation`,
    undefined,
  );
  const owner = createContext<Scope | undefined>(`${name}:owner`, undefined);
  const api = createApi<ResolverHandler<TInput, TOutput>>(name, {
    *resolve(input: TInput): Operation<TOutput> {
      const implementation = yield* rawImplementation.get();
      if (implementation) return yield* implementation(input);
      if (fallback) return yield* fallback(input);
      const error = new Error(`Resolver "${name}" is not installed`);
      Object.assign(error, { code: "resolver_unavailable" });
      throw error;
    },
  });
  const facade: ResolverFacade<TInput, TOutput> = {
    resolve: api.operations.resolve,
    around: api.around,
  };
  const context = createContext<ResolverFacade<TInput, TOutput>>(`${name}:facade`, facade);

  return {
    api,
    context,
    use() {
      return context.expect();
    },
    *install(implementation: ResolverImplementation<TInput, TOutput>): Operation<void> {
      const scope = yield* useScope();
      if ((yield* owner.get()) === scope) {
        throw new Error(`Resolver "${name}" already has an implementation in this scope`);
      }
      yield* owner.set(scope);
      yield* rawImplementation.set(implementation);
    },
    with<T>(
      implementation: ResolverImplementation<TInput, TOutput> | undefined,
      body: () => Operation<T>,
    ): Operation<T> {
      return rawImplementation.with(implementation, () => body());
    },
  };
}
