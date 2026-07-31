import type { Message } from "../messages.ts";
import type { ChatState, ChatStateInternal } from "../state/chat-state.ts";
import { createInitialChatStateInternal } from "../state/chat-state.ts";
import type { ChatStateEvent, LocalChatAction } from "../state/events.ts";
import type { ChatCommand, ElicitResponseData, StreamChatOptions } from "./options.ts";
import { foldChatState, publicChatState } from "./projection.ts";
import type { ConversationReplayState, ElicitRequestStreamEvent } from "./streaming.ts";
import type { ChatTransportReceipt, ChatTurnFailure, ChatTurnSettlement } from "./settlement.ts";
import {
  appendAssistantFinalMessage,
  appendToolMessage,
  appendUserMessage,
  createTranscriptState,
} from "./transcript.ts";

export interface OpenToolCall {
  readonly callId: string;
  readonly toolName: string;
}

export type RunProjection =
  | { readonly phase: "idle" }
  | {
      readonly phase: "streaming";
      readonly threadId: string;
      readonly runId: string;
      readonly producedMessage: boolean;
    }
  | {
      readonly phase: "terminal";
      readonly threadId?: string;
      readonly runId?: string;
      readonly settlement: ChatTurnSettlement;
    };

export interface SessionProjectionState {
  readonly view: ChatStateInternal;
  readonly history: readonly Message[];
  readonly run: RunProjection;
  readonly openCalls: readonly OpenToolCall[];
  readonly replayState?: ConversationReplayState;
  readonly conversationId?: string;
  readonly pendingElicitResponses: readonly ElicitResponseData[];
  readonly sentElicitResponseIds: readonly string[];
  readonly activeRequestId?: string;
}

export type RequestLifecycle = "request" | "cancellation";

export interface ChatRequestPlan {
  readonly requestId: string;
  readonly history: readonly Message[];
  readonly lifecycle: RequestLifecycle;
  readonly conversationId?: string;
  readonly elicitResponses?: readonly ElicitResponseData[];
  readonly replayState?: ConversationReplayState;
  readonly pluginAbort?: StreamChatOptions["pluginAbort"];
}

export interface ChatRequestFailure extends ChatTurnFailure {}

export type SessionInput =
  | {
      readonly type: "hydrate";
      readonly history: readonly Message[];
      readonly events: readonly ChatStateEvent[];
      readonly replayState?: ConversationReplayState;
      readonly observedAt: number;
    }
  | {
      readonly type: "command";
      readonly command: ChatCommand;
      readonly hadActiveRequest: boolean;
      readonly abortMessageId: string;
      readonly requestId: string;
      readonly preservePartialOnAbort: boolean;
      readonly abortSuffix: string;
      readonly observedAt: number;
    }
  | {
      readonly type: "stream-event";
      readonly requestId: string;
      readonly event: ChatStateEvent;
      readonly observedAt: number;
    }
  | {
      readonly type: "transport-drained";
      readonly requestId: string;
      readonly receipt: ChatTransportReceipt;
      readonly observedAt: number;
    }
  | {
      readonly type: "transport-failed";
      readonly requestId: string;
      readonly failure: ChatRequestFailure;
      readonly observedAt: number;
    };

export type SessionOutput =
  | { readonly type: "cancel-request" }
  | { readonly type: "start-request"; readonly plan: ChatRequestPlan }
  | { readonly type: "request-failed"; readonly failure: ChatRequestFailure }
  | { readonly type: "turn-settled"; readonly settlement: ChatTurnSettlement };

export interface SessionTransition {
  readonly state: SessionProjectionState;
  readonly outputs: readonly SessionOutput[];
}

export function createInitialSessionProjectionState(
  conversationId?: string,
): SessionProjectionState {
  return {
    view: createInitialChatStateInternal(),
    history: [],
    run: { phase: "idle" },
    openCalls: [],
    pendingElicitResponses: [],
    sentElicitResponseIds: [],
    ...(conversationId ? { conversationId } : {}),
  };
}

