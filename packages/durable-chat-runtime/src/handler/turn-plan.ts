/**
 * Durable chat turn plan.
 *
 * Pure decision logic for one typed command: which explicit interrupt applies,
 * whether public resume entries validate, and which elicit responses the engine
 * receives. Ordinary messages never imply supersession.
 */
import type { ChatRequestBody, ElicitResponse } from "./chat-types.ts";
import {
  deriveResumeScopeFromEntries,
  deriveResumeScopeId,
  verifyResumeEntries,
  type OpenInterruptRecord,
} from "../interrupts/index.ts";
import { mapResumeEntriesToElicitResponses } from "./request-normalization.ts";

export type ResumeValidation = ReturnType<typeof verifyResumeEntries>;

export interface TurnPlan {
  /** Open interrupts for the thread at planning time. */
  openInterrupts: OpenInterruptRecord[];
  /** The explicit interrupt command projected for the engine. */
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

  const resumeScopeFromEntries = deriveResumeScopeFromEntries(body.resume);
  const resumeEntryIds = new Set(body.resume?.map((entry) => entry.interruptId) ?? []);
  const matchingOpenScopes = new Set(
    openInterrupts
      .filter((record) => resumeEntryIds.has(record.interruptId))
      .map((record) => record.scopeId),
  );
  const resumeScopeFromOpenRecords =
    resumeEntryIds.size > 0 &&
    body.resume?.every((entry) =>
      openInterrupts.some((record) => record.interruptId === entry.interruptId),
    ) &&
    matchingOpenScopes.size === 1
      ? [...matchingOpenScopes][0]
      : undefined;
  const requestedResumeScopeId =
    deriveResumeScopeId(threadId, body.parentRunId) ?? resumeScopeFromOpenRecords;
  const hasOpenInterrupts = openInterrupts.length > 0;

  const effectivePluginAbort = body.pluginAbort;

  const resumeValidation = effectivePluginAbort
    ? null
    : body.resume
      ? requestedResumeScopeId || resumeScopeFromEntries
        ? verifyResumeEntries({
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
      : method === "POST" && hasOpenInterrupts && requestedResumeScopeId
        ? verifyResumeEntries({
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
    effectivePluginAbort,
    resumeValidation,
    effectiveElicitResponses,
    initialToolChoice: effectiveElicitResponses.length ? undefined : body.initialToolChoice,
  };
}
