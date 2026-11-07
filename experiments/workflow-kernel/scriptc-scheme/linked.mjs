import {
  parse,
  symbolName,
} from "../../../packages/v2/codemode-runtime-scheme/src/scheme-data/read.ts";
import { schemeWorkflowLinker } from "@sweatpan.ts/codemode-compiler-scheme/link";
export { schemeWorkflowLinker };
export { admitSchemeCaller as admitLinkedCaller } from "@sweatpan.ts/codemode-compiler-scheme";
export function linkReview({ module, caller, name = "review_draft", identity }) {
  return schemeWorkflowLinker.link({
    module,
    caller: { language: "scheme", text: caller },
    name,
    identity,
  });
}
function print(value) {
  if (Array.isArray(value)) {
    return `(${value.map(print).join(" ")})`;
  }
  if (typeof value === "object") {
    return value.sym;
  }
  if (typeof value === "boolean") {
    return value ? "#t" : "#f";
  }
  return JSON.stringify(value);
}

/** Read-only view of trusted captured state, never recovery authorization.
 * Assembly distinguishes journal checkpoints from diagnostic captures made during
 * cancellation, when existing recovery deliberately uses replay instead.
 * No VM is loaded and no expression is evaluated. Values are diagnostic strings. */
export function inspectLinkedCheckpoint(artifact, capture) {
  if (!capture || capture.program !== artifact.program) {
    throw new Error("Inspection program does not match linked artifact");
  }
  const checkpoint = capture.state;
  if (
    !checkpoint ||
    checkpoint.identity !== artifact.identity ||
    checkpoint.source !== artifact.source ||
    typeof checkpoint.state !== "string"
  ) {
    throw new Error("Inspection checkpoint does not match linked artifact");
  }
  const state = parse(checkpoint.state)[0];
  if (
    !Array.isArray(state) ||
    symbolName(state[0]) !== "workflow-state-v3" ||
    state[1] !== artifact.source ||
    !Array.isArray(state[4]) ||
    !Array.isArray(state[8])
  ) {
    throw new Error("Unsupported suspended inspection state");
  }
  const site = state[8][0];
  const declaration = artifact.effects[site];
  if (!declaration) {
    throw new Error("Unknown linked effect site");
  }
  const frames = state[4];
  const calls = [];
  let compiled = false;
  let entryFrame = false;
  // The evaluator pushes a registered-call scope before entering private code.
  // Walk from caller to callee: names alone cannot establish provenance.
  for (const frame of frames.slice().reverse()) {
    if (symbolName(frame[0]) === "scope" && symbolName(frame[1]) === artifact.name) {
      compiled = true;
      entryFrame = true;
    } else if (symbolName(frame[0]) === "call") {
      calls.push({
        name: entryFrame ? artifact.name : symbolName(frame[1]),
        kind: compiled ? "compiled" : "caller",
      });
      entryFrame = false;
    }
  }
  const cleanup = frames
    .filter((frame) => ["cleanup", "after-finally"].includes(symbolName(frame[0])))
    .map((frame) => ({
      kind: symbolName(frame[0]),
      completion: symbolName(frame[symbolName(frame[0]) === "cleanup" ? 2 : 1]),
    }));
  // Bound presentation only; this trusted-snapshot reader is not an untrusted-data sandbox.
  function displayBinding(binding) {
    const rest = binding.slice(1);
    const value = symbolName(rest[0]) === "." ? rest[1] : rest;
    const tag = Array.isArray(value) ? symbolName(value[0]) : undefined;
    if (tag === "closure") {
      return `<closure ${symbolName(value[4])}>`;
    }
    if (tag === "tool" || tag === "primitive") {
      return `<${tag} ${symbolName(value[1])}>`;
    }
    return print(value);
  }
  let truncated = calls.length > 64 || cleanup.length > 64 || state[2].length > 64;
  const environments = state[2].slice(0, 64).map(([id, parent, bindings]) => {
    truncated ||= bindings.length > 64;
    return {
      id,
      parent,
      bindings: bindings.slice(0, 64).map((binding) => {
        const value = displayBinding(binding);
        truncated ||= value.length > 256;
        return { name: symbolName(binding[0]), value: value.slice(0, 256) };
      }),
    };
  });
  return {
    site,
    effect: declaration.effect,
    key: declaration.key,
    source: structuredClone(declaration.source),
    calls: calls.slice(0, 64),
    cleanup: cleanup.slice(0, 64),
    environments,
    steps: state[10],
    cancellationRequested: state[11],
    truncated,
  };
}