export function sessionPublicState(state: SessionProjectionState): ChatState {
  return publicChatState(state.view);
}

function pendingElicitations(state: ChatState): ElicitRequestStreamEvent[] {
  return Object.values(state.pendingElicits)
    .flatMap((tracking) => tracking.elicitations)
    .filter((elicit) => elicit.status === "pending")
    .map((elicit) => ({
      type: "elicit_request" as const,
      sessionId: elicit.sessionId,
      callId: elicit.callId,
      toolName: elicit.toolName,
      elicitId: elicit.elicitId,
      key: elicit.key,
      message: elicit.message,
      schema: elicit.schema,
    }));
}

function upsertHistoryMessage(
  history: readonly Message[],
  message: Message,
): { history: readonly Message[]; added: boolean } {
  const existingIndex = history.findIndex((candidate) => candidate.id === message.id);
  if (existingIndex >= 0) {
    const existing = history[existingIndex]!;
    const replacement = existing.replay && !message.replay ? existing : message;
    return {
      history: history.map((candidate, index) =>
        index === existingIndex ? replacement : candidate,
      ),
      added: false,
    };
  }

  if (message.role === "tool" && message.tool_call_id) {
    const hostIndex = history.findIndex(
      (candidate) =>
        candidate.role === "assistant" &&
        candidate.tool_calls?.some((call) => call.id === message.tool_call_id),
    );
    if (hostIndex >= 0) {
      let resultIndex = hostIndex + 1;
      while (history[resultIndex]?.role === "tool") {
        resultIndex += 1;
      }
      return {
        history: [...history.slice(0, resultIndex), message, ...history.slice(resultIndex)],
        added: true,
      };
    }
  }

  return { history: [...history, message], added: true };
}

function synchronizeHistory(
  history: readonly Message[],
  messages: readonly Message[],
): { history: readonly Message[]; added: boolean } {
  let next = history;
  let added = false;
  for (const message of messages) {
    const update = upsertHistoryMessage(next, message);
    next = update.history;
    added = update.added || added;
  }
  return { history: next, added };
}

function addOpenCall(calls: readonly OpenToolCall[], call: OpenToolCall): readonly OpenToolCall[] {
  return calls.some((candidate) => candidate.callId === call.callId)
    ? calls.map((candidate) => (candidate.callId === call.callId ? call : candidate))
    : [...calls, call];
}

function unresolvedCalls(history: readonly Message[]): readonly OpenToolCall[] {
  const completed = new Set(
    history
      .filter((message) => message.role === "tool" && message.tool_call_id)
      .map((message) => message.tool_call_id!),
  );
  return history.flatMap((message) =>
    message.role === "assistant"
      ? (message.tool_calls ?? [])
          .filter((call) => !completed.has(call.id))
          .map((call) => ({ callId: call.id, toolName: call.function.name }))
      : [],
  );
}

function appendUser(
  history: readonly Message[],
  content: string,
): { history: readonly Message[]; message: Message } {
  const next = [...history];
  const message = appendUserMessage(next, createTranscriptState(next), content);
  return { history: next, message };
}

function appendAssistant(
  history: readonly Message[],
  content: string,
): { history: readonly Message[]; message: Message } {
  const next = [...history];
  const message = appendAssistantFinalMessage(next, createTranscriptState(next), content);
  return { history: next, message };
}

function appendCancelledToolResults(
  history: readonly Message[],
  calls: readonly OpenToolCall[],
): readonly Message[] {
  if (calls.length === 0) return history;
  const next = [...history];
  const transcript = createTranscriptState(next);
  for (const call of calls) {
    if (next.some((message) => message.role === "tool" && message.tool_call_id === call.callId)) {
      continue;
    }
    appendToolMessage(
      next,
      transcript,
      call.callId,
      call.toolName,
      "Tool execution was cancelled by user sending a new message.",
      true,
    );
  }
  return next;
}

