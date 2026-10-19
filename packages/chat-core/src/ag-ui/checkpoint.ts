import type { AgUiCustomState, ElicitRequestStreamEvent } from "./types.ts";

export function buildAgUiCustomState(options: {
  elicits?: ElicitRequestStreamEvent[];
}): AgUiCustomState {
  const pendingClientActions = (options.elicits ?? []).map((elicit) => ({
    toolCallId: elicit.callId,
    toolName: elicit.toolName,
    kind: "elicit" as const,
    sessionId: elicit.sessionId,
    elicitId: elicit.elicitId,
    key: elicit.key,
    message: elicit.message,
    /* CONDITIONAL-SPREAD: Omit absent schema from portable chat history and projection records; explicit undefined is not a portable JSON value. */
    ...(elicit.schema ? { schema: elicit.schema } : {}),
    /* CONDITIONAL-SPREAD: Omit absent bindingId from portable chat history and projection records; explicit undefined is not a portable JSON value. */
    ...(elicit.bindingId ? { bindingId: elicit.bindingId } : {}),
    /* CONDITIONAL-SPREAD: Omit absent context from portable chat history and projection records; explicit undefined is not a portable JSON value. */
    ...(elicit.context !== undefined ? { context: elicit.context } : {}),
    /* CONDITIONAL-SPREAD: Omit absent responseContract from portable chat history and projection records; explicit undefined is not a portable JSON value. */
    ...(elicit.responseContract ? { responseContract: elicit.responseContract } : {}),
    /* CONDITIONAL-SPREAD: Omit absent contextContract from portable chat history and projection records; explicit undefined is not a portable JSON value. */
    ...(elicit.contextContract ? { contextContract: elicit.contextContract } : {}),
    /* CONDITIONAL-SPREAD: Omit absent placement from portable chat history and projection records; explicit undefined is not a portable JSON value. */
    ...(elicit.placement ? { placement: elicit.placement } : {}),
  }));

  return pendingClientActions.length > 0 ? { pendingClientActions } : {};
}
