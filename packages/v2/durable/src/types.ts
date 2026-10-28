import type { Outcome } from "@standard-durability/core";

/** Trusted assembly binding, deliberately excluded from cloned records. */
export interface ChildBinding {
  readonly program: string;
  readonly outcome: (value: unknown) => Outcome<unknown, unknown>;
}

/** Transaction overlay for code bindings; publication does not copy historical bindings. */
export interface ChildBindings {
  get(id: string): ChildBinding | undefined;
  has(id: string): boolean;
  set(id: string, binding: ChildBinding): void;
}
