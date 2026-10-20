import type { DurableOperationDescriptor } from "@sweatpants/durable-execution";
import type {
  BindingContract,
  ExchangeRequest,
  WorkflowBinding,
} from "@sweatpants/flowmode-runtime";

/** Installed host mechanics. Only their versioned references enter the artifact. */
export interface WorkflowHostCapability {
  readonly name: string;
  readonly version: string;
  describe(request: ExchangeRequest, contract: BindingContract): DurableOperationDescriptor;
}

/** Resolve before dispatch. Descriptor/schema authorization remains in the shared authority. */
export function createWorkflowBindingResolver(
  bindings: readonly WorkflowBinding[],
  capabilities: readonly WorkflowHostCapability[],
): (request: ExchangeRequest) => DurableOperationDescriptor {
  const catalog = new Map<string, WorkflowBinding>();
  const installed = new Map<string, WorkflowHostCapability>();
  for (const capability of capabilities) {
    const key = JSON.stringify([capability.name, capability.version]);
    if (installed.has(key)) {
      throw Error("Duplicate host capability");
    }
    installed.set(key, capability);
  }
  for (const binding of bindings) {
    if (catalog.has(binding.contract.id)) {
      throw Error("Duplicate workflow binding");
    }
    catalog.set(binding.contract.id, structuredClone(binding));
    if (
      binding.kind === "host" &&
      !installed.has(JSON.stringify([binding.capability.name, binding.capability.version]))
    ) {
      throw Error("Host capability unavailable");
    }
  }
  return (request) => {
    const binding = catalog.get(request.binding);
    if (!binding || binding.kind === "compiled") {
      throw Error("Unknown exchange binding");
    }
    if (binding.kind === "child") {
      return { kind: "invoke", child: { ...binding.program, input: request.input } };
    }
    const capability = installed.get(
      JSON.stringify([binding.capability.name, binding.capability.version]),
    );
    if (!capability) {
      throw Error("Host capability unavailable");
    }
    return capability.describe(request, binding.contract);
  };
}
