import type { Json } from "@sweatpants/foundation";
import type { WorkflowBoundary } from "@sweatpants/flowmode-runtime";
import { inspectSnapshot } from "./inspect.mts";
import { encodeValue, decodeValue } from "@sweatpants/flowmode-compiler/scheme-data/values";

export type HootProcedureList = { call(...args: unknown[]): unknown[] }[];
export type HootProcedures = HootProcedureList & { fuel: WebAssembly.Global };
export type HootMachine = ReturnType<typeof machineApi>;
export interface HootBoundary {
  kind: string;
  site: string;
  value: Json;
}

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
function stringValue(value: unknown): string {
  if (typeof value !== "string") {
    throw Error("Expected Hoot string result");
  }
  return value;
}

export function machineApi(procedures: HootProcedures) {
  function call(index: number, ...args: unknown[]) {
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
  function boundary(values: unknown[]): HootBoundary {
    const [kind, site, data] = values;
    return {
      kind: stringValue(kind),
      site: stringValue(site),
      value: decodeValue(stringValue(data)),
    };
  }
  return {
    validate: (source: string) => stringValue(call(7, source)[0]),
    start: (source: string, input: Json = null) => boundary(call(0, source, encodeValue(input))),
    resume: (value: Json) => boundary(call(1, encodeValue(value))),
    reject: (error: Json) => boundary(call(5, encodeValue(error))),
    cancel: () => boundary(call(2)),
    capture: () => stringValue(call(3)[0]),
    inspect: (boundary: WorkflowBoundary) => inspectSnapshot(stringValue(call(3)[0]), boundary),
    restore: (source: string, snapshot: string) => boundary(call(4, source, snapshot)),
  };
}
