import type { Api, Operation } from "@standard-durability/core";
import type { ActivationIntents } from "@sweatpan.ts/durable";
import type { HostedResult } from "@sweatpan.ts/hosting";

/** One reconciliation pass, not a claim of exclusive execution ownership. */
export type ActivationReconciliation<R, Q> =
  | { readonly state: "idle" }
  | {
      readonly state: "driven";
      readonly result: HostedResult<R, Q>;
      /** True only when the exact pre-drive token was cleared. False can mean newer
       * work, nonquiescent blocking/yield, or another reconciler's acknowledgement. */
      readonly acknowledged: boolean;
    };

/** Bound reconciliation over a known root tree. Platform owners arrange subsequent passes. */
export interface ActivationReconciliationMethods<R, Q, Y> {
  /** Read intent, drive once, then acknowledge only the originally observed token.
   * This pass does not acknowledge on drive failure, yield, occupied/invalidated work,
   * or an unknown child disposition. Only terminal or known participant-wait results
   * attempt acknowledgement. Acknowledgement errors may follow committed deletion;
   * reread intent rather than assuming rollback. No delivery retry or busy polling. */
  reconcile(): Operation<ActivationReconciliation<R, Q>, Y>;
}

/** Scoped reconciliation with the exact intent facade its implementation invokes. */
export interface ActivationReconciler<R, Q, Y> extends Api<
  ActivationReconciliationMethods<R, Q, Y>,
  Y
> {
  readonly intents: Api<ActivationIntents<Y>, Y>;
}

/** Application binds one root's intent storage and ordinary Host assembly. */
export interface ActivationReconcilerOptions<R, Q, Y> {
  /** Assembly supplies the exact intent API used for dispatch and middleware. Reassemble after
   * replacing/closing its storage connection; existing facades do not follow a reopened store. */
  readonly intents: Api<ActivationIntents<Y>, Y>;
  /** Drive the same root tree using existing hosting. Install capabilities in its
   * execution scope. Throws propagate without acknowledgement. */
  run(): Operation<HostedResult<R, Q>, Y>;
}
