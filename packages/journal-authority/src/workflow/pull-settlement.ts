import type { Operation } from "effection";
import { CrankError, type AttachProgramRequest } from "@sweatpants/durable-execution";
import { assertJson } from "@sweatpants/foundation";

import type { JournalAuthorityContract } from "../authority-contract.ts";
import type { PullResolver } from "../pull-kinds/registry.ts";

/**
 * Performs and commits one host-resolved parked pull against its owning
 * attachment. Descriptor lookup and resolution capability both come from
 * Authority; placement comes from the activation that exposed the park.
 */
export function* settleParkedPull(request: {
  readonly authority: JournalAuthorityContract;
  readonly resolver: PullResolver;
  readonly attach: AttachProgramRequest;
  readonly pullId: string;
  readonly driverKind: string;
}): Operation<void> {
  const operation = yield* request.authority.query({
    type: "pull.state",
    sessionId: request.attach.sessionId,
    taskId: request.attach.taskId,
    pullId: request.pullId,
  });
  if (operation.status !== "found") {
    throw new CrankError("invalid_journal", "Parked pull is absent from authority state");
  }
  const descriptor = assertJson(operation.descriptor);
  const context = {
    sessionId: request.attach.sessionId,
    taskId: request.attach.taskId,
    pullId: request.pullId,
    placement: {
      program: request.attach.program,
      route: request.attach.route,
      driverKind: request.driverKind,
      executionEpoch: request.attach.executionEpoch,
    },
  };
  const outcome = yield* request.resolver.perform(context, descriptor);
  const capability = yield* request.authority.query({
    type: "pull.resolution-capability",
    sessionId: request.attach.sessionId,
    taskId: request.attach.taskId,
    pullId: request.pullId,
  });
  const resolved = yield* request.authority.command({
    type: "execution.resolve-pull",
    request: {
      capability,
      audience: request.resolver.audience(descriptor),
      outcome,
    },
  });
  if (resolved.status === "rejected") {
    throw new CrankError("pull_resolution_rejected", resolved.code);
  }
  if (request.resolver.afterResolve) {
    yield* request.resolver.afterResolve(context, descriptor, resolved.receipt.outcomeDigest);
  }
}
