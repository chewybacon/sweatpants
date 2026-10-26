import type {
  Composition,
  Middleware,
  Operations,
  Outcome,
  Work,
} from "@sweatpants/standard-durability";
import { assertJson, type Json } from "@sweatpants/foundation";
import {
  JournalEffectDeclarationError,
  validateJournalValue,
  type JournalRequest,
  type JournalTool,
} from "./journal-compiler.ts";

type EffectRequest = Extract<JournalRequest, { kind: "effect" }>;
export interface ToolEffectSignature {
  effect(request: EffectRequest): Outcome<Json, Json>;
}

/** Declaration-bound validation, using the compiler's single schema parser. */
export function toolEffectValidation<Y>(
  tools: readonly Pick<JournalTool, "name" | "effects">[],
): Middleware<ToolEffectSignature, Y> {
  return {
    *effect([request], next) {
      const tool = tools.find((entry) => entry.name === request.tool);
      const declaration = tool?.effects[request.key];
      if (!declaration || declaration.version !== request.version) {
        throw new JournalEffectDeclarationError();
      }
      const input = assertJson(validateJournalValue(declaration.input, request.input));
      const outcome = yield* next({ ...request, input });
      if (outcome.ok) {
        assertJson(validateJournalValue(declaration.output, assertJson(outcome.value)));
      }
      return outcome;
    },
  };
}

let bindingId = 0;
/** An activation owns this private API and its native child scope. No guest execution. */
export function createToolEffects<Y>(composition: Composition<Y>) {
  // API adapters use names as binding identity. Independent activations must never
  // inherit another activation's validators/drivers, even when nested.
  const Effects = composition.createApi<ToolEffectSignature>(`tool-effects:${++bindingId}`, {
    *effect() {
      throw new Error("Tool effect handler not installed");
    },
  });
  return {
    operations: Effects.operations,
    withEffects<T>(
      tools: readonly JournalTool[],
      native: Operations<ToolEffectSignature, Y>,
      work: Work<T, Y>,
      middleware: readonly Middleware<ToolEffectSignature, Y>[] = [],
    ) {
      return composition.scoped(function* () {
        yield* Effects.install(native);
        // First max is outermost. Custom wrappers see canonical input and return
        // raw output. Validation surrounds all of them, including short circuits.
        yield* Effects.around(toolEffectValidation<Y>(tools), { at: "max" });
        for (const layer of middleware) {
          yield* Effects.around(layer, { at: "max" });
        }
        return yield* work();
      });
    },
  };
}
