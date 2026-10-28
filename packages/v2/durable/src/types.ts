import type { Outcome } from "@standard-durability/core";

/** Trusted assembly binding, deliberately excluded from cloned records. */
export interface ChildBinding {
  readonly program: string;
  readonly outcome: (value: unknown) => Outcome<unknown, unknown>;
}
