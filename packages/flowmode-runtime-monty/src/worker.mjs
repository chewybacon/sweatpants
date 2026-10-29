// Static imports let workerd compile the vendored bytes; no runtime file access.
import core from "../generated/monty.component.core.wasm";
import core2 from "../generated/monty.component.core2.wasm";
import core3 from "../generated/monty.component.core3.wasm";
import core4 from "../generated/monty.component.core4.wasm";
const modules = {
  "monty.component.core.wasm": core,
  "monty.component.core2.wasm": core2,
  "monty.component.core3.wasm": core3,
  "monty.component.core4.wasm": core4,
};
export function loadMontyModule(name) {
  if (!modules[name]) {
    throw Error("Unknown Monty module");
  }
  return modules[name];
}
