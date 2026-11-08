import type { GuestWork, Kernel, ScopedProgram, ScopeInstruction } from "./contracts.ts";
import { createScopedGuest } from "./scoped-guest.ts";

/** Replay-only kernel for scoped TypeScript bodies. Preparing and acquiring are lazy;
 * only Guest.start invokes the body. Each acquisition has independent logical scopes.
 * No serialization, sandbox, checkpoint format or native resource owner is implied. */
export function createScopedKernel<I, R, Q>(): Kernel<
  ScopedProgram<I, R, Q>,
  I,
  { readonly acquire: GuestWork<R, Exclude<Q, ScopeInstruction>, never> },
  never
> {
  return {
    *prepare(program, input) {
      return {
        *acquire() {
          return createScopedGuest((scope) => program(input, scope));
        },
      };
    },
  };
}
