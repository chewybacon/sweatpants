import { verifyWorkflowModule, type WorkflowTarget } from "@sweatpan.ts/codemode-compiler";
import type { SchemeWorkflowArtifact } from "./contracts.ts";

/** The Scheme kernel already implements the shared dialect; only entry wiring is needed.
 * Consumes trusted frontend output, not arbitrary unverified source from a client.
 */
export const schemeWorkflowTarget: WorkflowTarget<SchemeWorkflowArtifact> = {
  emit(module) {
    verifyWorkflowModule(module);
    if (module.format !== "workflow-scheme/1" || module.entry.parameters !== "input") {
      throw new Error("Unsupported workflow Scheme profile");
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(module.entry.name)) {
      throw new Error("Invalid workflow entry name");
    }
    return {
      format: "scheme-execution/1",
      source: `${module.sexpressions}\n(${module.entry.name} %input)`,
      effects: module.effects,
    };
  },
};
