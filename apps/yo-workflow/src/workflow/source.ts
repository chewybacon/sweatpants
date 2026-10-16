import { expandRandomSyntax, lowerRandomSyntax } from "./random.ts";
import { expandExchangeSyntax, lowerExchangeSyntax } from "./exchange-syntax.ts";
import { expandCollectionSyntax, lowerCollectionSyntax } from "./collection-syntax.ts";
import { expandJsonSyntax, lowerJsonSyntax } from "./json-values.ts";
import { validateAuthoring } from "./author-validation.ts";
import { parseDSL } from "@tisyn/dsl";
import { validateIr } from "@tisyn/validate";
import type { TisynExpr } from "@tisyn/ir";
import { expandDecisionSyntax, lowerDecisionSyntax } from "./decision-syntax.ts";
import { expandMacroSyntax, lowerMacroSyntax } from "./macro-syntax.ts";

export const MAX_SOURCE_LENGTH = 12_000;

/** Bounds parser input before recursive descent. This is not a security sandbox. */
function checkSource(source: string): void {
  if (source.length > MAX_SOURCE_LENGTH) {
    throw new Error("Tisyn source exceeds 12000 characters");
  }
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (const char of source) {
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = "";
      }
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if ("([{".includes(char)) {
      if (++depth > 48) {
        throw new Error("Tisyn source nesting exceeds 48 levels");
      }
    } else if (")]}".includes(char)) {
      depth--;
    }
  }
}

/** Authoring structure before capability sugar is lowered; never execute this tree. */
export function parseTisynAuthoring(source: string): TisynExpr {
  checkSource(source);
  const expanded = expandCollectionSyntax(
    expandJsonSyntax(
      expandDecisionSyntax(expandMacroSyntax(expandExchangeSyntax(expandRandomSyntax(source)))),
    ),
  );
  return lowerMacroSyntax(parseDSL(expanded));
}

export function parseTisynSource(source: string): TisynExpr {
  const macros = parseTisynAuthoring(source);
  const exchanges = lowerExchangeSyntax(macros);
  const collections = lowerCollectionSyntax(exchanges);
  const ir = lowerRandomSyntax(lowerJsonSyntax(lowerDecisionSyntax(collections)));
  const validated = validateIr(ir);
  if (!validated.ok) {
    throw new Error(`Invalid Tisyn IR: ${JSON.stringify(validated.errors)}`);
  }
  validateAuthoring(ir);
  return ir;
}