function retainVisiblePartial(state: SessionProjectionState): SessionProjectionState {
  const partial = state.view.streaming.parts
    .filter((part) => part.type === "text")
    .map((part) => part.content)
    .join("");
  if (
    !partial ||
    state.history.some((message) => message.role === "assistant" && message.content === partial)
  ) {
    return state;
  }
  return { ...state, history: appendAssistant(state.history, partial).history };
}

function applyViewEvent(
  state: SessionProjectionState,
  event: ChatStateEvent,
  observedAt: number,
): { state: SessionProjectionState; addedMessage: boolean } {
  const view = foldChatState(state.view, event, observedAt);
  if (view.messages === state.view.messages) {
    return { state: { ...state, view }, addedMessage: false };
  }
  const synchronized = synchronizeHistory(state.history, view.messages);
  return {
    state: { ...state, view, history: synchronized.history },
    addedMessage: synchronized.added,
  };
}

function applyLocalAction(
  state: SessionProjectionState,
  action: LocalChatAction,
  observedAt: number,
): SessionProjectionState {
  return applyViewEvent(state, action, observedAt).state;
}

function createRequestPlan(
  state: SessionProjectionState,
  requestId: string,
  lifecycle: RequestLifecycle,
  pluginAbort?: StreamChatOptions["pluginAbort"],
): { state: SessionProjectionState; plan: ChatRequestPlan } {
  const plan: ChatRequestPlan = {
    requestId,
    history: state.history,
    lifecycle,
    ...(state.conversationId ? { conversationId: state.conversationId } : {}),
    ...(state.pendingElicitResponses.length > 0
      ? { elicitResponses: state.pendingElicitResponses }
      : {}),
    ...(state.replayState ? { replayState: state.replayState } : {}),
    ...(pluginAbort ? { pluginAbort } : {}),
  };
  return {
    state: { ...state, pendingElicitResponses: [], activeRequestId: requestId },
    plan,
  };
}

function startRequestOutputs(
  state: SessionProjectionState,
  requestId: string,
  lifecycle: RequestLifecycle = "request",
  pluginAbort?: StreamChatOptions["pluginAbort"],
): SessionTransition {
  const request = createRequestPlan(state, requestId, lifecycle, pluginAbort);
  return {
    state: request.state,
    outputs: [{ type: "cancel-request" }, { type: "start-request", plan: request.plan }],
  };
}

