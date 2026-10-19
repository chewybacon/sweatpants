import { createWorkflowAuthoring } from "./composition.ts";
import type { WorkflowAuthoring } from "./authoring.ts";

/** Language-owned guidance with contracts from the same catalog used for linking. */
export function createWorkflowGuidance(
  sourceLanguage: string,
  guidance: string,
): WorkflowAuthoring {
  return createWorkflowAuthoring({
    driver: {
      sourceLanguage,
      *describe({ bindings, inputSchema, outputSchema }) {
        return `${guidance}\nDeclared contracts (host-owned):\n${JSON.stringify(bindings)}\nInput schema: ${JSON.stringify(inputSchema.inputProjection)}\nOutput schema: ${JSON.stringify(outputSchema.outputProjection)}`;
      },
    },
  });
}
