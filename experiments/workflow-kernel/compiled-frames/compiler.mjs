// Optional bytecode reference backend for compiler and recovery comparisons.
import { compile } from "../continuation-compiler/engine.mjs";
import { emitWorkflowScheme } from "../../../packages/flowmode-compiler/src/emit-scheme.mjs";

export function compileWorkflow(source, { compileScheme = compile, ...options } = {}) {
  const emitted = emitWorkflowScheme(source, options);
  const program = compileScheme(emitted.scheme),
    frameNames = {};
  const code = program.functions[program.entry].code;
  code.forEach((ins, i) => {
    if (ins[0] === "closure" && code[i + 1]?.[0] === "define") {
      frameNames[ins[1]] = code[i + 1][1];
    }
  });
  return { ...emitted, program, debug: { ...emitted.debug, frameNames } };
}
export function inspect(artifact, state) {
  if (state.program !== artifact.program.id) {
    throw Error("Checkpoint/program mismatch");
  }
  return {
    status: state.status,
    site: state.site,
    source: artifact.debug.sites[state.site],
    scopes: state.scopes?.map((scope) => ({
      ...scope,
      source: artifact.debug.sites[scope.site],
    })),
    frames: state.frames.map((f) => ({
      function: artifact.debug.frameNames[f.fn] ?? "<entry>",
      instruction: f.ip,
      locals: state.heap[f.env].bindings,
      operandStack: f.stack,
      handlers: f.handlers,
      scopeBoundary: f.scopeBoundary,
      cleanupScope: f.cleanupScope,
    })),
  };
}
export function compatibility(previous, next) {
  return previous.program.id === next.program.id
    ? { compatible: true, reason: "Identical executable artifact; source metadata may differ" }
    : { compatible: false, reason: "Executable changed; explicit migration required" };
}