function transitionCommand(
  state: SessionProjectionState,
  input: Extract<SessionInput, { type: "command" }>,
): SessionTransition {
  const command = input.command;
  switch (command.type) {
    case "send": {
      let next = state;
      const partial = input.hadActiveRequest ? command.partialContent?.trim() : undefined;
      if (partial) {
        const appended = appendAssistant(next.history, command.partialContent!);
        next = applyLocalAction(
          { ...next, history: appended.history },
          { type: "LOCAL_ASSISTANT_MESSAGE", message: appended.message, partial: true },
          input.observedAt,
        );
      }

      next = { ...next, history: appendCancelledToolResults(next.history, next.openCalls) };
      let sentIds = next.sentElicitResponseIds;
      for (const elicit of pendingElicitations(publicChatState(next.view))) {
        if (sentIds.includes(elicit.elicitId)) continue;
        sentIds = [...sentIds, elicit.elicitId];
        next = applyLocalAction(
          next,
          {
            type: "LOCAL_ELICIT_RESPONSE",
            callId: elicit.callId,
            elicitId: elicit.elicitId,
            response: { action: "cancel" },
          },
          input.observedAt,
        );
      }

      const user = appendUser(next.history, command.content);
      next = applyLocalAction(
        { ...next, history: user.history, openCalls: [], sentElicitResponseIds: sentIds },
        { type: "LOCAL_USER_MESSAGE", message: user.message },
        input.observedAt,
      );
      return startRequestOutputs(next, input.requestId);
    }

    case "continue":
      return startRequestOutputs(state, input.requestId);

    case "abort": {
      let next = state;
      if (input.preservePartialOnAbort && command.partialContent?.trim()) {
        const message: Message = {
          id: input.abortMessageId,
          role: "assistant",
          content: command.partialContent + input.abortSuffix,
          partial: true,
        };
        next = applyLocalAction(
          { ...next, history: [...next.history, message] },
          { type: "LOCAL_ABORT", message },
          input.observedAt,
        );
      } else {
        next = applyLocalAction(next, { type: "LOCAL_ABORT" }, input.observedAt);
      }
      return startRequestOutputs(next, input.requestId, "cancellation", {
        reason: "cancelled_by_user",
      });
    }

    case "reset":
      return {
        state: {
          ...createInitialSessionProjectionState(state.conversationId),
          ...(state.replayState ? { replayState: state.replayState } : {}),
        },
        outputs: [{ type: "cancel-request" }],
      };

    case "elicit_response": {
      if (state.sentElicitResponseIds.includes(command.elicitId)) {
        return { state, outputs: [] };
      }
      const response: ElicitResponseData = {
        sessionId: command.sessionId,
        callId: command.callId,
        ...(command.toolName ? { toolName: command.toolName } : {}),
        ...(command.ref ? { ref: command.ref } : {}),
        elicitId: command.elicitId,
        completion: command.completion,
        ...(command.trace ? { trace: command.trace } : {}),
      };
      const next = applyLocalAction(
        {
          ...state,
          pendingElicitResponses: [...state.pendingElicitResponses, response],
          sentElicitResponseIds: [...state.sentElicitResponseIds, command.elicitId],
        },
        {
          type: "LOCAL_ELICIT_RESPONSE",
          callId: command.callId,
          elicitId: command.elicitId,
          response: command.completion,
        },
        input.observedAt,
      );
      return command.autoContinue === false
        ? { state: next, outputs: [] }
        : startRequestOutputs(next, input.requestId);
    }
  }
}

function transitionStreamEvent(
  state: SessionProjectionState,
  event: ChatStateEvent,
  observedAt: number,
): SessionTransition {
  const folded = applyViewEvent(state, event, observedAt);
  let next = folded.state;
  let run = next.run;
  let openCalls = next.openCalls;

  if (event.type === "RUN_STARTED") {
    run = {
      phase: "streaming",
      threadId: event.threadId,
      runId: event.runId,
      producedMessage: false,
    };
  } else if (
    folded.addedMessage &&
    run.phase === "streaming" &&
    (event.type === "TEXT_MESSAGE_END" ||
      event.type === "TOOL_CALL_END" ||
      event.type === "TOOL_CALL_RESULT")
  ) {
    run = { ...run, producedMessage: true };
  }

  if (event.type === "TOOL_CALL_END") {
    const name = next.view.toolCallDrafts[event.toolCallId]?.name;
    if (name) openCalls = addOpenCall(openCalls, { callId: event.toolCallId, toolName: name });
  } else if (event.type === "TOOL_CALL_RESULT") {
    openCalls = openCalls.filter((call) => call.callId !== event.toolCallId);
  }

  next = {
    ...next,
    run,
    openCalls,
    ...(next.view.replay ? { replayState: next.view.replay } : {}),
  };

  if (event.type === "RUN_FINISHED") {
    if (event.outcome?.type === "interrupt") {
      const settlement: ChatTurnSettlement = {
        outcome: "interrupt",
        pendingElicitations: pendingElicitations(publicChatState(next.view)),
      };
      return {
        state: {
          ...next,
          run: {
            phase: "terminal",
            threadId: event.threadId,
            runId: event.runId,
            settlement,
          },
        },
        outputs: [],
      };
    }

    if (run.phase === "streaming" && !run.producedMessage) {
      next = { ...next, history: appendAssistant(next.history, "").history };
    }
    const settlement: ChatTurnSettlement = { outcome: "complete" };
    return {
      state: {
        ...next,
        openCalls: [],
        run: {
          phase: "terminal",
          threadId: event.threadId,
          runId: event.runId,
          settlement,
        },
      },
      outputs: [],
    };
  }

  if (event.type === "RUN_ERROR") {
    const failure: ChatRequestFailure = {
      message: event.message,
      ...(event.code ? { code: event.code } : {}),
    };
    next = retainVisiblePartial(next);
    return {
      state: {
        ...next,
        run: {
          phase: "terminal",
          ...(run.phase === "streaming" ? { threadId: run.threadId, runId: run.runId } : {}),
          settlement: { outcome: "failed", failure },
        },
      },
      outputs: [],
    };
  }

  return { state: next, outputs: [] };
}

