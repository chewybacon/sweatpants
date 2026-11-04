import type { Composition } from "@standard-durability/core";
import type {
  ActivationReconciler,
  ActivationReconcilerOptions,
  ActivationReconciliationMethods,
} from "./contracts.ts";
import { reconcileActivation } from "./reconciliation.ts";
/** Bind one known execution tree to scoped reconciliation policy, without a scheduler or lease. */
export function createActivationReconciler<R, Q, Y>(
  composition: Composition<Y>,
  name: string,
  options: ActivationReconcilerOptions<R, Q, Y>,
): ActivationReconciler<R, Q, Y> {
  const { intents } = options;
  const api = composition.createApi<ActivationReconciliationMethods<R, Q, Y>>(name, {
    operations: {
      reconcile: () => reconcileActivation(intents.operations, () => options.run()),
    },
  });
  return { ...api, intents };
}
