import { randomUUID } from "node:crypto";
import { call, resource, type Operation } from "effection";
import { assertJson, type Json } from "@sweatpants/foundation";
import { definePort } from "@sweatpants/foundation/port";
type EvaluationStep =
  | { done: false; value: { id: string; data: Json } }
  | { done: true; value: Json };

export const limits = {
  source: 12000,
  bytes: 65536,
  depth: 32,
  nodes: 4096,
  stepFuel: 2_000_000n,
  totalFuel: 20_000_000n,
  effects: 256,
} as const;
export interface Procedure {
  call(...args: unknown[]): unknown[];
}
export type Machine = [Procedure, Procedure] & { fuel: WebAssembly.Global };
interface Vector {
  obj: object;
  reflector: {
    vector_length(value: unknown): number;
    vector_ref(value: unknown, index: number): unknown;
  };
}

function scalar(value: unknown): unknown {
  if (typeof value === "bigint") {
    const number = Number(value);
    if (!Number.isSafeInteger(number)) {
      throw new Error("Unsafe JSON integer");
    }
    return number;
  }
  if (value?.constructor?.name === "MutableString") {
    const string = value as { reflector: { string_value(value: unknown): string } };
    return string.reflector.string_value(value);
  }
  return value;
}

function bounded(value: Json): Json {
  if (new TextEncoder().encode(JSON.stringify(value)).length > limits.bytes) {
    throw new Error("JSON byte limit exceeded");
  }
  return value;
}

// Reflection objects are never exposed to the effect host or durable journal.
export function decode(value: unknown): Json {
  let nodes = 0;
  const seen = new Set<object>();
  function visit(raw: unknown, depth: number): Json {
    if (++nodes > limits.nodes || depth > limits.depth) {
      throw new Error("JSON shape limit exceeded");
    }
    const value = scalar(raw);
    if (typeof value === "string" || typeof value === "boolean") {
      return value;
    }
    if (
      typeof value === "number" &&
      Number.isFinite(value) &&
      (!Number.isInteger(value) || Number.isSafeInteger(value))
    ) {
      return value;
    }
    if (!["Vector", "MutableVector", "ImmutableVector"].includes(value?.constructor?.name ?? "")) {
      throw new Error("Expected JSON data from Scheme");
    }
    const vector = value as Vector;
    if (seen.has(vector.obj)) {
      throw new Error("Cyclic JSON data");
    }
    seen.add(vector.obj);
    try {
      const length = vector.reflector.vector_length(vector);
      if (length > limits.nodes) {
        throw new Error("JSON shape limit exceeded");
      }
      const at = (i: number) => vector.reflector.vector_ref(vector, i);
      const tag = scalar(at(0));
      if (tag === "null" && length === 1) {
        return null;
      }
      if (tag === "array") {
        return Array.from({ length: length - 1 }, (_, i) => visit(at(i + 1), depth + 1));
      }
      if (tag !== "object" || length % 2 !== 1) {
        throw new Error("Invalid JSON container");
      }
      const result: Record<string, Json> = {};
      for (let i = 1; i < length; i += 2) {
        const key = scalar(at(i));
        if (typeof key !== "string" || Object.hasOwn(result, key)) {
          throw new Error("Invalid JSON key");
        }
        Object.defineProperty(result, key, {
          value: visit(at(i + 1), depth + 1),
          enumerable: true,
        });
      }
      return result;
    } finally {
      seen.delete(vector.obj);
    }
  }
  return assertJson(bounded(visit(value, 0)));
}

function quote(value: string): string {
  return (
    '"' +
    [...value]
      .map((char) => {
        if (char === '"' || char === "\\") {
          return "\\" + char;
        }
        const point = char.codePointAt(0)!;
        if (point >= 0xd800 && point <= 0xdfff) {
          throw new Error("Unpaired Unicode surrogate");
        }
        return point < 32 || point === 127 ? `\\x${point.toString(16)};` : char;
      })
      .join("") +
    '"'
  );
}

