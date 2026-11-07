import { verifyWorkflowModule } from "../../../packages/v2/codemode-compiler/src/index.ts";
import { createHash } from "node:crypto";
import {
  parse,
  symbolName,
} from "../../../packages/v2/codemode-runtime-scheme/src/scheme-data/read.ts";

const identifier = /^[A-Za-z_][A-Za-z0-9_?!-]*$/;
const forbidden = new Set([
  "quote",
  "yield-at",
  "ensure",
  "scope",
  "set!",
  "workflow-return",
  "workflow-throw",
  "try-finally",
  "while",
  "break",
  "continue",
  "registered-program",
]);
const reserved = new Set([
  "root",
  ...forbidden,
  "define",
  "lambda",
  "let",
  "let*",
  "if",
  "begin",
  "block",
  "list",
  "object",
  "not",
  "truthy",
  "js-add",
  "string-append",
  "equal?",
  "json-field",
]);
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

/** Bounded authored syntax shared by the linked and sampling experiments. */
export function admitLinkedCaller(caller) {
  if (caller.length > 12000) {
    throw new Error("Caller exceeds experimental source limit");
  }
  // Validate spelling before the datum reader converts numbers to JavaScript values.
  // This bounded caller profile admits only safe integer literals; exact fractions,
  // decimal/exponent forms and unsafe integers must not silently change semantics.
  for (const token of caller.match(/;[^\n]*|"(?:\\.|[^"\\])*"|[()]|[^\s()]+/g) ?? []) {
    if (
      token.startsWith(";") ||
      token.startsWith('"') ||
      ["(", ")", "#t", "#f", "%input"].includes(token) ||
      identifier.test(token)
    ) {
      continue;
    }
    if (
      !/^[+-]?\d+$/.test(token) ||
      !Number.isSafeInteger(Number(token)) ||
      Object.is(Number(token), -0)
    ) {
      throw new Error("Unsupported caller literal: use safe integer literals");
    }
  }
  const forms = parse(caller);
  // Reject internal instructions even when nested in caller procedures. Serialize
  // parsed forms so caller text cannot escape the host-owned registration envelope.
  function check(form) {
    if (Array.isArray(form)) {
      if (forbidden.has(symbolName(form[0]))) {
        throw new Error("Unsupported authored caller form");
      }
      form.forEach(check);
    } else if (
      form &&
      typeof form === "object" &&
      !identifier.test(form.sym) &&
      form.sym !== "%input"
    ) {
      throw new Error("Unsupported caller identifier");
    }
  }
  forms.forEach(check);
  if (!forms.length) {
    throw new Error("Empty caller");
  }
  return forms.map(print).join("\n");
}

/** One trusted compiler module, one public entry. Not a general linker or verifier.
 * The caller is untrusted; compiled IR and grants are trusted assembly inputs. */
export function linkReview({ module, caller, name = "review_draft", identity }) {
  verifyWorkflowModule(module);
  if (
    module.format !== "workflow-scheme/1" ||
    module.entry.parameters !== "input" ||
    !identifier.test(name) ||
    reserved.has(name) ||
    !identifier.test(module.entry.name)
  ) {
    throw new Error("Unsupported linked workflow profile");
  }
  const definitions = parse(module.sexpressions);
  const privateNames = new Set();
  for (const definition of definitions) {
    if (
      !Array.isArray(definition) ||
      symbolName(definition[0]) !== "define" ||
      !Array.isArray(definition[1]) ||
      !identifier.test(symbolName(definition[1][0]) ?? "")
    ) {
      throw new Error("Compiled module must contain function definitions");
    }
    const key = symbolName(definition[1][0]);
    if (key === module.entry.name && definition[1].length !== 2) {
      throw new Error("Compiled entry must accept exactly one input");
    }
    if (privateNames.has(key)) {
      throw new Error("Duplicate compiled definition");
    }
    privateNames.add(key);
  }
  if (!privateNames.has(module.entry.name) || privateNames.has(name)) {
    throw new Error("Missing or colliding compiled entry");
  }
  const admittedCaller = admitLinkedCaller(caller);
  const source = `(registered-program\n(${module.sexpressions})\n(${`(${name} compiled ${module.entry.name} ())`})\n(${admittedCaller}))`;
  // Pin executable, evaluator and effect/source mapping together. This is not a grant.
  const digest = createHash("sha256")
    .update(JSON.stringify({ source, identity, effects: module.effects }))
    .digest("hex");
  return Object.freeze({
    source,
    language: "scheme",
    program: `linked-review:${digest}`,
    identity,
    name,
    entry: module.entry.name,
    effects: Object.freeze(
      Object.fromEntries(
        Object.entries(module.effects).map(([site, effect]) => [
          site,
          Object.freeze({ ...effect, source: Object.freeze({ ...effect.source }) }),
        ]),
      ),
    ),
  });
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

/** Common linker contract; this adapter retains the bounded Scheme caller profile. */
export const schemeWorkflowLinker = {
  language: "scheme",
  link({ module, caller, name, identity }) {
    if (caller.language !== "scheme") {
      throw new Error("Expected Scheme caller");
    }
    return linkReview({ module, caller: caller.text, name, identity });
  },
};
