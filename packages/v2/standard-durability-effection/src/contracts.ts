import type { Operation as NativeOperation } from "effection";
import type { Operation } from "@standard-durability/core";

/** The native Effection protocol yielded by portable computations. */
export type EffectionYield =
  NativeOperation<unknown> extends Operation<unknown, infer Y> ? Y : never;
