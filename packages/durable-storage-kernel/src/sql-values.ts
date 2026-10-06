import { DurableKernelError } from "./contract.ts";

type SqlNumber<T> = T extends number ? number | bigint | string : T;
export type SqlNumbers<T> = { [K in keyof T]: SqlNumber<T[K]> };

export function invalidStoredSqlValue(message: string): never {
  throw new DurableKernelError("durable_kernel_persisted_data_invalid", message);
}

export function sqlNatural(value: number | bigint | string, field: string): number {
  const result = Number(value);
  return Number.isSafeInteger(result) && result >= 0
    ? result
    : invalidStoredSqlValue(`${field} is outside the safe integer range`);
}

export function priorSqlPosition(first: string): string {
  return (BigInt(first) > 0n ? BigInt(first) - 1n : 0n).toString(10);
}

/** SQL integer columns share a signed 64-bit range; their driver representations differ. */
export function sqlCounter(value: string | bigint | number): bigint {
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new DurableKernelError(
      "durable_kernel_integer_out_of_range",
      `Unsafe durable counter returned by the backend driver: ${value}`,
    );
  }
  if (!/^\d+$/.test(String(value))) {
    throw new DurableKernelError(
      "durable_kernel_integer_out_of_range",
      `Invalid durable counter: ${value}`,
    );
  }
  const parsed = BigInt(value);
  if (parsed > 9_223_372_036_854_775_807n) {
    throw new DurableKernelError(
      "durable_kernel_integer_out_of_range",
      `Durable counter is outside the backend integer range: ${value}`,
    );
  }
  return parsed;
}