export function encode(input: Json): string {
  bounded(assertJson(input));
  let nodes = 0;
  function visit(value: Json, depth: number): string {
    if (++nodes > limits.nodes || depth > limits.depth) {
      throw new Error("JSON shape limit exceeded");
    }
    if (value === null) {
      return '#("null")';
    }
    if (typeof value === "string") {
      return quote(value);
    }
    if (typeof value === "boolean") {
      return value ? "#t" : "#f";
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
        throw new Error("Unsafe JSON number");
      }
      return String(value);
    }
    if (Array.isArray(value)) {
      return `#("array" ${value.map((v) => visit(v, depth + 1)).join(" ")})`;
    }
    return `#("object" ${Object.entries(value)
      .map(([k, v]) => `${quote(k)} ${visit(v, depth + 1)}`)
      .join(" ")})`;
  }
  return visit(input, 0);
}

interface Driver {
  open(source: string): Operation<string>;
  advance(handle: string, input?: Json): Operation<EvaluationStep>;
  close(handle: string): Operation<void>;
}
const unavailable = function* (): Operation<never> {
  throw new Error("No Scheme driver installed");
};
export const SchemeEvaluationPort = definePort<Driver>("experimental-scheme-evaluation", {
  open: unavailable,
  advance: unavailable,
  close: unavailable,
});

export function createSchemeDriver(load: () => Promise<Machine>): Driver {
  const sessions = new Map<
    string,
    { machine: Machine; source: string; started: boolean; fuel: bigint; effects: number }
  >();
  return {
    *open(source) {
      if (source.length > limits.source) {
        throw new Error("Scheme source limit exceeded");
      }
      const machine = yield* call(load);
      const handle = randomUUID();
      sessions.set(handle, { machine, source, started: false, fuel: limits.totalFuel, effects: 0 });
      return handle;
    },
    *advance(handle, input) {
      const session = sessions.get(handle);
      if (!session) {
        throw new Error("Unknown or closed Scheme evaluation");
      }
      try {
        const budget = session.fuel < limits.stepFuel ? session.fuel : limits.stepFuel;
        session.machine.fuel.value = budget;
        let values: unknown[];
        try {
          if (!session.started) {
            if (input !== undefined) {
              throw new Error("Initial next takes no input");
            }
            session.started = true;
            values = session.machine[0].call(session.source);
          } else {
            if (input === undefined) {
              throw new Error("Effect response required");
            }
            values = session.machine[1].call(encode(input));
          }
        } finally {
          session.fuel -= budget - BigInt(session.machine.fuel.value);
        }
        const kind = scalar(values[0]);
        if (kind === "done" && values.length === 2) {
          const value = decode(values[1]);
          sessions.delete(handle);
          return { done: true, value };
        }
        if (kind !== "effect" || values.length !== 3) {
          throw new Error("Invalid Scheme step");
        }
        if (++session.effects > limits.effects) {
          throw new Error("Scheme effect limit exceeded");
        }
        const id = scalar(values[1]);
        if (id !== "ask" && id !== "random") {
          throw new Error("Unknown Scheme effect");
        }
        return { done: false, value: { id, data: decode(values[2]) } };
      } catch (error) {
        sessions.delete(handle);
        if (BigInt(session.machine.fuel.value) < 0n) {
          throw new Error("Scheme fuel exhausted", { cause: error });
        }
        throw error;
      }
    },
    *close(handle) {
      sessions.delete(handle);
    },
  };
}

export function createSchemeEvaluation(source: string) {
  return resource<{ next(input?: Json): Operation<EvaluationStep> }>(function* (provide) {
    const handle = yield* SchemeEvaluationPort.api.operations.open(source);
    try {
      yield* provide({
        *next(input) {
          return yield* SchemeEvaluationPort.api.operations.advance(handle, input);
        },
      });
    } finally {
      yield* SchemeEvaluationPort.api.operations.close(handle);
    }
  });
}
