import type { Api, Around, Operation } from "effection";
import { createApi } from "effection/experimental";

/**
 * A port is one effectful boundary that composition installs a driver into.
 *
 * The declaration is the contract, the runtime key list, and the fail-closed
 * default. No Context is exported, so callers cannot reach around the seam to
 * an installed driver; the only way in is `installDriver`.
 *
 * This lives in `durable-effects` rather than `foundation` because foundation
 * must stay free of Effection runtime code.
 */
export interface Port<T extends object> {
  readonly api: Api<T>;
  /**
   * Installs one adapter as the innermost, terminal link for this scope.
   *
   * Drivers install at `min` so policy and observation middleware, which use
   * the default `max`, always surround them regardless of installation order.
   */
  installDriver(driver: T): Operation<void>;
}

export function definePort<T extends object>(name: string, declaration: T): Port<T> {
  const api = createApi(name, declaration);
  const keys = Object.keys(declaration);
  return {
    api,
    *installDriver(driver: T): Operation<void> {
      const middleware = Object.fromEntries(
        keys.map((key) => [
          key,
          (args: unknown[]) =>
            (driver as unknown as Record<string, (...args: unknown[]) => unknown>)[key]!(...args),
        ]),
      );
      // SAFETY: middleware is derived from the declaration's own keys and
      // forwards the exact argument tuple to the adapter, so it satisfies
      // Around<T> for every declared operation.
      yield* api.around(middleware as unknown as Partial<Around<T>>, { at: "min" });
    },
  };
}
