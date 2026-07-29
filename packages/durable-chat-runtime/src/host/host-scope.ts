import { all, createContext, type Operation, type Scope } from "effection";

/** Minimal supervision surface required by graceful Host shutdown. */
export interface HostOwnedWork {
  isDone(): boolean;
  waitForDone(): Operation<unknown>;
}

/** Explicit structural owner installed only by createChatApplication. */
export interface HostScopeOwner {
  readonly scope: Scope;
  /** Selects the long-lived composition scope after Host setup installs drivers. */
  adoptScope(scope: Scope): void;
  register(work: HostOwnedWork): void;
  drain(): Operation<void>;
}

/**
 * This is not an authored service seam and is intentionally not exported from
 * the public framework surface. It lets infrastructure created from a request
 * setup attach durable work to the Host rather than to the request caller.
 */
const HostScopeOwnerContext = createContext<HostScopeOwner | undefined>(
  "sweatpants-host-scope-owner",
  undefined,
);

export function createHostScopeOwner(rootScope: Scope): HostScopeOwner {
  const active = new Set<HostOwnedWork>();
  let structuralScope = rootScope;
  return {
    get scope() {
      return structuralScope;
    },
    adoptScope(scope) {
      structuralScope = scope;
    },
    register(work) {
      active.add(work);
      // The monitor is a child of the Host, just like the work. It bounds the
      // registry rather than retaining every completed Turn for Host lifetime.
      void structuralScope.run(function* () {
        try {
          yield* work.waitForDone();
        } finally {
          active.delete(work);
        }
      });
    },
    *drain(): Operation<void> {
      const pending = [...active].filter((work) => !work.isDone());
      if (pending.length > 0) {
        yield* all(pending.map((work) => work.waitForDone()));
      }
    },
  };
}

export function* installHostScopeOwner(owner: HostScopeOwner): Operation<void> {
  yield* HostScopeOwnerContext.set(owner);
}

export function useHostScopeOwner(): Operation<HostScopeOwner | undefined> {
  return HostScopeOwnerContext.get();
}
