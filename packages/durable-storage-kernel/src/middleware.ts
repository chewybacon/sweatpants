import { composeOperation, type OperationOptions } from "@sweatpants/foundation";
import type { DurableKernel } from "./contract.ts";

export type DurableKernelOptions = OperationOptions<DurableKernel>;

/** Decorate physical storage operations; transaction correctness remains driver-owned. */
export function createDurableKernel({
  driver,
  middleware = [],
}: DurableKernelOptions): DurableKernel {
  return {
    readAuthority: composeOperation(
      (collection, key) => driver.readAuthority(collection, key),
      middleware.map((m) => m.readAuthority),
    ),
    readImmutable: composeOperation(
      (collection, key) => driver.readImmutable(collection, key),
      middleware.map((m) => m.readImmutable),
    ),
    scan: composeOperation(
      (request) => driver.scan(request),
      middleware.map((m) => m.scan),
    ),
    waitForChange: composeOperation(
      (request) => driver.waitForChange(request),
      middleware.map((m) => m.waitForChange),
    ),
    apply: composeOperation(
      (mutation) => driver.apply(mutation),
      middleware.map((m) => m.apply),
    ),
  };
}
