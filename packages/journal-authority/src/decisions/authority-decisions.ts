import { operateDocument } from "./document-decisions.ts";
import { CrankError } from "@sweatpants/durable-execution";
import { claimActivation, releaseActivation, renewActivation } from "./activation-decisions.ts";
import type {
  AuthorityCommand,
  AuthorityDecisionFrame,
  CommandResult,
  KernelTransition,
} from "../contract/authority-contract.ts";
import { DecisionDraft, type AuthorityDecisionOptions } from "./decision-draft.ts";
import { createAuthorityKernel } from "../state/authority-transaction.ts";
import {
  abandonAttempt,
  beginCancellationUnwind,
  detachAttempt,
  forceOrphan,
} from "./execution-lifecycle-decisions.ts";
import {
  bindDeliveryMandate,
  breachForkGroup,
  commitPeerDelegation,
  commitPeerEvidence,
  forceOrphanForkGroup,
  openForkGroup,
  reportPeerLoss,
  reserveDelegatedPeerSample,
} from "./fork-group-decisions.ts";
import {
  acceptAssistantPartial,
  acceptPreparation,
  appendEmission,
  completeTask,
  completeUnderMandate,
  emitUnderMandate,
  recoverRecord,
  reserveUnderMandate,
  resolvePull,
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
  releaseMandate,
  replaceAttachment,
} from "./task-decisions.ts";

export { queryAuthorityState } from "../state/authority-queries.ts";

export function decideAuthorityCommand<C extends AuthorityCommand>(
  frame: AuthorityDecisionFrame<C>,
  options: AuthorityDecisionOptions = {},
): KernelTransition<C> {
  const draft = new DecisionDraft(frame, options);
  const result = dispatchCommand(draft, frame.command);
  return {
    kind: draft.state === frame.state ? "unchanged" : "changed",
    state: draft.state,
    entries: draft.entries,
    result: result as CommandResult<C>,
  };
}

function dispatchCommand<C extends AuthorityCommand>(
  draft: DecisionDraft,
  command: C,
): CommandResult<C> {
  const kernel = createAuthorityKernel(draft);
  let result: unknown;
  switch (command.type) {
    case "document.operate":
      result = operateDocument(draft, command.request);
      break;
    case "execution.open-task":
      result = kernel.openTask(command.request);
      break;
    case "execution.bind-attachment":
      result = bindAttachment(kernel, command.request);
      break;
    case "execution.bind-mandate":
      result = bindMandate(draft, command.request);
      break;
    case "execution.bind-delivery-mandate":
      result = bindDeliveryMandate(draft, command.request);
      break;
    case "execution.release-mandate":
      result = releaseMandate(draft, command.request);
      break;
    case "execution.replace-attachment":
      result = replaceAttachment(kernel, command.request);
      break;
    case "execution.ensure-child":
      result = ensureChild(draft, command.request);
      break;
    case "execution.open-fork-group":
      result = openForkGroup(kernel, command.request);
      break;
    case "execution.breach-fork-group":
      result = breachForkGroup(kernel, command.request);
      break;
    case "execution.force-orphan-fork-group":
      result = forceOrphanForkGroup(kernel, command.request);
      break;
    case "execution.commit-peer-delegation":
      result = commitPeerDelegation(draft, command.request);
      break;
    case "execution.commit-peer-evidence":
      result = commitPeerEvidence(kernel, command.request);
      break;
    case "execution.reserve-delegated-peer-sample":
      result = reserveDelegatedPeerSample(kernel, command.request);
      break;
    case "execution.report-peer-loss":
      result = reportPeerLoss(kernel, command.request);
      break;
    case "execution.recover-record":
      result = recoverRecord(draft, command.request);
      break;
    case "execution.reserve-pull":
      result = kernel.reservePull(command.request);
      break;
    case "execution.mandate-reserve":
      result = reserveUnderMandate(draft, command.request);
      break;
    case "execution.mandate-emission":
      result = emitUnderMandate(draft, command.request);
      break;
    case "execution.mandate-complete":
      result = completeUnderMandate(kernel, command.request);
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
      result = completeTask(kernel, command.request);
      break;
    case "execution.request-cancellation":
      result = kernel.requestCancellation(
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
