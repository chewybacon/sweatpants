import {
  createContext,
  useScope,
  type Api,
  type Around,
  type Operation,
  type Scope,
} from "effection";
import { createApi } from "effection/experimental";

/**
 * A port is one effectful boundary that composition installs a driver into.
 *
 * The declaration is the contract, the runtime key list, and the fail-closed
 * default. No Context is exported, so callers cannot reach around the seam to
 * an installed driver; the only way in is `installDriver`.
 *
 * Foundation carries this because it is a portable composition primitive with
 * no Node-only API, I/O, or domain noun (DR-042).
 */
export interface Port<T extends object> {
  readonly api: Api<T>;
  /**
   * A handle whose calls dispatch against `scope` rather than the caller's.
   *
   * Needed whenever work is handed to a task that is deliberately not a child
   * of the installing scope, such as a Host-owned writer: the consumer must
   * still reach the driver installed where the work originated. Middleware
   * still applies, so this is not a driver handout.
   */
  bind(scope: Scope): T;
  /**
   * Whether a driver is installed for the calling scope.
   *
   * Some seams are genuinely optional: a Host may run with no tool runtime at
   * all. Those callers need to branch on configuration without being handed the
   * driver, which is what a Context would have leaked.
   */
  isInstalled(): Operation<boolean>;
  /**
   * Installs one adapter as the innermost, terminal link for this scope.
   *
   * Drivers install at `min` so policy and observation middleware, which use
   * the default `max`, always surround them regardless of installation order.
   */
  installDriver(driver: T): Operation<void>;
}

export function definePort<T extends object>(name: string, declaration: T): Port<T> {
  const keys = Object.keys(declaration);
  const valueMember = keys.find(
    (key) => typeof (declaration as Record<string, unknown>)[key] !== "function",
  );
  if (valueMember) {
    throw new TypeError(
      `Port "${name}" member "${valueMember}" is not a function. ` +
        "Value members are read eagerly by createApi, so they cannot fail closed; " +
        "expose the value as an operation instead.",
    );
  }

  const api = createApi(name, declaration);
  // Presence is tracked by a companion api rather than a Context so that an
  // optional seam can be probed without exposing the installed driver.
  // Records which scope installed a driver so a second install in that same
  // scope can be rejected. Ancestors hold a different scope value, which is how
  // legitimate child-scope shadowing stays allowed.
  const owner = createContext<Scope | undefined>(`${name}:owner`, undefined);
  const presence = createApi(`${name}:installed`, {
    *installed(): Operation<boolean> {
      return false;
    },
  });

  return {
    api,
    bind(scope: Scope): T {
      // SAFETY: one entry per declared key, forwarding the exact argument tuple
      // to `invoke`, which returns that member's own return type.
      return Object.fromEntries(
        keys.map((key) => [
          key,
          (...args: unknown[]) => api.invoke(scope, key as keyof T, args as never),
        ]),
      ) as T;
    },
    isInstalled() {
      return presence.operations.installed();
    },
    *installDriver(driver: T): Operation<void> {
      const scope = yield* useScope();
      if ((yield* owner.get()) === scope) {
        throw new Error(
          `Port "${name}" already has a driver installed in this scope. ` +
            "Drivers are terminal, so a second install in the same scope would be " +
            "silently ignored rather than replacing the first. Install the " +
            "override in a child scope, or install only one driver here.",
        );
      }
      yield* owner.set(scope);

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
      yield* presence.around(
        {
          *installed() {
            return true;
          },
        },
        { at: "min" },
      );
    },
  };
}
