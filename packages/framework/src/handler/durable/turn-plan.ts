/**
 * Durable chat turn plan.
 *
 * Pure decision logic for one POST turn: whether an open interrupted program
 * turn is superseded by a free-form user message, which pluginAbort applies,
 * whether public resume entries validate, and which elicit responses the
 * engine receives. No I/O; interrupt state commits happen elsewhere only
 * after the crank durably accepts the respond commands.
 */
import type { ChatRequestBody, ElicitResponse } from "./types.ts";
import {
  deriveResumeScopeFromEntries,
  deriveResumeScopeId,
  validateResumeEntries,
  type OpenInterruptRecord,
} from "./interrupt-registry.ts";
import { mapResumeEntriesToElicitResponses } from "./request-normalization.ts";

export type ResumeValidation = ReturnType<typeof validateResumeEntries>;

export interface TurnPlan {
  /** Open interrupts for the thread at planning time. */
  openInterrupts: OpenInterruptRecord[];
  /** A free-form user message supersedes the open interrupted program turn. */
  supersedeOpenProgramTurn: boolean;
  /** The pluginAbort the engine receives (explicit or supersession-derived). */
  effectivePluginAbort: ChatRequestBody["pluginAbort"];
  /** Outcome of public resume validation, or null when not applicable. */
  resumeValidation: ResumeValidation | null;
  /** Elicit responses the engine receives (direct responses win over resume). */
  effectiveElicitResponses: ElicitResponse[];
  /** initialToolChoice is suppressed when responses continue a parked turn. */
  initialToolChoice: ChatRequestBody["initialToolChoice"];
}

export function planTurn(params: {
  body: ChatRequestBody;
  method: string;
  threadId: string;
  runId: string;
  openInterrupts: OpenInterruptRecord[];
  toolRuntimeId: string;
}): TurnPlan {
  const { body, method, threadId, runId, openInterrupts, toolRuntimeId } = params;

  const requestedResumeScopeId = deriveResumeScopeId(threadId, body.parentRunId);
  const resumeScopeFromEntries = deriveResumeScopeFromEntries(body.resume);
  const hasOpenInterrupts = openInterrupts.length > 0;

  const supersedeOpenProgramTurn =
    method === "POST" &&
    hasOpenInterrupts &&
    body.resume === undefined &&
    body.elicitResponses === undefined &&
    body.pluginAbort === undefined &&
    body.messages.some((message) => message.role === "user");

  const effectivePluginAbort =
    body.pluginAbort ??
    (supersedeOpenProgramTurn
      ? {
          sessionId: openInterrupts[0]?.toolCallId ?? openInterrupts[0]?.interruptId ?? runId,
          reason: "superseded_by_user_message",
        }
      : undefined);

  const resumeValidation = effectivePluginAbort
    ? null
    : body.resume
      ? requestedResumeScopeId || resumeScopeFromEntries
        ? validateResumeEntries({
            threadId: resumeScopeFromEntries?.threadId ?? threadId,
            scopeId: requestedResumeScopeId ?? resumeScopeFromEntries!.scopeId,
            runId,
            resume: body.resume,
          })
        : ({
            ok: false,
            code: "INVALID_RESUME",
            message: "Unable to determine resume scope",
          } as const)
      : hasOpenInterrupts && requestedResumeScopeId
        ? validateResumeEntries({
            threadId,
            scopeId: requestedResumeScopeId,
            runId,
            resume: [],
          })
        : null;

  const directElicitResponses = body.elicitResponses ?? [];
  const publicResumeResponses = resumeValidation?.ok
    ? mapResumeEntriesToElicitResponses(body, resumeValidation.records, toolRuntimeId)
    : [];
  const effectiveElicitResponses =
    directElicitResponses.length > 0 ? directElicitResponses : publicResumeResponses;

  return {
    openInterrupts,
    supersedeOpenProgramTurn,
    effectivePluginAbort,
    resumeValidation,
    effectiveElicitResponses,
    initialToolChoice: effectiveElicitResponses.length ? undefined : body.initialToolChoice,
  };
}
