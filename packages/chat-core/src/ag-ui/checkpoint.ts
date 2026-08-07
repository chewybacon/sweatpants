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
    ...(elicit.schema ? { schema: elicit.schema } : {}),
    ...(elicit.bindingId ? { bindingId: elicit.bindingId } : {}),
    ...(elicit.context !== undefined ? { context: elicit.context } : {}),
    ...(elicit.responseContract ? { responseContract: elicit.responseContract } : {}),
    ...(elicit.contextContract ? { contextContract: elicit.contextContract } : {}),
    ...(elicit.placement ? { placement: elicit.placement } : {}),
  }));

  return pendingClientActions.length > 0 ? { pendingClientActions } : {};
}
