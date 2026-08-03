/**
 * Headless chat-flow driver for the outside-in tier (design R4/R5).
 *
 * Drives one or more chat turns through the universal fetch seam using the REAL
 * client session (`createChatSession` + `api-transport`), captures the AG-UI/SSE
 * event stream into a normalized {@link Transcript}, and resolves elicit
 * interrupts by posting public `resume` follow-ups through the same seam until
 * the run completes or the next interrupt appears.
 *
 * No browser, no DOM, no `networkidle`. The driver never fakes model responses;
 * it only supplies the elicit answers a human would click.
 */
import { call, run, sleep, spawn, each, type Operation } from "effection";
import { createChatSession, type ChatState, type ElicitState } from "@sweatpants/chat-core";
import { withChatFetch, type ChatBinding, type ChatFetch } from "./chat-fetch.ts";
import { createTranscriptCollector, normalizeStreamEvent, type Transcript } from "./transcript.ts";

/** A reply to a single elicit request. `null` means "stop, do not answer". */
export type ElicitReply =
  | { action: "accept"; content: unknown }
  | { action: "decline" }
  | { action: "cancel" }
  | null;

/** Given a pending elicit (with its context), decide how to answer. */
export type ElicitResponder = (elicit: ElicitState) => ElicitReply | Promise<ElicitReply>;

export interface ChatTurn {
  /** User message content for this turn. */
  message: string;
  /**
   * How to answer elicit interrupts raised during this turn. Defaults to
   * declining every elicit, which keeps flows that expect no elicits honest.
   */
  respondToElicit?: ElicitResponder;
  /** Test-driver lifecycle hook invoked after this turn reaches a quiet boundary. */
  onSettled?: (transcript: Transcript) => void;
}

export interface RunChatFlowOptions {
  turns: Iterable<ChatTurn> | AsyncIterable<ChatTurn>;
  /**
   * Optional conversation ID. When omitted, the driver generates one so the
   * fold session persists across turns. The server also mints one when absent
   * and returns it in the X-Conversation-Id response header.
   */
  conversationId?: string;
  plugins?: unknown[];
  tools?: unknown[];
  enabledTools?: string[] | boolean;
  systemPrompt?: string;
  initialToolChoice?: "auto" | "none" | "required";
  /** Hard cap for the whole flow. */
  timeoutMs?: number;
  /** Quiet window (no streaming, no pending elicit) that marks a turn done. */
  settleMs?: number;
  /** Poll cadence while waiting for client state updates. */
  pollMs?: number;
}

const DEFAULT_TIMEOUT_MS = Number.parseInt(
  process.env["OUTSIDE_IN_FLOW_TIMEOUT_MS"] ?? "90000",
  10,
);
const DEFAULT_SETTLE_MS = Number.parseInt(process.env["OUTSIDE_IN_SETTLE_MS"] ?? "150", 10);
const DEFAULT_POLL_MS = Number.parseInt(process.env["OUTSIDE_IN_POLL_MS"] ?? "25", 10);

function firstPendingElicit(state: ChatState, responded: Set<string>): ElicitState | null {
  for (const tracking of Object.values(state.pendingElicits)) {
    for (const elicit of tracking.elicitations) {
      if (elicit.status === "pending" && !responded.has(elicit.elicitId)) {
        return elicit;
      }
    }
  }
  return null;
}

function hasUnresolvedElicit(state: ChatState): boolean {
  for (const tracking of Object.values(state.pendingElicits)) {
    for (const elicit of tracking.elicitations) {
      if (elicit.status === "pending") {
        return true;
      }
    }
  }
  return false;
}

function asyncTurnIterator(
  turns: Iterable<ChatTurn> | AsyncIterable<ChatTurn>,
): AsyncIterator<ChatTurn> {
  const asyncFactory = (turns as AsyncIterable<ChatTurn>)[Symbol.asyncIterator];
  if (typeof asyncFactory === "function") {
    return asyncFactory.call(turns);
  }
  const iterator = (turns as Iterable<ChatTurn>)[Symbol.iterator]();
  return {
    next: async () => iterator.next(),
    ...(iterator.return
      ? { return: async () => iterator.return!() as IteratorResult<ChatTurn> }
      : {}),
  };
}

/**
 * Execute a full chat flow through `binding`. Returns the normalized transcript.
 */
