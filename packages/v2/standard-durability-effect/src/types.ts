import type { Scope } from "effect";
import type { Operation } from "@standard-durability/core";
import type { EffectYield } from "./contracts.ts";

export type Invoke = (...args: unknown[]) => Operation<unknown, EffectYield>;
export type Around = (args: unknown[], next: Invoke) => ReturnType<Invoke>;
export type Decoration = { at: "min" | "max"; methods: Record<string, Around | undefined> };
export interface Frame {
  readonly parent?: Frame;
  readonly scope: Scope.Scope;
  readonly values: Map<string, unknown>;
  readonly drivers: Map<string, Record<string, Invoke>>;
  readonly middleware: Map<string, Decoration[]>;
  closed: boolean;
}
