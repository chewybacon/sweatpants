import type { Operation } from "effection";
import {
  CrankError,
  type AttachProgramRequest,
  type DurableProgramManifest,
  type PinnedProgram,
  type ProgramRoute,
  type ProgramRunResult,
} from "@sweatpants/durable-execution";

import type { JournalAuthorityContract } from "../authority-contract.ts";
import type {
  DurableOperationDescriptor,
  ProgramParkedSlot,
} from "@sweatpants/durable-execution";

export interface WorkflowTreeActivationRequest {
  readonly attach: AttachProgramRequest;
  /** Present only when task opening already minted the first attachment capability. */
  readonly initialProgramCapability?: string;
}

export interface WorkflowTreeHost {
  /** Runs one task until it parks or becomes terminal. */
  activate(request: WorkflowTreeActivationRequest): Operation<ProgramRunResult>;
  /** Resolves a pinned child manifest without weakening exact identity. */
  manifest(program: PinnedProgram): Operation<DurableProgramManifest>;
  /** Deployment-owned child placement policy. */
  route(program: PinnedProgram, parentRoute: ProgramRoute): Operation<ProgramRoute>;
  /**
   * Tries to settle one non-child park. `true` means a durable resolution was
   * committed and this task should be activated again; `false` exposes the
   * park to the caller (for example, an elicitation awaiting a participant).
   */
  settle(
    parked: Extract<ProgramRunResult, { state: "parked" }>,
    attach: AttachProgramRequest,
  ): Operation<boolean>;
}

export interface DriveWorkflowTreeRequest extends WorkflowTreeActivationRequest {
  readonly authority: JournalAuthorityContract;
  readonly host: WorkflowTreeHost;
}

/**
 * Drives one structured workflow tree to a public park or terminal root.
 *
 * Child invocation is topology, not resolver transport: the authority owns
 * child allocation and parent settlement, while this coordinator recursively
 * activates the exact child selected by the accepted invoke descriptor.
 */
export function* driveWorkflowTree(request: DriveWorkflowTreeRequest): Operation<ProgramRunResult> {
  return yield* driveNode(
    request.authority,
    request.host,
    request.attach,
    request.initialProgramCapability,
  );
}

function* driveNode(
  authority: JournalAuthorityContract,
  host: WorkflowTreeHost,
  attach: AttachProgramRequest,
  initialProgramCapability?: string,
): Operation<ProgramRunResult> {
  let capability = initialProgramCapability;
  for (;;) {
    const outcome = yield* host.activate({
      attach,
      ...(capability === undefined ? {} : { initialProgramCapability: capability }),
    });
    // Every later activation creates a fresh attachment and must bind it.
    capability = undefined;

    if (outcome.state !== "parked") {
      return outcome;
    }
    if (outcome.reason !== "child") {
      if (yield* host.settle(outcome, attach)) {
        continue;
      }
      return outcome;
    }

    const operation = yield* authority.query({
      type: "pull.state",
      sessionId: attach.sessionId,
      taskId: attach.taskId,
      pullId: outcome.pullId,
    });
    if (operation.status !== "found") {
      throw new CrankError("invalid_journal", "Parked child pull is unknown");
    }
    if (
      operation.descriptor.kind === "all" ||
      operation.descriptor.kind === "race"
    ) {
      const parked = yield* driveForkGroup(
        authority,
        host,
        attach,
        outcome.pullId,
        operation.descriptor,
      );
      // undefined means the group resolved: re-run the parent so ordinary
      // replay consumes the committed Terminal value.
      if (parked === undefined) continue;
      return parked;
    }
    if (operation.descriptor.kind !== "invoke") {
      throw new CrankError("invalid_journal", "Parked child pull is not a composition descriptor");
    }

    const child = operation.descriptor.child;
    const route = yield* host.route(child, attach.route);
    const manifest = yield* host.manifest(child);
    const childTask = yield* authority.command({
      type: "execution.ensure-child",
      request: {
        sessionId: attach.sessionId,
        turnId: turnIdFor(attach.taskId),
        parentTaskId: attach.taskId,
        parentPullId: outcome.pullId,
        child,
        manifest,
        executionEpoch: attach.executionEpoch,
        audience: "workflow-host",
        route,
      },
    });

    if (childTask.outcome === undefined) {
      const childOutcome = yield* driveNode(
        authority,
        host,
        {
          sessionId: attach.sessionId,
          taskId: childTask.taskId,
          program: { id: child.id, version: child.version, digest: child.digest },
          input: child.input,
          route,
          executionEpoch: attach.executionEpoch,
          ...(attach.affinity === undefined ? {} : { affinity: attach.affinity }),
        },
        undefined,
      );
      if (childOutcome.state === "parked") {
        return childOutcome;
      }
    }
    // Child completion settles the parent invoke in the authority. Re-run the
    // parent so ordinary replay consumes that committed outcome.
  }
}

