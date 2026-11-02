/** Framework-only compiler/adapter boundary. Not exported from authoring entrypoints. */
import { ToolDefinition } from "./definition.ts";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { ElicitsMap } from "./types.ts";
import type { Effects, JournalRequest } from "./journal-compiler.ts";
import type { Handler, IterableOperation } from "@sweatpants/foundation/computation";
import type { Operation } from "effection";

interface Implementation<Result> {
  invoke(input: unknown, callId: string): IterableOperation<Result, JournalRequest>;
  invokeWith<Y>(
    input: unknown,
    callId: string,
    dispatch: Handler<JournalRequest, Y>,
  ): IterableOperation<Result, Y>;
}
const implementations = new WeakMap<object, Implementation<unknown>>();

class CompiledDefinition<
  P extends StandardSchemaV1,
  R,
  L extends ElicitsMap,
  E extends Effects,
  N extends string,
> extends ToolDefinition<P, R, L, E, N> {}

export function compileDefinition<
  P extends StandardSchemaV1,
  R,
  L extends ElicitsMap,
  E extends Effects,
  N extends string,
>(
  metadata: Omit<ToolDefinition<P, R, L, E, N>, never>,
  implementation: Implementation<R>,
): ToolDefinition<P, R, L, E, N> {
  const tool = Object.assign(new CompiledDefinition<P, R, L, E, N>(), metadata);
  implementations.set(tool, implementation);
  Object.freeze(tool);
  return tool;
}

export function isIteratorTool<
  P extends StandardSchemaV1,
  R,
  L extends ElicitsMap,
  E extends Effects,
  N extends string,
>(value: ToolDefinition<P, R, L, E, N>): boolean;
export function isIteratorTool(value: unknown): value is ToolDefinition;
export function isIteratorTool(value: unknown): boolean {
  return typeof value === "object" && value !== null && implementations.has(value);
}

export function toolImplementation<P extends StandardSchemaV1, R>(
  tool: ToolDefinition<P, R>,
): Implementation<R> {
  const implementation = implementations.get(tool);
  if (!implementation) {
    throw new Error(`Tool "${tool.name}" requires its native context adapter`);
  }
  // Only compileDefinition registers entries, with the same R as its definition.
  // This private association never travels through a Json registry or transport.
  return implementation as Implementation<R>;
}

/** Retained callable-factory capability; canonical authoring does not expose it. */
export function toolFactory<P extends StandardSchemaV1, R>(tool: ToolDefinition<P, R, any, any>) {
  if (typeof tool !== "function") {
    throw new Error(`Tool "${tool.name}" requires iterator placement`);
  }
  return tool as unknown as (context: unknown) => Operation<(input: unknown) => Operation<R>>;
}
