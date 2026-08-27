import { CrankError } from "@sweatpants/durable-execution";
import { claimActivation, releaseActivation, renewActivation } from "./activation-decisions.ts";
import type {
  AuthorityCommand,
  AuthorityDecisionFrame,
  CommandResult,
  KernelTransition,
} from "./authority-contract.ts";
import { DecisionDraft, type AuthorityDecisionOptions } from "./decision-draft.ts";
import {
  abandonAttempt,
  beginCancellationUnwind,
  detachAttempt,
  detachTaskAttempts,
  forceOrphan,
  requestCancellation,
  settleParentFromChild,
  settlePullWithOutcome,
} from "./execution-lifecycle-decisions.ts";
import {
  breachForkGroup,
  commitPeerDelegation,
  commitPeerEvidence,
  forceOrphanForkGroup,
  openForkGroup,
  reportPeerLoss,
  type ForkDecisionServices,
} from "./fork-group-decisions.ts";
import {
  acceptAssistantPartial,
  acceptPreparation,
  appendEmission,
  completeTask,
  completeUnderMandate,
  emitUnderMandate,
  reservePull,
  reserveUnderMandate,
  resolvePull,
  type PullDecisionServices,
} from "./pull-decisions.ts";
import {
  bindFrontier,
  consumeTicket,
  issueRestoreTicket,
  prepareRestore,
} from "./recovery-decisions.ts";
import {
  bindAttachment,
  bindMandate,
  ensureChild,
  openTask,
  releaseMandate,
  replaceAttachment,
  type TaskDecisionServices,
} from "./task-decisions.ts";

export { queryAuthorityState } from "./authority-queries.ts";

export function decideAuthorityCommand<C extends AuthorityCommand>(
  frame: AuthorityDecisionFrame<C>,
  options: AuthorityDecisionOptions = {},
): KernelTransition<C> {
  const draft = new DecisionDraft(frame, options);
  const result = dispatchCommand(draft, frame.command);
  return {
    state: draft.state,
    entries: draft.entries,
    result: result as CommandResult<C>,
  };
}

const pullDecisionServices: PullDecisionServices = {
  settleParent: settleParentFromChild,
};

const taskDecisionServices: TaskDecisionServices = {
  detachAttempts: detachTaskAttempts,
};

const forkDecisionServices: ForkDecisionServices = {
  openTask,
  requestCancellation,
  settlePull: settlePullWithOutcome,
  settleParent: settleParentFromChild,
};

function dispatchCommand<C extends AuthorityCommand>(
  draft: DecisionDraft,
  command: C,
): CommandResult<C> {
  let result: unknown;
  switch (command.type) {
    case "execution.open-task":
      result = openTask(draft, command.request);
      break;
    case "execution.bind-attachment":
      result = bindAttachment(draft, command.request, taskDecisionServices);
      break;
    case "execution.bind-mandate":
      result = bindMandate(draft, command.request);
      break;
    case "execution.release-mandate":
      result = releaseMandate(draft, command.request);
      break;
    case "execution.replace-attachment":
      result = replaceAttachment(draft, command.request, taskDecisionServices);
      break;
    case "execution.ensure-child":
      result = ensureChild(draft, command.request);
      break;
    case "execution.open-fork-group":
      result = openForkGroup(draft, command.request, forkDecisionServices);
      break;
    case "execution.breach-fork-group":
      result = breachForkGroup(draft, command.request, forkDecisionServices);
      break;
    case "execution.force-orphan-fork-group":
      result = forceOrphanForkGroup(draft, command.request, forkDecisionServices);
      break;
    case "execution.commit-peer-delegation":
      result = commitPeerDelegation(draft, command.request);
      break;
    case "execution.commit-peer-evidence":
      result = commitPeerEvidence(draft, command.request, forkDecisionServices);
      break;
    case "execution.report-peer-loss":
      result = reportPeerLoss(draft, command.request, forkDecisionServices);
      break;
    case "execution.reserve-pull":
      result = reservePull(draft, command.request);
      break;
    case "execution.mandate-reserve":
      result = reserveUnderMandate(draft, command.request);
      break;
    case "execution.mandate-emission":
      result = emitUnderMandate(draft, command.request);
      break;
    case "execution.mandate-complete":
      result = completeUnderMandate(draft, command.request, pullDecisionServices);
      break;
    case "execution.accept-preparation":
      result = acceptPreparation(draft, command.request);
      break;
    case "execution.accept-assistant-partial":
      result = acceptAssistantPartial(draft, command.request);
      break;
    case "execution.resolve-pull":
      result = resolvePull(draft, command.request);
      break;
    case "execution.append-emission":
      result = appendEmission(draft, command.request);
      break;
    case "execution.complete-task":
      result = completeTask(draft, command.request, pullDecisionServices);
      break;
    case "execution.request-cancellation":
      result = requestCancellation(
        draft,
        command.request.sessionId,
        command.request.taskId,
        command.request.reason,
        command.request.commandId,
      );
      break;
    case "execution.begin-cancellation-unwind":
      result = beginCancellationUnwind(draft, command.request);
      break;
    case "execution.detach-attempt":
      result = detachAttempt(draft, command.request);
      break;
    case "execution.abandon-attempt":
      result = abandonAttempt(draft, command.request);
      break;
    case "execution.force-orphan":
      result = forceOrphan(draft, command.request);
      break;
    case "control.claim-activation":
      result = claimActivation(draft, command.request);
      break;
    case "control.renew-activation":
      result = renewActivation(draft, command.request);
      break;
    case "control.release-activation":
      result = releaseActivation(draft, command.request);
      break;
    case "recovery.issue-ticket":
      result = issueRestoreTicket(draft, command.request);
      break;
    case "recovery.prepare-restore":
      result = prepareRestore(draft, command.request);
      break;
    case "recovery.bind-frontier":
      result = bindFrontier(draft, command.request);
      break;
    case "recovery.consume-ticket":
      result = consumeTicket(draft, command.request);
      break;
    default:
      return assertNever(command);
  }
  return result as CommandResult<C>;
}

function assertNever(value: never): never {
  throw new CrankError(
    "invalid_command",
    `Unknown authority operation ${(value as { type?: string }).type ?? "missing"}`,
  );
}
