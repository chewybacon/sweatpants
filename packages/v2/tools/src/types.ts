// Internal types shared by implementation modules; not part of the public API.
import type { Operation, Outcome } from "@standard-durability/core";
import type { ElicitHandlerContext, ElicitHandlerInput } from "./contracts.ts";

/** Per-key correlation is erased only after resolving that same key's declaration. */
export type ResolvedElicitHandler<C, Y> = (
  args: ElicitHandlerInput<unknown>,
  ctx: ElicitHandlerContext<C>,
) => Operation<Outcome<unknown, unknown>, Y>;