export async function runChatFlow(
  binding: ChatBinding,
  options: RunChatFlowOptions,
): Promise<Transcript> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const collector = createTranscriptCollector();

  const conversationId = options.conversationId ?? crypto.randomUUID();

  // Wrap the binding's fetch to inject the durable conversation ID into every
  // POST body that targets the chat endpoint. The server keys the fold session
  // log by conversationId only (AG-UI runId is ephemeral). We inject both
  // conversationId and threadId for wire compatibility, but avoid the session
  // option that triggers readDurableHistory GETs. External API calls (e.g. the
  // model provider's POST to Copilot) must NOT be modified.
  const wrappedFetch: ChatFetch = async (input, init) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (
      (init?.method === undefined || init.method === "POST") &&
      typeof init?.body === "string" &&
      (url.includes("/api/chat") || url.startsWith("/"))
    ) {
      try {
        const parsed = JSON.parse(init.body);
        parsed.threadId = conversationId;
        parsed.conversationId = conversationId;
        return binding.fetch(input, { ...init, body: JSON.stringify(parsed) });
      } catch {
        // Not JSON — pass through unchanged
      }
    }
    return binding.fetch(input, init);
  };

  return withChatFetch(wrappedFetch, () =>
    run(function* (): Operation<Transcript> {
      // Stable conversation identity is injected by the fetch wrapper above.
      // createChatSession intentionally does not take conversationId here —
      // that option triggers readDurableHistory GETs. Fold persistence only
      // needs the same conversationId on every chat POST.
      const session = yield* createChatSession({
        baseUrl: binding.baseUrl,
        ...(options.tools ? { tools: options.tools } : {}),
        ...(options.enabledTools !== undefined ? { enabledTools: options.enabledTools } : {}),
        ...(options.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
        ...(options.initialToolChoice ? { initialToolChoice: options.initialToolChoice } : {}),
        onStreamEvent: (entry) => {
          const normalized = normalizeStreamEvent(entry.event);
          if (normalized && normalized.type !== "elicit") {
            collector.push(normalized);
          }
        },
      });

      const stateRef: { current: ChatState | null } = { current: null };
      yield* spawn(function* () {
        for (const next of yield* each(session.state)) {
          stateRef.current = next;
          yield* each.next();
        }
      });

      // Wait for initial state to arrive.
      yield* sleep(0);

      const deadline = Date.now() + timeoutMs;
      const respondedElicits = new Set<string>();
      const turns = asyncTurnIterator(options.turns);

      function currentTranscript(): Transcript {
        const finalState = stateRef.current;
        const hadError = collector
          .build("success")
          .events.some((event) => event.type === "run_error");
        const outcome: Transcript["outcome"] = hadError
          ? "error"
          : finalState && hasUnresolvedElicit(finalState)
            ? "interrupt"
            : "success";
        return collector.build(outcome);
      }

      while (true) {
        const nextTurn = yield* call(() => turns.next());
        if (nextTurn.done) {
          break;
        }
        const turn = nextTurn.value;
        const respond = turn.respondToElicit ?? (() => ({ action: "decline" }));
        session.dispatch({ type: "send", content: turn.message });
        // Give the send a beat to flip busy before we poll for settle.
        yield* sleep(pollMs);

        let quietSince: number | null = null;
        while (true) {
          if (Date.now() > deadline) {
            throw new Error(`[outside-in:${binding.tier}] flow timed out after ${timeoutMs}ms`);
          }

          const state = stateRef.current;
          if (!state) {
            yield* sleep(pollMs);
            continue;
          }

          if (state.error) {
            throw new Error(`[outside-in:${binding.tier}] client error: ${state.error}`);
          }

          const pending = firstPendingElicit(state, respondedElicits);
          if (pending) {
            quietSince = null;
            respondedElicits.add(pending.elicitId);
            collector.recordElicit({
              key: pending.key,
              callId: pending.callId,
              elicitId: pending.elicitId,
              toolName: pending.toolName,
            });
            const reply = yield* call(() => Promise.resolve(respond(pending)));
            if (reply === null) {
              // Caller chose to leave this interrupt unanswered; end the turn
              // immediately. The next free-form send is expected to cancel it
              // (cancel-on-send). Do not wait for settle — the run is parked.
              break;
            }
            session.dispatch({
              type: "elicit_response",
              sessionId: pending.sessionId,
              callId: pending.callId,
              toolName: pending.toolName,
              elicitId: pending.elicitId,
              completion: reply,
              autoContinue: true,
            });
            yield* sleep(pollMs);
            continue;
          }

          if (!state.active) {
            const now = Date.now();
            if (quietSince === null) {
              quietSince = now;
            } else if (now - quietSince >= settleMs) {
              break;
            }
          } else {
            quietSince = null;
          }
          yield* sleep(pollMs);
        }
        turn.onSettled?.(currentTranscript());
      }

      return currentTranscript();
    }),
  );
}
