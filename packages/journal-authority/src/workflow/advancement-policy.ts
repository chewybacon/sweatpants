import { type Operation } from "effection";
import {
  CrankError,
  ProgramRecovery,
  type AdvancementPlan,
  type CaughtUpLeaf,
  type DeliveryMandate,
  type EvaluatorKind,
  type LivePlacement,
  type Mandate,
  programRouteDriverKind,
  type PeerReadyTarget,
  type PlacementRoute,
  type PreparedTarget,
  type ProgramRoute,
  type SandboxAffinity,
} from "@sweatpants/durable-execution";

import type { JournalAuthorityContract } from "../contract/authority-contract.ts";

/** Deployment policy owns selection and placement; replay owns neither. */
export interface AdvancementPolicy {
  select(targets: readonly PreparedTarget[]): Operation<AdvancementPlan | null>;
}

/** Deterministic policy used by the recursive composition coordinator. */
export function requestedTargetPolicy(taskId: string, placement: LivePlacement): AdvancementPolicy {
  return {
    *select(targets) {
      const target = targets.find((candidate) =>
        candidate.kind === "crank_native"
          ? candidate.caughtUp.item.address.taskId === taskId
          : candidate.ready.address.taskId === taskId,
      );
      return target === undefined ? null : { target, placement };
    },
  };
}

/** The one trust-boundary conversion from driver-owned route JSON. */
export function livePlacement(
  route: ProgramRoute,
  affinity: SandboxAffinity | undefined,
  evaluatorKind: EvaluatorKind,
): LivePlacement {
  const driverKind = programRouteDriverKind(route);
  const placementKind = placementKindForEvaluator(evaluatorKind);
  return {
    route: {
      kind: placementKind,
      driverKind,
      route: structuredClone(route),
    },
    evaluatorKind,
    sandbox:
      affinity === undefined
        ? { mode: "allocate" }
        : { mode: "reuse", affinity: structuredClone(affinity) },
  };
}

function placementKindForEvaluator(
  evaluatorKind: EvaluatorKind,
): Exclude<PlacementRoute["kind"], "peer"> {
  switch (evaluatorKind) {
    case "program":
      return "local";
    case "worker":
      return "worker";
    case "remote":
      return "remote";
    case "peer":
      throw new CrankError(
        "placement_unavailable",
        "Peer evaluators cannot be activated by a local driver",
      );
  }
}

/**
 * Separate live bind. Prepared values are sent once as CAS expectations;
 * Authority either issues the Mandate atomically or reports the stale field.
 */
export function* bindCaughtUpLeaf(
  authority: JournalAuthorityContract,
  caughtUp: CaughtUpLeaf,
  policy: AdvancementPolicy,
  ownerId: string,
  leaseDurationMs = 30_000,
): Operation<Mandate | null> {
  const selection = yield* policy.select([{ kind: "crank_native", caughtUp }]);
  if (selection === null || selection.target.kind !== "crank_native") return null;
  const item = selection.target.caughtUp.item;
  const checkpoint = yield* ProgramRecovery.operations.checkpoint(
    selection.target.caughtUp.restored.attachment,
  );
  const bound = yield* authority.command({
    type: "execution.bind-mandate",
    request: {
      ...(checkpoint.kind === "continuation" ? { checkpoint } : {}),
      address: item.address,
      strand: item.strand,
      program: item.program,
      attachmentId: selection.target.caughtUp.restored.attachment.attachmentId,
      ownerId,
      leaseDurationMs,
      placement: selection.placement,
      expected: {
        strandHeadDigest: item.plannedHead.digest,
        leaseEpoch: item.executionEpoch,
        forkGroupRevision: item.groupContext.groupRevision,
      },
      frontierProof: selection.target.caughtUp.frontierProof,
    },
  });
  if (bound.status === "stale") return null;
  return bound.mandate;
}

export function* bindPeerReadyTarget(
  authority: JournalAuthorityContract,
  ready: PeerReadyTarget,
  placement: LivePlacement,
  ownerId: string,
  attachmentId: string,
  leaseDurationMs = 30_000,
): Operation<DeliveryMandate | null> {
  const bound = yield* authority.command({
    type: "execution.bind-delivery-mandate",
    request: {
      ready,
      attachmentId,
      ownerId,
      leaseDurationMs,
      placement,
      expected: {
        strandHeadDigest: ready.evidenceHead.digest,
        leaseEpoch: ready.executionEpoch,
        forkGroupRevision: ready.groupContext.groupRevision,
      },
    },
  });
  return bound.status === "stale" ? null : bound.mandate;
}

export function assertMandateCurrent(mandate: Mandate): void {
  if (mandate.lease.expiresAtMs <= 0 || mandate.lease.epoch <= 0) {
    throw new CrankError("stale_activation", "Mandate lease is invalid");
  }
}
