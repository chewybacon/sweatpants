import { createContext, type Operation } from "effection";

import { CrankError, type CrankStore } from "./types.ts";

export const CrankStoreContext = createContext<CrankStore | undefined>(
  "session-contract:crank-store",
  undefined,
);

export function* useCrankStore(): Operation<CrankStore> {
  const store = yield* CrankStoreContext.get();
  if (!store) throw new CrankError("unknown_target", "No crank store is bound in scope");
  return store;
}

export function* useOptionalCrankStore(): Operation<CrankStore | undefined> {
  return yield* CrankStoreContext.get();
}
