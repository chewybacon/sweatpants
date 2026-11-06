import type { Kernel } from "@sweatpan.ts/execution";
import type { Runtime } from "@sweatpan.ts/runtime";
import type { SchemeEvaluator, SchemeEvaluatorOptions } from "./contracts.ts";
import { createSchemeEvaluator } from "./evaluator.ts";
export function createSchemeKernel<R, Q, Y>(
  runtime: Runtime<Y>,
  options: Omit<SchemeEvaluatorOptions<R, Q>, "source" | "input">,
): Kernel<string, unknown, SchemeEvaluator<R, Q, Y>, Y> {
  return {
    *prepare(source, input) {
      return createSchemeEvaluator(runtime, { ...options, source, input });
    },
  };
}
