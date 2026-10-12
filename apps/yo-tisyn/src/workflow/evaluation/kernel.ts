// Build input for the compute VM. Only published kernel code enters this bundle.
// Authored programs enter later as JSON IR, never as JavaScript source.
import { evaluate, EMPTY_ENV } from "@tisyn/kernel";
import type { TisynExpr, Val } from "@tisyn/ir";

let kernel: ReturnType<typeof evaluate> | undefined;
export function open(ir: TisynExpr) {
  kernel = evaluate(ir, EMPTY_ENV);
}
export function advance(input?: Val) {
  if (!kernel) {
    throw new Error("Tisyn kernel is closed");
  }
  const step = input === undefined ? kernel.next() : kernel.next(input);
  // Do not let JSON transport turn Infinity/NaN into null or omit undefined.
  return JSON.stringify(step, (_key, value: unknown) => {
    if (
      value === undefined ||
      typeof value === "function" ||
      typeof value === "symbol" ||
      typeof value === "bigint" ||
      (typeof value === "number" && !Number.isFinite(value))
    ) {
      throw new Error("Tisyn evaluation returned a non-JSON value");
    }
    return value;
  });
}
