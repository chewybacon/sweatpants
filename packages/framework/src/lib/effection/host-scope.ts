import { createContext, type Operation, type Scope } from "effection";

/**
 * Internal structural owner installed only by createChatApplication.
 *
 * This is not an authored service seam and is intentionally not exported from
 * the public framework surface. It lets infrastructure created from a request
 * setup attach durable work to the Host rather than to the request caller.
 */
const HostScopeContext = createContext<Scope | undefined>("sweatpants-host-scope", undefined);

export function* installHostScope(scope: Scope): Operation<void> {
  yield* HostScopeContext.set(scope);
}

export function useHostScope(): Operation<Scope | undefined> {
  return HostScopeContext.get();
}
