import { createSignal, type Operation } from "effection";
import { assertJson, type Json } from "@sweatpants/foundation";
import {
  createClientElicitDispatcher,
  createPluginRegistryFrom,
  type ClientElicitDispatcher,
  type ClientPlugin,
  type RawClientElicit,
} from "@sweatpants/tool-session/mcp";
import type {
  ChatInteractionCompletion,
  ChatInteractionRequest,
  ChatInteractionRuntime,
  ChatLocalPart,
  ChatClient,
  ChatMessage,
} from "@sweatpants/chat-client";

export type TerminalPromptResult =
  | { readonly action: "accept"; readonly value: string }
  | { readonly action: "decline" }
  | { readonly action: "cancel" };

export interface TerminalElicitCapabilities {
  readonly signal: AbortSignal;
  promptText(input: { readonly message: string }): Operation<TerminalPromptResult>;
}

export interface TerminalPromptPart extends ChatLocalPart {
  readonly type: "terminal-prompt";
  readonly parentElicitId: string;
  readonly state: "pending" | "completed";
  readonly message: string;
  readonly response?: string;
}

export type TerminalChatClient = ChatClient<ChatMessage<TerminalPromptPart>>;

export interface TerminalInteractionOptions {
  readonly plugins?: readonly ClientPlugin<TerminalElicitCapabilities>[];
}

interface PromptResponder {
  readonly elicitId: string;
  readonly partId: string;
  respond(result: TerminalPromptResult): void;
}

function completionContent(value: unknown): Json {
  return assertJson(value);
}

export class TerminalInteractionRuntime implements ChatInteractionRuntime<TerminalPromptPart> {
  private readonly listeners = new Set<() => void>();
  private readonly records = new Map<string, TerminalPromptPart[]>();
  private readonly responders = new Map<string, PromptResponder>();
  private readonly hostSettled = new Set<string>();
  private readonly sequence = new Map<string, number>();
  private readonly dispatcher: ClientElicitDispatcher;
  private completionHandler:
    | ((request: ChatInteractionRequest, completion: ChatInteractionCompletion) => void)
    | null = null;
  private disposed = false;

  constructor(options: TerminalInteractionOptions = {}) {
    const registry = createPluginRegistryFrom(
      (options.plugins ?? []).map((plugin) => plugin.client),
    );
    this.dispatcher = createClientElicitDispatcher<TerminalElicitCapabilities>({
      registry,
      createCapabilities: (request, _binding, signal) => this.capabilities(request, signal),
      onCompletion: (request, completion) => {
        if (!this.completionHandler) {
          return;
        }
        const normalized: ChatInteractionCompletion =
          completion.action === "accept"
            ? { action: "accept", content: completionContent(completion.content) }
            : completion.action === "decline"
              ? { action: "decline" }
              : { action: "cancel" };
        this.completionHandler(request, normalized);
      },
      onDiagnostic: () => this.notify(),
    });
  }

  get activePrompt(): TerminalPromptPart | null {
    for (const parts of this.records.values()) {
      const prompt = parts.find((part) => part.state === "pending");
      if (prompt) {
        return prompt;
      }
    }
    return null;
  }

  observe(request: ChatInteractionRequest): void {
    if (!this.disposed && !this.hostSettled.has(request.elicitId)) {
      this.dispatcher.observe(request);
    }
  }

  settled(elicitId: string): void {
    this.hostSettled.add(elicitId);
    this.dispatcher.settled(elicitId);
    this.remove(elicitId);
  }

  cancel(elicitId: string): void {
    this.hostSettled.add(elicitId);
    this.dispatcher.cancel(elicitId);
    this.remove(elicitId);
  }

  localParts(): ReadonlyMap<string, readonly TerminalPromptPart[]> {
    return this.records;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setOnCompletion(
    handler: (request: ChatInteractionRequest, completion: ChatInteractionCompletion) => void,
  ): void {
    this.completionHandler = handler;
  }

  respond(value: string): void {
    this.complete({ action: "accept", value });
  }

  decline(): void {
    this.complete({ action: "decline" });
  }

  cancelActive(): void {
    this.complete({ action: "cancel" });
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.dispatcher.dispose();
    this.records.clear();
    this.responders.clear();
    this.hostSettled.clear();
    this.listeners.clear();
  }

  private capabilities(request: RawClientElicit, signal: AbortSignal): TerminalElicitCapabilities {
    return {
      signal,
      promptText: (input) => this.promptText(request, input.message, signal),
    };
  }

  private promptText(
    request: RawClientElicit,
    message: string,
    signal: AbortSignal,
  ): Operation<TerminalPromptResult> {
    return (function* (runtime: TerminalInteractionRuntime): Operation<TerminalPromptResult> {
      const sequence = runtime.sequence.get(request.elicitId) ?? 0;
      runtime.sequence.set(request.elicitId, sequence + 1);
      const partId = `${request.elicitId}:terminal-prompt:${sequence}`;
      const response = createSignal<TerminalPromptResult, void>();
      const part: TerminalPromptPart = Object.freeze({
        type: "terminal-prompt",
        id: partId,
        parentElicitId: request.elicitId,
        state: "pending",
        message,
      });
      runtime.records.set(request.elicitId, [
        ...(runtime.records.get(request.elicitId) ?? []),
        part,
      ]);
      runtime.responders.set(partId, {
        elicitId: request.elicitId,
        partId,
        respond(result) {
          if (!signal.aborted && !runtime.disposed) {
            response.send(result);
          }
        },
      });
      runtime.notify();
      const subscription = yield* response;
      const next = yield* subscription.next();
      return next.done ? { action: "cancel" } : next.value;
    })(this);
  }

  private complete(result: TerminalPromptResult): void {
    const prompt = this.activePrompt;
    if (!prompt) {
      return;
    }
    const responder = this.responders.get(prompt.id);
    if (!responder) {
      return;
    }
    this.responders.delete(prompt.id);
    const parts = this.records.get(responder.elicitId) ?? [];
    this.records.set(
      responder.elicitId,
      parts.map((part) =>
        part.id === responder.partId
          ? Object.freeze({
              ...part,
              state: "completed" as const,
              ...(result.action === "accept" ? { response: result.value } : {}),
            })
          : part,
      ),
    );
    responder.respond(result);
    this.notify();
  }

  private remove(elicitId: string): void {
    for (const [partId, responder] of this.responders) {
      if (responder.elicitId === elicitId) {
        this.responders.delete(partId);
      }
    }
    this.records.delete(elicitId);
    this.notify();
  }

  private notify(): void {
    // eslint-disable-next-line unicorn/no-useless-spread -- Subscription mutation must not alter this notification set.
    for (const listener of [...this.listeners]) {
      listener();
    }
  }
}
