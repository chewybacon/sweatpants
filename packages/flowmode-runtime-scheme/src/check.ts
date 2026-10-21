import type { Operation } from "effection";
import { encode, SchemeEvaluationPort, type SchemeProgram } from "./evaluation.ts";
import { schemeDiagnostic, type SchemeDiagnostic } from "./diagnostics.ts";

export const schemeChecks = {
  checked: ["syntax", "macro-expansion", "bindings", "known-call-arities", "input-serialization"],
  unchecked: ["runtime-data-shapes", "effect-requests", "termination"],
} as const;

export type SchemeCheck =
  | { valid: true; checks: typeof schemeChecks }
  | { valid: false; diagnostic: SchemeDiagnostic };

/** Checks a submission without executing it or issuing any host effects. */
export function* checkSchemeProgram(
  program: Pick<SchemeProgram, "source" | "input">,
): Operation<SchemeCheck> {
  try {
    encode(program.input ?? null);
  } catch (error) {
    // The author receives this failure as data, including the original diagnostic.
    return {
      valid: false,
      diagnostic: schemeDiagnostic(error instanceof Error ? error.message : String(error), "input"),
    };
  }
  const validation = yield* SchemeEvaluationPort.api.operations.validate(program.source);
  return validation.valid
    ? { valid: true, checks: schemeChecks }
    : { valid: false, diagnostic: schemeDiagnostic(validation.message, "validation") };
}
