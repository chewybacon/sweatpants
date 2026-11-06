import {
  lowerScriptcSources,
  scriptcCompiler,
} from "../../../packages/v2/codemode-compiler-frontend-typescript/src/scriptc.ts";
import { admitInput, projectWorkflow } from "./assembly.mjs";

// A live implementation of TypeScriptWorkflowFrontend. It reads no recorded IR
// or provenance fixture. Compiler processes/files close before this returns.
export function compileWorkflow(input) {
  const { admitted, helperText } = admitInput(input);
  const ir = lowerScriptcSources(
    { "review.ts": admitted.source, "helper.ts": helperText },
    "review.ts",
    ["review"],
  );
  return { ...projectWorkflow(ir, admitted, helperText), ir, admitted, compiler: scriptcCompiler };
}
export const frontend = {
  *lower(input) {
    return compileWorkflow(input).module;
  },
};
