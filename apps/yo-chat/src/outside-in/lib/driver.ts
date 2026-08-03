/** Headless outside-in flow driver over the public ChatClient. */
import { EventType } from "@ag-ui/core";
import {
  createChatClient,
  type ChatEventMiddleware,
  type ChatFetch,
  type ChatInteractionCompletion,
  type ChatInteractionRequest,
  type ChatInteractionRuntime,
} from "@sweatpants/chat-client";
import { assertJson } from "@sweatpants/foundation";
import type { ChatBinding } from "./chat-fetch.ts";
import { createTranscriptCollector, normalizeStreamEvent, type Transcript } from "./transcript.ts";

export type ElicitReply =
  | { action: "accept"; content: unknown }
  | { action: "decline" }
  | { action: "cancel" }
  | null;

export interface FlowElicitRequest {
  readonly key: string;
  readonly elicitId: string;
  readonly context: unknown;
}

export type ElicitResponder = (elicit: FlowElicitRequest) => ElicitReply | Promise<ElicitReply>;

export interface ChatTurn {
  message: string;
  respondToElicit?: ElicitResponder;
  onSettled?: (transcript: Transcript) => void;
}

export interface RunChatFlowOptions {
  turns: Iterable<ChatTurn> | AsyncIterable<ChatTurn>;
  conversationId?: string;
  systemPrompt?: string;
  initialToolChoice?: "auto" | "none" | "required";
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = Number.parseInt(
  process.env["OUTSIDE_IN_FLOW_TIMEOUT_MS"] ?? "90000",
  10,
);

function asyncTurnIterator(
  turns: Iterable<ChatTurn> | AsyncIterable<ChatTurn>,
): AsyncIterator<ChatTurn> {
  const asyncFactory = (turns as AsyncIterable<ChatTurn>)[Symbol.asyncIterator];
  if (typeof asyncFactory === "function") {
    return asyncFactory.call(turns);
  }
  const iterator = (turns as Iterable<ChatTurn>)[Symbol.iterator]();
  const return_ = iterator.return?.bind(iterator);
  return {
    next: async () => iterator.next(),
    ...(return_ ? { return: async () => return_() } : {}),
  };
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}

function requestOptionsFetch(
  binding: ChatBinding,
  conversationId: string,
  options: RunChatFlowOptions,
): ChatFetch {
  return async (input, init) => {
    if ((init?.method === undefined || init.method === "POST") && typeof init?.body === "string") {
      try {
        const body = JSON.parse(init.body) as Record<string, unknown>;
        body["threadId"] = conversationId;
        body["conversationId"] = conversationId;
        if (options.systemPrompt !== undefined) {
          body["systemPrompt"] = options.systemPrompt;
        }
        if (options.initialToolChoice !== undefined) {
          body["initialToolChoice"] = options.initialToolChoice;
        }
        return binding.fetch(input, { ...init, body: JSON.stringify(body) });
      } catch {
        // Non-JSON requests pass through unchanged.
      }
    }
    return binding.fetch(input, init);
  };
}

function completion(reply: Exclude<ElicitReply, null>): ChatInteractionCompletion {
  return reply.action === "accept"
    ? { action: "accept", content: assertJson(reply.content) }
    : reply;
}

export async function runChatFlow(
  binding: ChatBinding,
  options: RunChatFlowOptions,
): Promise<Transcript> {
  const collector = createTranscriptCollector();
  const conversationId = options.conversationId ?? crypto.randomUUID();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let active:
    | {
        readonly responder: ElicitResponder;
        readonly settled: Deferred<void>;
        leaveInterrupted: boolean;
        outcome?: "success" | "error" | "interrupt";
      }
    | undefined;
  let completionHandler:
    | ((request: ChatInteractionRequest, completion: ChatInteractionCompletion) => void)
    | undefined;

  const interaction: ChatInteractionRuntime = {
    observe(request) {
      if (!active) {
        return;
      }
      collector.recordElicit({
        key: request.key,
        callId: request.callId,
        elicitId: request.elicitId,
        toolName: request.toolName,
      });
      void Promise.resolve(
        active.responder({
          key: request.key,
          elicitId: request.elicitId,
          context: request.context,
        }),
      )
        .then((reply) => {
          if (reply === null) {
            if (active) {
              active.leaveInterrupted = true;
            }
            return undefined;
          }
          if (!completionHandler) {
            throw new Error("Outside-in interaction runtime has no completion handler");
          }
          completionHandler(request, completion(reply));
          return undefined;
        })
        .catch((error) => {
          active?.settled.reject(error);
          return undefined;
        });
    },
    settled() {},
    cancel() {},
    localParts: () => new Map(),
    onChange: () => () => undefined,
    setOnCompletion(handler) {
      completionHandler = handler;
    },
    dispose() {
      completionHandler = undefined;
    },
  };

  const eventMiddleware: ChatEventMiddleware = {
    *accept(args, next) {
      const event = args[0];
      const normalized = normalizeStreamEvent(event);
      if (normalized && normalized.type !== "elicit") {
        collector.push(normalized);
      }
      yield* next(...args);
      if (!active) {
        return;
      }
      if (event.type === EventType.RUN_ERROR) {
        active.outcome = "error";
      } else if (event.type === EventType.RUN_FINISHED) {
        if (event.outcome?.type !== "interrupt") {
          active.outcome = "success";
        } else if (active.leaveInterrupted) {
          active.outcome = "interrupt";
        }
      }
    },
  };

  const client = createChatClient({
    threadId: conversationId,
    api: binding.baseUrl,
    fetcher: requestOptionsFetch(binding, conversationId, options),
    eventMiddleware: [eventMiddleware],
    interaction,
  });
  const unsubscribe = client.subscribe(() => {
    const status = client.getSnapshot().status;
    if (active?.outcome && (status === "ready" || status === "error")) {
      active.settled.resolve(undefined);
    }
  });

  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutTimer = setTimeout(
      () => reject(new Error(`[outside-in:${binding.tier}] flow timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });

  try {
    await client.initialized;
    const turns = asyncTurnIterator(options.turns);
    const execute = async (): Promise<Transcript> => {
      let transcript = collector.build("success");
      let next = await turns.next();
      while (!next.done) {
        const turn = next.value;
        const settled = deferred<void>();
        active = {
          responder: turn.respondToElicit ?? (() => ({ action: "decline" })),
          settled,
          leaveInterrupted: false,
        };
        void client.sendMessage({ text: turn.message }).catch((error) => settled.reject(error));
        await settled.promise;
        transcript = collector.build(active.outcome ?? "success");
        active = undefined;
        turn.onSettled?.(transcript);
        next = await turns.next();
      }
      return transcript;
    };
    return await Promise.race([execute(), timeout]);
  } finally {
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
    }
    unsubscribe();
    await client.close();
  }
}
