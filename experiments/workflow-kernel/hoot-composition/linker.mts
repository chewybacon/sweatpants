import type { WorkflowLinker } from "../../../packages/workflow-kernel/src/index.ts";
import { parse } from "../scheme-data/read.mjs";
import { encodeValue } from "../scheme-data/values.mjs";

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
export const hootLinker: WorkflowLinker = {
  definitionFormat: HOOT_DEFINITION_FORMAT,
  programFormat: HOOT_PROGRAM_FORMAT,
  link({ caller, bindings }) {
    if (caller.language !== "scheme") {
      throw Error("Hoot linker requires Scheme caller source");
    }
    const publicNames = new Set<string>();
    const implementations = new Set<string>();
    const privateNames = new Set<string>();
    const registrations: string[] = [];
    for (const binding of bindings) {
      const publicName = name(binding.name);
      if (publicNames.has(publicName)) {
        throw Error(`Duplicate workflow binding: ${publicName}`);
      }
      publicNames.add(publicName);
      if (binding.kind === "host") {
        // The current evaluator emits version 1 for registered host calls.
        if (binding.version !== "1") {
          throw Error("Hoot host binding requires version 1");
        }
        registrations.push(`(${publicName} host)`);
        continue;
      }
      const definition = binding.definition;
      if (
        definition.kind !== "compiled-workflow" ||
        definition.implementation.format !== HOOT_DEFINITION_FORMAT ||
        typeof definition.implementation.payload !== "string"
      ) {
        throw Error("Incompatible Hoot workflow definition");
      }
      const source = definition.implementation.payload;
      const entry = name(definition.entry);
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
      registrations.push(
        `(${publicName} compiled ${entry} (${binding.prefixArguments.map(encodeValue).join(" ")}))`,
      );
    }
    // The caller is parsed as forms so it cannot close the host's registration envelope.
    // Restricted caller validation and isolated preflight still run in the evaluator.
    parse(caller.text);
    return {
      format: HOOT_PROGRAM_FORMAT,
      payload: `(registered-program\n(${[...implementations].join("\n")}\n)\n(${registrations.join(" ")})\n(${caller.text}\n))`,
    };
  },
};
