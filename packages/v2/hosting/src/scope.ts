import type { Composition, Context, Operation } from "@standard-durability/core";
import type { Journal } from "@sweatpan.ts/durable";
import type { Hosting } from "./contracts.ts";

/** Install ordinary middleware on each host in this native scope and its children.
 * Selection happens when run starts, not at host construction. New runtime roots
 * must install their own policy. No policy is retained in a journal or Guest. */
export interface HostingMiddleware<Y> {
  install<R, Q, V, E, S>(
    host: Hosting<R, Q, V, E, Y>,
    journal: Journal<R, Q, V, E, S, Y>,
  ): Operation<void, Y>;
}

const contexts = new WeakMap<object, unknown>();
function context<Y>(composition: Composition<Y>): Context<readonly HostingMiddleware<Y>[], Y> {
  let stored = contexts.get(composition) as Context<readonly HostingMiddleware<Y>[], Y> | undefined;
  if (!stored) {
    stored = composition.createContext<readonly HostingMiddleware<Y>[]>("hosting.middleware");
    contexts.set(composition, stored);
  }
  return stored;
}

export function* installHostingMiddleware<Y>(
  composition: Composition<Y>,
  middleware: HostingMiddleware<Y>,
): Operation<void, Y> {
  const selected = context(composition);
  const inherited = (yield* selected.get()) ?? [];
  yield* selected.set([...inherited, middleware]);
}

export function* configureHostingMiddleware<R, Q, V, E, S, Y>(
  composition: Composition<Y>,
  host: Hosting<R, Q, V, E, Y>,
  journal: Journal<R, Q, V, E, S, Y>,
): Operation<void, Y> {
  for (const middleware of (yield* context(composition).get()) ?? []) {
    yield* middleware.install(host, journal);
  }
}
