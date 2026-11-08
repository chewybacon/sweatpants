import type { SchemeBoundary, SchemeMachine } from "./contracts.ts";
import { encodeValue, decodeValue } from "./scheme-data/values.ts";
import { parse, symbolName } from "./scheme-data/read.ts";

export type HootProcedures = { call(...args: unknown[]): unknown[] }[] & {
  fuel: { value: bigint };
};
function reflectedValue(value: unknown): unknown {
  if (value && typeof value === "object" && "reflector" in value) {
    const reflector = value.reflector;
    if (
      reflector &&
      typeof reflector === "object" &&
      "string_value" in reflector &&
      typeof reflector.string_value === "function"
    ) {
      return reflector.string_value(value);
    }
  }
  return value;
}
function text(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Expected Hoot string result");
  }
  return value;
}
/** Protocol adapter for the pinned Execution evaluator. No legacy host or debugger. */
export function createSchemeMachine(procedures: HootProcedures | undefined): SchemeMachine {
  function call(index: number, ...args: unknown[]): unknown[] {
    if (!procedures) {
      throw new Error("Scheme machine closed");
    }
    procedures.fuel.value = 100_000_000n;
    try {
      return procedures[index]!.call(...args).map(reflectedValue);
    } catch (cause) {
      procedures.fuel.value = 100_000_000n;
      const diagnostic = reflectedValue(procedures[6]!.call()[0]);
      throw new Error(
        typeof diagnostic === "string" && diagnostic ? diagnostic : "Workflow evaluator failed",
        { cause },
      );
    }
  }
  function capture() {
    return text(call(3)[0]);
  }
  function boundary(values: unknown[]): SchemeBoundary {
    const [kind, site, data] = values;
    const value = decodeValue(text(data));
    if (kind === "returned" || kind === "thrown") {
      return { kind, value };
    }
    if (kind === "cancelled") {
      return { kind };
    }
    if (kind !== "effect") {
      throw new Error("Unknown Scheme boundary");
    }
    // Evaluator-owned, validated live state; mirrors its cleaning? predicate.
    const state = parse(capture())[0];
    if (
      !Array.isArray(state) ||
      symbolName(state[0]) !== "workflow-state-v3" ||
      !Array.isArray(state[4])
    ) {
      throw new Error("Unsupported Scheme state");
    }
    const cleanup = state[4].some(
      (frame) =>
        Array.isArray(frame) && ["cleanup", "after-finally"].includes(symbolName(frame[0]) ?? ""),
    );
    return {
      kind,
      site: text(site),
      value,
      scope: {
        scopeId: "scheme:root",
        frameId: cleanup ? "scheme:cleanup" : "scheme:body",
        phase: cleanup ? "cleanup" : "body",
      },
    };
  }
  return {
    start: (source, input) => boundary(call(0, source, encodeValue(input))),
    resume: (value) => boundary(call(1, encodeValue(value))),
    reject: (error) => boundary(call(5, encodeValue(error))),
    cancel: () => boundary(call(2)),
    capture,
    restore: (source, state) => boundary(call(4, source, state)),
    close: () => {
      procedures = undefined;
    },
  };
}
