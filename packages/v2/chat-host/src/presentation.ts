import type { ExecutionPresentationFrame } from "@sweatpan.ts/hosting";
import type { ChatLoopRequest, ChatLoopSample } from "@sweatpan.ts/chat";
import type { ChatToolCall } from "@sweatpan.ts/providers";

type Correlation = {
  readonly toolCallId: string;
  readonly name: string;
  readonly parentExecutionId: string;
  readonly nested?: boolean;
};
export type ChatPresentationEvent = {
  readonly id: string;
  readonly executionId: string;
  readonly replay: boolean;
} & (
  | {
      readonly kind: "sample";
      readonly round: number;
      readonly state: "accepted";
      readonly text: string;
      readonly model: ChatLoopSample["model"];
      readonly usage: ChatLoopSample["response"]["usage"];
      readonly stopReason: ChatLoopSample["response"]["stopReason"];
    }
  | { readonly kind: "sample"; readonly round: number; readonly state: "rejected" }
  | ({ readonly kind: "call"; readonly input: unknown } & Correlation)
  | ({
      readonly kind: "tool";
      readonly state: "running" | "waiting" | "completed" | "cancelled";
      readonly question?: unknown;
    } & Correlation)
  | ({ readonly kind: "result"; readonly value: unknown } & Correlation)
  | {
      readonly kind: "operation";
      readonly toolCallId?: string;
      readonly effect: string;
      readonly state: "started" | "accepted" | "delivery_failed";
      readonly input?: unknown;
      readonly outcome?: unknown;
      readonly sequence?: number;
      readonly receipt?: string;
    }
);
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function unwrap(value: unknown): unknown {
  return record(value) && value.ok === true ? value.value : value;
}

/** Recorded-chat/v1 projection, shared by live presentation and retained replay.
 * program is the full ChatProgram.id; execution identifies its root journal.
 * Native requests remain trusted application data. Provider context, continuation
 * envelopes and reasoning are deliberately excluded. Consumers own disclosure. */
export function createChatPresentation(options: {
  readonly program: string;
  readonly execution: string;
  readonly emit: (event: ChatPresentationEvent) => void;
}) {
  const modelCalls = new Map<string, Correlation>();
  const children = new Map<string, Correlation>();
  const emitted = new Set<string>();
  const sampleEffect = options.program + "/sample",
    toolsEffect = options.program + "/tools";
  function emit(event: ChatPresentationEvent) {
    const key = event.kind + ":" + event.id;
    if (!emitted.has(key)) {
      emitted.add(key);
      options.emit(structuredClone(event));
    }
  }
  function request(value: unknown) {
    return record(value) && typeof value.effect === "string"
      ? { effect: value.effect, input: value.input }
      : undefined;
  }
  return {
    present(frame: ExecutionPresentationFrame): void {
      const executionId = frame.execution,
        replay = frame.replay;
      if (frame.kind === "accepted") {
        const entry = frame.entry,
          req = request(entry.request);
        if (!req) {
          return;
        }
        const id = `${executionId}:${entry.sequence}:${entry.receipt}`;
        if (executionId === options.execution && req.effect === sampleEffect) {
          const input = req.input as ChatLoopRequest;
          const sample = unwrap(unwrap(entry.outcome)) as ChatLoopSample | undefined;
          if (!sample?.response) {
            emit({
              kind: "sample",
              id,
              executionId,
              replay,
              round: input.round + 1,
              state: "rejected",
            });
            return;
          }
          emit({
            kind: "sample",
            id,
            executionId,
            replay,
            round: input.round + 1,
            state: "accepted",
            text: sample.response.message.content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join(""),
            model: sample.model,
            usage: sample.response.usage,
            stopReason: sample.response.stopReason,
          });
          for (const [index, part] of sample.response.message.content.entries()) {
            if (part.type !== "tool-call") {
              continue;
            }
            const call = part.toolCall;
            const correlation = {
              toolCallId: `${executionId}:sample:${entry.sequence}:call:${index}`,
              name: call.name,
              parentExecutionId: executionId,
            };
            modelCalls.set(call.id, correlation);
            emit({
              kind: "call",
              id: correlation.toolCallId,
              executionId,
              replay,
              ...correlation,
              input: call.input,
            });
          }
        } else if (req.effect !== toolsEffect) {
          emit({
            kind: "operation",
            id,
            executionId,
            replay,
            toolCallId: children.get(executionId)?.toolCallId,
            effect: req.effect,
            state: "accepted",
            sequence: entry.sequence,
            receipt: entry.receipt,
            input: req.input,
            outcome: entry.outcome,
          });
        }
      } else if (frame.kind === "children") {
        const req = request(frame.request);
        for (const [index, child] of frame.children.entries()) {
          const parent = children.get(executionId);
          const call =
            executionId === options.execution && req?.effect === toolsEffect
              ? modelCalls.get((req.input as readonly ChatToolCall[])[index]!.id)
              : parent && { ...parent, parentExecutionId: executionId, nested: true };
          if (call) {
            children.set(child.childId, call);
          }
        }
      } else if (frame.kind === "state") {
        const call = children.get(executionId);
        if (!call) {
          return;
        }
        const state = frame.state;
        emit({
          kind: "tool",
          id: `${executionId}:${state.revision}`,
          executionId,
          replay,
          ...call,
          state:
            state.status === "running"
              ? state.interaction?.state === "waiting"
                ? "waiting"
                : "running"
              : state.status,
          question:
            state.status === "running" && state.interaction?.state === "waiting"
              ? request(state.pending?.request)?.input
              : undefined,
        });
        if (state.status === "completed" && !call.nested) {
          emit({
            kind: "result",
            id: call.toolCallId,
            executionId,
            replay,
            ...call,
            value: state.value,
          });
        }
      } else {
        const req = request(frame.request);
        if (!req) {
          return;
        }
        emit({
          kind: "operation",
          id: `${executionId}:${frame.requestId}:${frame.phase}`,
          executionId,
          replay,
          toolCallId: children.get(executionId)?.toolCallId,
          effect: req.effect,
          state: frame.phase === "started" ? "started" : "delivery_failed",
          input:
            req.effect === sampleEffect
              ? { round: (req.input as ChatLoopRequest).round + 1 }
              : req.input,
        });
      }
    },
  };
}
