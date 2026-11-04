import type { Scope } from "effect";
import type { Operation } from "@standard-durability/core";
import type { RawDecorator, RawDefinition } from "@standard-durability/core/internal";
import type { EffectYield } from "./contracts.ts";

export type Invoke = (...args: unknown[]) => Operation<unknown, EffectYield>;
export type Decoration = {
  at: "min" | "max";
  operations: Record<string, RawDecorator | undefined>;
  sync: Record<string, RawDecorator | undefined>;
};
export interface Frame {
  readonly parent?: Frame;
  readonly scope: Scope.Scope;
  readonly values: Map<string, unknown>;
  readonly drivers: Map<string, RawDefinition>;
  readonly middleware: Map<string, Decoration[]>;
  closed: boolean;
}
