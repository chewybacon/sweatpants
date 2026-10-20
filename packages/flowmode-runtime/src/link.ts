import { canonicalDigest } from "@sweatpants/foundation";
import type { CompileResult, CompiledWorkflow, WorkflowBinding } from "./authoring.ts";

export function requireCompiledWorkflow(result: CompileResult): CompiledWorkflow {
  if (!result.ok) {
    throw Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
  }
  return result.module;
}

/** Resolution is host-owned. Target linkers additionally validate their calling convention. */
export function assertWorkflowLink(
  caller: CompiledWorkflow,
  bindings: readonly WorkflowBinding[],
): void {
  const catalog = new Map<string, WorkflowBinding>();
  const names = new Set<string>();
  for (const binding of bindings) {
    if (catalog.has(binding.contract.id) || names.has(binding.contract.name)) {
      throw Error("Duplicate workflow binding");
    }
    catalog.set(binding.contract.id, binding);
    names.add(binding.contract.name);
    if (binding.kind === "compiled") {
      const exported = binding.module.exports.find((e) => e.name === binding.export);
      if (
        !exported ||
        exported.contract.inputSchema.digest !== binding.contract.inputSchema.digest ||
        exported.contract.outputSchema.digest !== binding.contract.outputSchema.digest
      ) {
        throw Error("Compiled export contract differs");
      }
    }
  }
  for (const module of [
    caller,
    ...bindings.flatMap((b) => (b.kind === "compiled" ? [b.module] : [])),
  ]) {
    for (const imported of module.imports) {
      const resolved = catalog.get(imported.contract.id);
      if (
        !resolved ||
        resolved.kind !== imported.kind ||
        canonicalDigest(resolved.contract) !== canonicalDigest(imported.contract)
      ) {
        throw Error(`Unresolved workflow binding: ${imported.contract.name}`);
      }
    }
  }
}
