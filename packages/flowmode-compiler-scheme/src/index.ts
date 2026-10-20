import {
  createTypeScriptWorkflowCompiler,
  emitTypeScriptWorkflowScheme,
} from "@sweatpants/flowmode-compiler";
export const schemeWorkflowCompiler = createTypeScriptWorkflowCompiler({
  definitionFormat: "workflow-scheme-definitions-v1",
  emit: emitTypeScriptWorkflowScheme,
});
