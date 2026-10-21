import {
  createTypeScriptWorkflowCompiler,
  emitSchemeIR,
  type TypeScriptWorkflowTarget,
} from "@sweatpants/flowmode-compiler";
export const schemeWorkflowTarget: TypeScriptWorkflowTarget = {
  definitionFormat: "workflow-scheme-definitions-v1",
  emit: emitSchemeIR,
};
export const schemeWorkflowCompiler = createTypeScriptWorkflowCompiler(schemeWorkflowTarget);
