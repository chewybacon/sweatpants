import { createHash } from "node:crypto";
import {
  verifyWorkflowModule,
  type WorkflowLinkRequest,
  type WorkflowLinker,
  type LinkedWorkflow,
} from "@sweatpan.ts/codemode-compiler";
import {
  readWorkflowSExpressions as parse,
  workflowSymbolName as symbolName,
} from "@sweatpan.ts/codemode-compiler/syntax";
import { identifier, reserved, admitSchemeCaller } from "./caller.ts";
/** One trusted compiler module, one public entry. Not a general linker or verifier.
 * The caller is untrusted; compiled IR and grants are trusted assembly inputs. */
function linkScheme({
  module,
  caller,
  name,
  identity,
}: Omit<WorkflowLinkRequest, "caller"> & { caller: string }): LinkedWorkflow {
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
  const privateNames = new Set<string | undefined>();
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
  const admittedCaller = admitSchemeCaller(caller);
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

/** Common linker contract; this adapter retains the bounded Scheme caller profile. */
export const schemeWorkflowLinker: WorkflowLinker = {
  language: "scheme",
  link({ module, caller, name, identity }) {
    if (caller.language !== "scheme") {
      throw new Error("Expected Scheme caller");
    }
    return linkScheme({ module, caller: caller.text, name, identity });
  },
};
