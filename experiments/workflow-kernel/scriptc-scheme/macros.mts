import { z } from "zod";
import { effects, macroBindings } from "./contract.mjs";

type Declaration = { readonly id: string; readonly context?: unknown; readonly response?: unknown };

// Deliberately bounded Zod profile, not a general Standard Schema compatibility
// prover. Reject refinements/transforms as well as different wire shapes.
export function assertDeclarationProfile(key: string, declaration: Declaration) {
  const plainString = (schema: unknown): schema is z.ZodString =>
    schema instanceof z.ZodString && !schema.def.coerce && !schema.def.checks?.length;
  const context = declaration.context;
  if (
    !(context instanceof z.ZodObject) ||
    context.def.checks?.length ||
    (context.def.catchall && !(context.def.catchall instanceof z.ZodNever)) ||
    Object.keys(context.shape).length !== 1 ||
    !plainString(context.shape.message) ||
    !plainString(declaration.response)
  ) {
    throw new Error(
      `Workflow admission: unsupported declaration profile for ${key}; expected plain { message: string } -> string`,
    );
  }
}

/** Guidance comes from the selected declarations, after profile validation. */
export function describeAuthoring(selected: Readonly<Record<string, Declaration>>) {
  return Object.entries(macroBindings).map(([method, bindings]) => ({
    method,
    result: method.endsWith("Value") ? "value-or-throw" : "outcome",
    syntax: `yield* ctx.${method}(key, request)`,
    bindings: bindings.map((key) => {
      const declaration = selected[key];
      if (!declaration) {
        throw new Error(`Workflow admission: undeclared effect ${key}`);
      }
      assertDeclarationProfile(key, declaration);
      return {
        key,
        effect: declaration.id,
        input: z.toJSONSchema(declaration.context as z.ZodObject),
        response: z.toJSONSchema(declaration.response as z.ZodString),
      };
    }),
  }));
}
export const authoringGuide = describeAuthoring(effects);

/** This bounded macro produces the existing effect exchange, never native JS. */
export function expandEffectMacro(
  method: string,
  key: string,
  inputExpression: string,
  selected: Readonly<Record<string, { readonly id: string }>>,
) {
  const allowed: readonly string[] = Object.hasOwn(macroBindings, method)
    ? macroBindings[method as keyof typeof macroBindings]
    : [];
  if (!allowed.includes(key) || !Object.hasOwn(selected, key)) {
    throw new Error(`Workflow admission: undeclared effect macro ${method}/${key}`);
  }
  const effect = selected[key].id;
  return {
    effect,
    unwrap: method.endsWith("Value"),
    source: `yield ["effect", ${JSON.stringify(effect)}, ${inputExpression}]`,
  };
}