function settleTransport(
  state: SessionProjectionState,
  receipt: ChatTransportReceipt,
  observedAt: number,
): SessionTransition {
  let next: SessionProjectionState = {
    ...state,
    ...(receipt.conversationId ? { conversationId: receipt.conversationId } : {}),
  };
  let settlement: ChatTurnSettlement;
  if (next.run.phase === "terminal") {
    settlement = next.run.settlement;
  } else {
    const failure: ChatRequestFailure = {
      message: "Streamer returned without a terminal AG-UI event",
      code: "missing_terminal_event",
    };
    next = retainVisiblePartial(next);
    next = applyLocalAction(next, { type: "LOCAL_ERROR", message: failure.message }, observedAt);
    settlement = { outcome: "failed", failure };
  }
  const outputs: readonly SessionOutput[] =
    settlement.outcome === "failed"
      ? [
          { type: "request-failed", failure: settlement.failure },
          { type: "turn-settled", settlement },
        ]
      : [{ type: "turn-settled", settlement }];
  const { activeRequestId: _activeRequestId, ...settled } = next;
  return { state: { ...settled, run: { phase: "idle" } }, outputs };
}

function failTransport(
  state: SessionProjectionState,
  failure: ChatRequestFailure,
  observedAt: number,
): SessionTransition {
  let next = retainVisiblePartial(state);
  const settlement: ChatTurnSettlement =
    next.run.phase === "terminal" && next.run.settlement.outcome === "failed"
      ? next.run.settlement
      : { outcome: "failed", failure };
  next = applyLocalAction(
    next,
    { type: "LOCAL_ERROR", message: settlement.failure.message },
    observedAt,
  );
  const { activeRequestId: _activeRequestId, ...failed } = next;
  return {
    state: { ...failed, run: { phase: "idle" } },
    outputs: [
      { type: "request-failed", failure: settlement.failure },
      { type: "turn-settled", settlement },
    ],
  };
}

function hydrate(
  state: SessionProjectionState,
  input: Extract<SessionInput, { type: "hydrate" }>,
): SessionTransition {
  let view = createInitialChatStateInternal();
  for (const event of input.events) {
    view = foldChatState(view, event, input.observedAt);
  }
  const synchronized = synchronizeHistory(input.history, view.messages);
  const history = synchronized.history;
  return {
    state: {
      ...state,
      view,
      history,
      run: { phase: "idle" },
      openCalls: unresolvedCalls(history),
      ...(input.replayState ? { replayState: input.replayState } : {}),
    },
    outputs: [],
  };
}

export function transitionSession(
  state: SessionProjectionState,
  input: SessionInput,
): SessionTransition {
  switch (input.type) {
    case "hydrate":
      return hydrate(state, input);
    case "command":
      return transitionCommand(state, input);
    case "stream-event":
      return input.requestId === state.activeRequestId
        ? transitionStreamEvent(state, input.event, input.observedAt)
        : { state, outputs: [] };
    case "transport-drained":
      return input.requestId === state.activeRequestId
        ? settleTransport(state, input.receipt, input.observedAt)
        : { state, outputs: [] };
    case "transport-failed":
      return input.requestId === state.activeRequestId
        ? failTransport(state, input.failure, input.observedAt)
        : { state, outputs: [] };
  }
}
