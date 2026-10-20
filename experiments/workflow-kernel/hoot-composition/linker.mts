import { encodeValue } from "../../../packages/flowmode-compiler/src/scheme-data/values.mjs";
import type {
  WorkflowImplementation,
  WorkflowLinker,
} from "../../../packages/flowmode-runtime/src/index.ts";
import { parse } from "../../../packages/flowmode-compiler/src/scheme-data/read.mjs";
import {
  assertWorkflowLink,
  createWorkflowLinker,
} from "../../../packages/flowmode-runtime/dist/index.js";

export const HOOT_DEFINITION_FORMAT = "workflow-scheme-definitions-v1";
export const HOOT_PROGRAM_FORMAT = "workflow-scheme-spike-1";

function name(value: string): string {
  // Public registrations and compiled entries occupy ordinary Scheme symbol positions.
  if (!/^[A-Za-z_][A-Za-z0-9_?!-]*$/.test(value)) {
    throw Error("Invalid workflow binding name");
  }
  return value;
}

/** Hoot's definition format and registration syntax are owned by this adapter. */
export const hootLinker: WorkflowLinker = createWorkflowLinker({
  driver: {
    definitionFormat: HOOT_DEFINITION_FORMAT,
    programFormat: HOOT_PROGRAM_FORMAT,
    *link(input) {
      return linkHootProgram(input);
    },
  },
});

/** Pure target transform; no worker, scope, or effect dispatch. */
function linkHootProgram({
  caller,
  bindings,
}: Parameters<WorkflowLinker["link"]>[0]): WorkflowImplementation {
  if (
    caller.source.language !== "scheme" ||
    caller.implementation.format !== HOOT_DEFINITION_FORMAT ||
    typeof caller.implementation.payload !== "string"
  ) {
    throw Error("Hoot linker requires Scheme caller source");
  }
  assertWorkflowLink(caller, bindings);
  const publicNames = new Set<string>();
  const implementations = new Set<string>();
  const privateNames = new Set<string>();
  const registrations: string[] = [];
  for (const binding of bindings) {
    const publicName = name(binding.contract.name);
    if (publicNames.has(publicName)) {
      throw Error(`Duplicate workflow binding: ${publicName}`);
    }
    publicNames.add(publicName);
    if (binding.kind === "host") {
      if (binding.capability.name === "elicit") {
        continue;
      }
      if (
        binding.contract.name !== binding.capability.name ||
        binding.contract.id !==
          JSON.stringify(["effect", binding.capability.name, binding.capability.version])
      ) {
        throw Error("Incompatible Hoot host binding identity");
      }
      // The current evaluator emits version 1 for registered host calls.
      if (binding.capability.version !== "1") {
        throw Error("Hoot host binding requires version 1");
      }
      registrations.push(`(${publicName} host)`);
      continue;
    }
    if (binding.kind === "child") {
      const childEntry = `__durable_child_${registrations.length}`;
      if (privateNames.has(childEntry)) {
        throw Error("Duplicate compiled function");
      }
      privateNames.add(childEntry);
      implementations.add(
        `(define (${childEntry} ctx input) (yield-at ${encodeValue(publicName)} (list "exchange" ${encodeValue(binding.contract.id)} input)))`,
      );
      registrations.push(`(${publicName} compiled ${childEntry} (#f))`);
      continue;
    }
    const definition = binding.module;
    if (
      definition.implementation.format !== HOOT_DEFINITION_FORMAT ||
      typeof definition.implementation.payload !== "string"
    ) {
      throw Error("Incompatible Hoot workflow definition");
    }
    const source = definition.implementation.payload;
    const exported = definition.exports.find((e) => e.name === binding.export);
    if (!exported) {
      throw Error("Missing compiled export");
    }
    const entry = name(exported.entry);
    const forms = parse(source) as unknown[];
    const names = forms.map((form: unknown) => {
      if (
        !Array.isArray(form) ||
        form[0]?.sym !== "define" ||
        !Array.isArray(form[1]) ||
        typeof form[1][0]?.sym !== "string"
      ) {
        throw Error("Compiled implementation must contain function definitions");
      }
      return name(form[1][0].sym);
    });
    if (!names.includes(entry)) {
      throw Error(`Missing compiled workflow entry: ${entry}`);
    }
    if (!implementations.has(source)) {
      for (const privateName of names) {
        if (privateNames.has(privateName)) {
          throw Error(`Duplicate compiled function: ${privateName}`);
        }
        privateNames.add(privateName);
      }
      implementations.add(source);
    }
    registrations.push(`(${publicName} compiled ${entry} (#f))`);
  }
  // The caller is parsed as forms so it cannot close the host's registration envelope.
  // Restricted caller validation and isolated preflight still run in the evaluator.
  parse(caller.implementation.payload);
  return {
    format: HOOT_PROGRAM_FORMAT,
    payload: `(registered-program\n(${[...implementations].join("\n")}\n)\n(${registrations.join(" ")})\n(${caller.implementation.payload}\n))`,
  };
}
