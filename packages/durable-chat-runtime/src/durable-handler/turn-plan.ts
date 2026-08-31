/**
 * Pure planning for one typed conversation command.
 *
 * Conversation admission validates head/Turn identity. the workflow host's
 * journal authority validates and settles respond-to-elicit against the exact
 * pending pull. Process-local interrupt records are rendering indexes only and
 * never participate in command correctness.
 */
import type { ChatRequestBody, ElicitResponse } from "./chat-types.ts";

export interface TurnPlan {
  /** The explicit interrupt command projected for the engine. */
  effectivePluginAbort: ChatRequestBody["pluginAbort"];
  /** Journal-targeted elicit responses derived from the typed command. */
  effectiveElicitResponses: ElicitResponse[];
  /** initialToolChoice is suppressed when a response continues a parked Turn. */
  initialToolChoice: ChatRequestBody["initialToolChoice"];
}

export function planTurn(body: ChatRequestBody): TurnPlan {
  const effectiveElicitResponses = body.elicitResponses ?? [];
  return {
    effectivePluginAbort: body.pluginAbort,
    effectiveElicitResponses,
    initialToolChoice: effectiveElicitResponses.length ? undefined : body.initialToolChoice,
  };
}
