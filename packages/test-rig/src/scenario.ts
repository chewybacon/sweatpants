import { call, run, type Operation } from "effection";
import type {
  ConversationHandle,
  ConversationOptions,
  ConversationTranscript,
  ElicitBarrier,
  TextDeltaBarrier,
  TurnHandle,
  TurnTranscript,
} from "./chat.ts";
import type {
  CapturedModelRequest,
  PendingModelRequest,
  RequestExpectation,
  SimulatedProviderError,
  SimulatedToolCall,
} from "./model.ts";
import type {
  OpenStreamTurnOptions,
  StreamCheckpoint,
  StreamFrame,
  StreamTurnHandle,
} from "./transport.ts";
import type { TestRig } from "./index.ts";

/**
 * Scenario scripts: causal-order, generator-driven test choreography.
 *
 * Instead of arming barriers before acting (promise style), a script performs
 * an action and then asks for its consequence:
 *
 * ```ts
 * await scenario(rig, function* (s) {
 *   const conv = s.conversation({ tools: [bookingTool] });
 *   const turn = yield* conv.send("Book NYC to LAX.");
 *
 *   const first = yield* s.model.request();
 *   yield* first.respond.toolCalls([{ id, name, arguments: { ... } }]);
 *
 *   const pickFlight = yield* turn.elicit("pickFlight");
 *   yield* pickFlight.accept({ flightId: "FL001" });
 *
 *   const final = yield* s.model.request();
 *   yield* final.respond.text("Done.");
 *   yield* turn.settled();
 * });
 * ```
 *
 * This works without races because the rig buffers: provider requests queue in
 * the model simulator (`unmatchedRequests: "buffer"`) and elicitations queue in
 * the conversation until the script consumes them. Asking late loses nothing.
 *
 * Scripts run inside an Effection scope, so concurrent choreography (for
 * example awaiting a provider abort while cancelling a turn) composes with
 * plain `spawn`.
 */

/** Manual text-stream controls as Effection operations. */
export interface ScriptTextStream {
  releaseNext(): Operation<void>;
  finish(): Operation<void>;
  fail(error: SimulatedProviderError): Operation<void>;
  disconnect(): Operation<void>;
}

/** A provider request handle whose respond controls are Effection operations. */
export interface ScriptModelRequest {
  readonly body: PendingModelRequest["body"];
  readonly headers: PendingModelRequest["headers"];
  readonly pullId: string;
  readonly respond: {
    text(text: string): Operation<void>;
    /** Begin a manual chunked text stream; deltas flow via the controller. */
    textStream(chunks: readonly string[]): Operation<ScriptTextStream>;
    toolCalls(
      calls: readonly SimulatedToolCall[],
      options?: { argumentChunkSize?: number },
    ): Operation<void>;
    textAndToolCalls(text: string, calls: readonly SimulatedToolCall[]): Operation<void>;
    malformedToolCall(call: { id: string; name: string; arguments: string }): Operation<void>;
    error(error: SimulatedProviderError): Operation<void>;
    /** Suspend until the framework aborts this in-flight provider request. */
    awaitAbort(): Operation<void>;
  };
}

/** An elicitation handle whose answer controls are Effection operations. */
export interface ScriptElicit {
  readonly key: string;
  readonly context: unknown;
  accept(content?: unknown): Operation<void>;
  decline(): Operation<void>;
  cancel(): Operation<void>;
}

/** One user turn: consequences are consumed from the turn that caused them. */
export type FailureExpectation = string | RegExp | ((error: Error) => void);

export interface ScriptTurn {
  /** Consume the next elicitation with this key (buffered or future). */
  elicit(key: string): Operation<ScriptElicit>;
  /** Wait for a streamed text delta matching the expectation. */
  textDelta(expectation: string | RegExp | ((delta: string) => void)): Operation<TextDeltaBarrier>;
  /** Wait for the turn to settle successfully and return its transcript. */
  settled(): Operation<TurnTranscript>;
  /** Wait for the turn to fail and optionally validate the failure. */
  failure(expectation?: FailureExpectation): Operation<Error>;
  /** Cancel this turn and wait for server-side cancellation to settle. */
  cancel(): Operation<void>;
}

export interface ScriptConversation {
  readonly conversationId: string;
  /** Send a user message, starting a turn. Fails if a turn is already active. */
  send(message: string): Operation<ScriptTurn>;
  /** Cancel-on-send: replace the active turn with a new user message. */
  supersede(message: string): Operation<ScriptTurn>;
  /** Recreate the client session, retaining durable conversation identity. */
  reopen(): Operation<ScriptConversation>;
  transcript(): ConversationTranscript;
}

export interface ScriptStreamTurn {
  readonly sessionId: string;
  readonly events: readonly StreamFrame[];
  event(type: string, assertion?: (event: StreamFrame["event"]) => void): Operation<StreamFrame>;
  checkpoint(): StreamCheckpoint;
  disconnect(): Operation<void>;
  complete(): Operation<readonly StreamFrame[]>;
}

