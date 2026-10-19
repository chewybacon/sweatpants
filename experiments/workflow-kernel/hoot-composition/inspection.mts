import type {
  ExecutionInspection,
  InspectedUnwind,
  InspectedValue,
  KernelBoundary,
  PendingCompletion,
} from "../../../packages/workflow-kernel/src/index.ts";

function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw Error("Expected Hoot inspection list");
  }
  return value;
}
function symbol(value: unknown): string {
  if (!value || typeof value !== "object" || !("sym" in value) || typeof value.sym !== "string") {
    throw Error("Expected Hoot inspection symbol");
  }
  return value.sym;
}
function environmentId(value: unknown): string {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw Error("Invalid Hoot environment identity");
  }
  return String(value);
}

/** Projects trusted evaluator data; does not validate or authorize a checkpoint. */
export function projectHootInspection(
  state: unknown,
  boundary: KernelBoundary,
): ExecutionInspection {
  const fields = list(state);
  if (symbol(fields[0]) !== "workflow-state-v3") {
    throw Error("Unknown inspection format");
  }
  let truncated = false;
  // Bound the projection independently of how much state the evaluator retains.
  let entries = 2_000;
  function take(values: unknown[]): unknown[] {
    const length = Math.min(entries, values.length);
    entries -= length;
    if (length !== values.length) {
      truncated = true;
    }
    return values.slice(0, length);
  }
  function value(input: unknown): InspectedValue {
    if (
      Array.isArray(input) &&
      input[0] &&
      typeof input[0] === "object" &&
      !Array.isArray(input[0])
    ) {
      const tag = symbol(input[0]);
      if (tag === "closure") {
        return { kind: "closure", name: symbol(input[4]), environmentId: environmentId(input[3]) };
      }
      if (tag === "tool" || tag === "primitive") {
        return { kind: "callable", name: symbol(input[1]) };
      }
    }
    let shortened = false;
    let budget = 2_000;
    function text(s: string): string {
      const part = s.slice(0, budget);
      if (part.length !== s.length) {
        shortened = true;
      }
      budget -= part.length;
      return part;
    }
    function display(item: unknown, depth: number): string {
      if (budget === 0 || depth > 16) {
        shortened = true;
        return "";
      }
      if (Array.isArray(item)) {
        let out = text("(");
        for (let i = 0; i < item.length; i++) {
          if (budget === 0) {
            shortened = true;
            break;
          }
          if (i) {
            out += text(" ");
          }
          out += display(item[i], depth + 1);
        }
        return out + text(")");
      }
      if (item && typeof item === "object") {
        return text(symbol(item));
      }
      return text(JSON.stringify(item) ?? "undefined");
    }
    const rendered = display(input, 0);
    truncated ||= shortened;
    return { kind: "display", text: rendered, truncated: shortened };
  }
  function completion(kind: unknown, result: unknown): PendingCompletion {
    switch (symbol(kind)) {
      case "normal":
        return { kind: "normal", value: value(result) };
      case "returned":
        return { kind: "return", value: value(result) };
      case "thrown":
        return { kind: "throw", value: value(result) };
      case "cancelled":
        return { kind: "cancel" };
      case "break":
        return { kind: "break" };
      case "continue":
        return { kind: "continue" };
      default:
        throw Error("Unknown Hoot completion");
    }
  }
  const frames = take(list(fields[4])).map(list);
  const calls = frames
    .flatMap((frame, index) =>
      symbol(frame[0]) === "call" ? [{ id: String(index), name: symbol(frame[1]) }] : [],
    )
    // oxlint-disable-next-line unicorn/no-array-reverse -- This newly allocated view array supports ES2022 app consumers.
    .reverse();
  const unwind = frames.flatMap((frame): InspectedUnwind[] => {
    switch (symbol(frame[0])) {
      case "scope":
        return [
          {
            kind: "scope",
            label: typeof frame[1] === "string" ? frame[1] : symbol(frame[1]),
            pendingCleanup: take(list(frame[2])).map(value),
          },
        ];
      case "cleanup":
        return [
          {
            kind: "cleanup",
            remaining: take(list(frame[1])).map(value),
            completion: completion(frame[2], frame[3]),
          },
        ];
      case "after-finally":
        return [{ kind: "finally", completion: completion(frame[1], frame[2]) }];
      default:
        return [];
    }
  });
  const environments = take(list(fields[2])).map((entry) => {
    const [id, parent, bindings] = list(entry);
    return {
      id: environmentId(id),
      parentId: parent === false ? null : environmentId(parent),
      bindings: take(list(bindings)).map((binding) => {
        const [name, ...rest] = list(binding);
        const dotted =
          rest[0] &&
          typeof rest[0] === "object" &&
          !Array.isArray(rest[0]) &&
          symbol(rest[0]) === ".";
        return { name: symbol(name), value: value(dotted ? rest[1] : rest) };
      }),
    };
  });
  const observedBoundary =
    boundary.kind === "suspended"
      ? { kind: boundary.kind, request: structuredClone(boundary.request) }
      : structuredClone(boundary);
  return { boundary: observedBoundary, calls, environments, unwind, truncated };
}
