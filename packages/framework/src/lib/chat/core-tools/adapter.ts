import type { Operation } from "effection";
import type { ZodSchema } from "zod";
import type { ToolDefinition } from "@sweatpants/core";

export type LegacyCoreToolFactory = {
  (...args: unknown[]): Operation<unknown>;
  decorate?: unknown;
  withContext?: unknown;
  readonly name: string;
  readonly description: string;
  readonly schemas: {
    readonly input: ZodSchema;
    readonly output?: ZodSchema;
    readonly progress?: ZodSchema;
  };
};

export type CoreToolFactory = ToolDefinition | LegacyCoreToolFactory;

export function isCoreToolFactory(value: unknown): value is CoreToolFactory {
  if (typeof value !== "function") {
    return false;
  }
  const fn = value as unknown as Record<string, unknown>;
  return (
    typeof fn["name"] === "string" &&
    typeof fn["description"] === "string" &&
    fn["schemas"] !== null &&
    typeof fn["schemas"] === "object" &&
    "input" in (fn["schemas"] as object) &&
    ((typeof fn["decorate"] === "function" && typeof fn["withContext"] === "function") ||
      ("parameters" in fn && "capabilities" in fn))
  );
}

export function adaptCoreTool<T extends CoreToolFactory>(coreToolFactory: T): T {
  return coreToolFactory;
}