export interface ScenarioContext {
  /** Open (or reuse) a conversation. */
  conversation(options?: ConversationOptions): ScriptConversation;
  readonly model: {
    /**
     * Consume the oldest unconsumed provider request, or wait for the next.
     * The optional expectation validates the consumed request; it never skips.
     */
    request(expectation?: RequestExpectation): Operation<ScriptModelRequest>;
    requests(): readonly CapturedModelRequest[];
  };
  readonly streams: {
    openTurn(options: OpenStreamTurnOptions): Operation<ScriptStreamTurn>;
    reconnect(checkpoint: StreamCheckpoint): Operation<ScriptStreamTurn>;
  };
}

function op<T>(make: () => Promise<T>): Operation<T> {
  return call(make);
}

function toScriptRequest(request: PendingModelRequest): ScriptModelRequest {
  return {
    body: request.body,
    headers: request.headers,
    pullId: request.pullId,
    respond: {
      text: (text) => op(() => request.respond.text(text)),
      *textStream(chunks) {
        const controller = yield* op(() => request.respond.text({ chunks, release: "manual" }));
        return {
          releaseNext: () => op(() => controller.releaseNext()),
          finish: () => op(() => controller.finish()),
          fail: (error) => op(() => controller.fail(error)),
          disconnect: () => op(() => controller.disconnect()),
        };
      },
      toolCalls: (calls, options) => op(() => request.respond.toolCalls(calls, options)),
      textAndToolCalls: (text, calls) => op(() => request.respond.textAndToolCalls(text, calls)),
      malformedToolCall: (call_) => op(() => request.respond.malformedToolCall(call_)),
      error: (error) => op(() => request.respond.error(error)),
      awaitAbort: () => op(() => request.respond.awaitAbort()),
    },
  };
}

function toScriptElicit(barrier: ElicitBarrier): ScriptElicit {
  return {
    key: barrier.key,
    context: barrier.context,
    accept: (content) => op(() => barrier.accept(content)),
    decline: () => op(() => barrier.decline()),
    cancel: () => op(() => barrier.cancel()),
  };
}

function assertFailure(error: Error, expectation?: FailureExpectation): void {
  if (expectation === undefined) {
    return;
  }
  if (typeof expectation === "string") {
    if (!error.message.includes(expectation)) {
      throw new Error(
        `expected failure containing ${JSON.stringify(expectation)}, got: ${error.message}`,
      );
    }
  } else if (expectation instanceof RegExp) {
    if (!expectation.test(error.message)) {
      throw new Error(`expected failure matching ${expectation}, got: ${error.message}`);
    }
  } else {
    expectation(error);
  }
}

function toScriptTurn(turn: TurnHandle, label: string): ScriptTurn {
  return {
    *elicit(key) {
      const barrier = yield* op(() => turn.expectElicit(key));
      return toScriptElicit(barrier);
    },
    textDelta: (expectation) => op(() => turn.expectTextDelta(expectation)),
    settled: () => op(() => turn.complete()),
    *failure(expectation) {
      try {
        yield* op(() => turn.complete());
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        assertFailure(failure, expectation);
        return failure;
      }
      throw new Error(`scenario: expected turn ${label} to fail, but it settled successfully`);
    },
    cancel: () => op(() => turn.cancel()),
  };
}

function toScriptStream(turn: StreamTurnHandle): ScriptStreamTurn {
  return {
    sessionId: turn.sessionId,
    get events() {
      return turn.events;
    },
    event: (type, assertion) => op(() => turn.expectEvent(type, assertion)),
    checkpoint: () => turn.checkpoint(),
    disconnect: () => op(() => turn.disconnect()),
    complete: () => op(() => turn.complete()),
  };
}

function toScriptConversation(conversation: ConversationHandle): ScriptConversation {
  return {
    conversationId: conversation.conversationId,
    *send(message) {
      return toScriptTurn(conversation.send(message), JSON.stringify(message));
    },
    *supersede(message) {
      return toScriptTurn(conversation.supersede(message), JSON.stringify(message));
    },
    *reopen() {
      return toScriptConversation(yield* op(() => conversation.reopen()));
    },
    transcript: () => conversation.transcript(),
  };
}

/**
 * Run a causal-order scenario script against the rig.
 *
 * `withTestScenario` enables the default buffered provider-request mode so
 * requests queue until the script consumes them. Direct `scenario(rig, ...)`
 * callers must not construct the rig with `unmatchedRequests: "poison"`.
 */
export function scenario<T>(
  rig: TestRig,
  script: (s: ScenarioContext) => Operation<T>,
): Promise<T> {
  const context: ScenarioContext = {
    conversation: (options) => toScriptConversation(rig.chat.conversation(options)),
    model: {
      *request(expectation) {
        const request = yield* op(() => rig.model.nextRequest(expectation));
        return toScriptRequest(request);
      },
      requests: () => rig.model.requests(),
    },
    streams: {
      *openTurn(options) {
        return toScriptStream(yield* op(() => rig.streams.openTurn(options)));
      },
      *reconnect(checkpoint) {
        return toScriptStream(yield* op(() => rig.streams.reconnect(checkpoint)));
      },
    },
  };
  return run(() => script(context));
}