function turnIdFor(taskId: string): string {
  const slash = taskId.indexOf("/");
  return slash === -1 ? "turn-0" : taskId.slice(0, slash);
}

/**
 * Drives one fork group (REQ-024): members advance as ordinary roots in
 * round-robin passes; advancement order is host policy, never authority
 * choice (REQ-027). A pass ends when every member is blocked on participant
 * input or terminal; the group resolves inside the authority, and the parent
 * re-runs once its fork slot settles.
 */
function* driveForkGroup(
  authority: JournalAuthorityContract,
  host: WorkflowTreeHost,
  attach: AttachProgramRequest,
  pullId: string,
  descriptor: Extract<DurableOperationDescriptor, { kind: "all" | "race" }>,
): Operation<Extract<ProgramRunResult, { state: "parked" }> | undefined> {
  const members = [] as {
    child: (typeof descriptor.children)[number];
    route: ProgramRoute;
    manifest: DurableProgramManifest;
  }[];
  for (const child of descriptor.children) {
    members.push({
      child,
      route: yield* host.route(child, attach.route),
      manifest: yield* host.manifest(child),
    });
  }
  const group = yield* authority.command({
    type: "execution.open-fork-group",
    request: {
      sessionId: attach.sessionId,
      turnId: turnIdFor(attach.taskId),
      parentTaskId: attach.taskId,
      parentPullId: pullId,
      members,
      executionEpoch: attach.executionEpoch,
      audience: "workflow-host",
    },
  });

  for (;;) {
    const slots: ProgramParkedSlot[] = [];
    let progressed = false;
    for (const [index, memberTaskId] of group.memberTaskIds.entries()) {
      // Peers advance under their own authority: the local row is structural
      // evidence, never a recipe (REQ-037), and never enters the prepared
      // set for local activation (REQ-075).
      if (descriptor.children[index]!.durability?.kind === "peer_hosted") continue;
      const lifecycle = yield* authority.query({
        type: "task.lifecycle",
        sessionId: attach.sessionId,
        taskId: memberTaskId,
      });
      if (lifecycle.status !== "active") continue;
      const member = members[index]!;
      const childOutcome = yield* driveNode(
        authority,
        host,
        {
          sessionId: attach.sessionId,
          taskId: memberTaskId,
          program: {
            id: member.child.id,
            version: member.child.version,
            digest: member.child.digest,
          },
          input: member.child.input,
          route: member.route,
          executionEpoch: attach.executionEpoch,
          ...(attach.affinity === undefined ? {} : { affinity: attach.affinity }),
        },
        undefined,
      );
      if (childOutcome.state === "parked") {
        slots.push({
          taskId: memberTaskId,
          pullId: childOutcome.pullId,
          reason: childOutcome.reason,
        });
      } else {
        progressed = true;
      }
    }
    const state = yield* authority.query({
      type: "pull.state",
      sessionId: attach.sessionId,
      taskId: attach.taskId,
      pullId,
    });
    if (state.status === "found" && state.outcome !== undefined) return undefined;
    if (!progressed) {
      return { state: "parked", pullId, reason: "child", slots };
    }
  }
}
