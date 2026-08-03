import { EventType } from "@ag-ui/core";
import {
  call,
  createScope,
  each,
  spawn,
  suspend,
  useAbortSignal,
  useScope,
  type Around,
  type Operation,
  type Scope,
  type Stream,
  type Task,
} from "effection";
import { asChatClientError, ChatClientError } from "./errors.ts";
import {
  ChatClientApi,
  ChatCommandContext,
  ChatEventApi,
  ChatEventContext,
  ChatSchedulerPort,
  ChatTransportPort,
  type ChatClientCommandContract,
  type ChatClientMiddleware,
  type ChatSchedulerContract,
  type ChatEventMiddleware,
  type ChatTransportMiddleware,
} from "./ports.ts";
import { createHttpTransport, type HttpTransportOptions } from "./http.ts";
import type {
  ClientChatMessage as ChatMessage,
  ChatLocalPart,
  ClientChatPart as ChatPart,
  ChatSendRequest,
  ClientChatSnapshot as ChatSnapshot,
  ChatStreamEvent,
  ChatTransportContract,
  ChatTransportControl,
  FramePipelineFactory,
  RegenerateOptions,
  SendMessageOptions,
  UserMessageInput,
  ChatWireMessage,
  ClientElicitFact,
  QueuedUserMessage,
} from "@sweatpants/chat-core";
import type { Json } from "@sweatpants/foundation";
import { createEagerBuffer } from "@sweatpants/foundation/stream";
import type { PipelineConfig, Processor, ProcessorPreset } from "./pipeline/types.ts";
import { createPipeline } from "./pipeline/runner.ts";
import { markdown } from "./pipeline/processors/markdown.ts";
import { shiki } from "./pipeline/processors/shiki.ts";
import { mermaid } from "./pipeline/processors/mermaid.ts";
import { math } from "./pipeline/processors/math.ts";
import { resolveProcessors, preloadProcessors } from "./pipeline/resolver.ts";
import { overlayLocalParts } from "./local-overlay.ts";
import { LiveChatCompactor, type LiveCompactorAction } from "./live-compactor.ts";

export type PipelinePreset = ProcessorPreset;

export interface ChatTransportOptions {
  readonly driver?: ChatTransportContract;
  readonly middleware?: readonly ChatTransportMiddleware[];
  readonly http?: HttpTransportOptions;
}

export type ChatInteractionRequest = ClientElicitFact;

export type ChatInteractionCompletion =
  | { readonly action: "accept"; readonly content: Json }
  | { readonly action: "decline" }
  | { readonly action: "cancel" };

export interface ChatInteractionRuntime<
  TLocalPart extends { readonly type: string; readonly id: string } = never,
> {
  observe(request: ChatInteractionRequest): void;
  settled(elicitId: string): void;
  cancel(elicitId: string): void;
  localParts(): ReadonlyMap<string, readonly TLocalPart[]>;
  onChange(listener: () => void): () => void;
  setOnCompletion(
    handler: (request: ChatInteractionRequest, completion: ChatInteractionCompletion) => void,
  ): void;
  dispose(): void;
}

export interface ChatClientOptions<
  TLocalPart extends { readonly type: string; readonly id: string } = never,
> {
  readonly conversationId: string;
  readonly clientId?: string;
  readonly transport?: ChatTransportOptions;
  readonly middleware?: readonly ChatClientMiddleware[];
  readonly eventMiddleware?: readonly ChatEventMiddleware[];
  readonly pipeline?: PipelineConfig | PipelinePreset | FramePipelineFactory;
  readonly scheduler?: ChatSchedulerDriver;
  readonly interaction?: ChatInteractionRuntime<TLocalPart>;
  readonly busy?: "queue" | "drop" | "interrupt";
  readonly setup?: () => Operation<void>;
  readonly initialize?: (client: ChatClientControl<TLocalPart>) => Operation<void>;
  readonly state?: Json;
  readonly context?: readonly { readonly description: string; readonly value: string }[];
  readonly forwardedProps?: Json;
}

export interface ChatRuntimeOptions {
  readonly transport?: ChatTransportOptions;
  readonly middleware?: readonly ChatClientMiddleware[];
  readonly eventMiddleware?: readonly ChatEventMiddleware[];
  readonly setup?: () => Operation<void>;
  readonly initialize?: (runtime: ChatRuntimeControl) => Operation<void>;
}

export interface ChatRuntimeControl {
  readonly initialized: Promise<void>;
  readonly scope: Scope;
}

export interface ChatClientControl<
  TLocalPart extends { readonly type: string; readonly id: string } = never,
> {
  readonly id: string;
  readonly conversationId: string;
  getSnapshot(): ChatSnapshot<ChatMessage<TLocalPart>>;
  reconnect(): Promise<void>;
}

export type ChatSchedulerDriver = ChatSchedulerContract;

export interface ChatClient<TMessage extends ChatMessage<ChatLocalPart> = ChatMessage> {
  readonly id: string;
  readonly conversationId: string;
  readonly initialized: Promise<void>;
  readonly transport: ChatTransportControl;
  getSnapshot(): ChatSnapshot<TMessage>;
  getServerSnapshot(): ChatSnapshot<TMessage>;
  subscribe(listener: () => void): () => void;
  sendMessage(input: UserMessageInput, options?: SendMessageOptions): Promise<void>;
  regenerate(options?: RegenerateOptions): Promise<void>;
  stop(): Promise<void>;
  reconnect(): Promise<void>;
  setMessages(
    update: readonly TMessage[] | ((current: readonly TMessage[]) => readonly TMessage[]),
  ): void;
  clearError(): void;
  close(): Promise<void>;
}

interface CommandEntry {
  run(): Promise<void>;
  reject(error: unknown): void;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolveValue!: (value: T) => void;
  let rejectValue!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolveValue = resolve;
    rejectValue = reject;
  });
  void promise.catch(() => undefined);
  return {
    promise,
    resolve: resolveValue,
    reject: rejectValue,
  };
}

function deepFreeze<T>(value: T, seen = new WeakSet()): T {
  if (value !== null && typeof value === "object") {
    const object = value as object;
    if (seen.has(object) || Object.isFrozen(object)) {
      return value;
    }
    seen.add(object);
    Object.freeze(object);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child, seen);
    }
  }
  return value;
}

function makeInitialSnapshot<TLocalPart extends ChatLocalPart = never>(): ChatSnapshot<
  ChatMessage<TLocalPart>
> {
  return deepFreeze({
    messages: Object.freeze([]),
    status: "ready" as const,
    connectionStatus: "disconnected" as const,
    renderStatus: "loading" as const,
    error: null,
    queuedMessages: Object.freeze([]),
  });
}

function pipelineProcessors(
  pipeline: PipelineConfig | PipelinePreset | FramePipelineFactory | undefined,
): readonly Processor[] | undefined {
  if (pipeline === undefined || typeof pipeline === "function") {
    return undefined;
  }
  if (typeof pipeline !== "string") {
    return typeof pipeline.processors === "string"
      ? pipelineProcessors(pipeline.processors)
      : pipeline.processors;
  }
  switch (pipeline) {
    case "markdown":
      return [markdown];
    case "shiki":
      return [markdown, shiki];
    case "mermaid":
      return [markdown, mermaid];
    case "math":
      return [markdown, math];
    case "full":
      return [markdown, shiki, mermaid, math];
  }
}

function defaultPipelineFactory(
  pipeline: PipelineConfig | PipelinePreset | undefined,
): FramePipelineFactory {
  const config: PipelineConfig =
    pipeline === undefined
      ? { processors: [markdown] }
      : typeof pipeline === "string"
        ? { processors: pipeline }
        : pipeline;
  return () => createPipeline(config);
}

function textFromInput(input: UserMessageInput): string {
  if ("text" in input) {
    return input.text;
  }
  return input.parts
    .filter(
      (part): part is { readonly type: "text"; readonly text: string } =>
        part.type === "text" && typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("");
}

function messageToWire(message: ChatMessage<ChatLocalPart>): ChatWireMessage | null {
  const text = message.parts
    .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");
  const toolCalls = message.parts
    .filter(
      (part): part is Extract<typeof part, { type: "tool-call" }> => part.type === "tool-call",
    )
    .map((part) => ({
      id: part.callId,
      type: "function" as const,
      function: {
        name: part.name,
        arguments: part.rawInput ?? JSON.stringify(part.input ?? {}),
      },
    }));
  if (message.role === "user" || message.role === "system") {
    return { id: message.id, role: message.role, content: text };
  }
  return {
    id: message.id,
    role: "assistant",
    ...(text.length > 0 ? { content: text } : {}),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
  };
}

function messagesToWire(
  messages: readonly ChatMessage<ChatLocalPart>[],
): readonly ChatWireMessage[] {
  return messages.flatMap((message) => {
    const wire = messageToWire(message);
    return wire ? [wire] : [];
  });
}

function lastRegeneratableMessageId<TLocalPart extends ChatLocalPart>(
  messages: readonly ChatMessage<TLocalPart>[],
): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === "assistant" || message.role === "user") {
      return message.id;
    }
  }
  return undefined;
}

function createUserWire(input: UserMessageInput): ChatWireMessage {
  return {
    id: input.id ?? crypto.randomUUID(),
    role: "user",
    content: textFromInput(input),
  };
}

function installMiddleware<T extends object>(
  api: { around(middleware: Partial<Around<T>>): Operation<void> },
  middleware: readonly Partial<Around<T>>[],
): Operation<void> {
  return (function* (): Operation<void> {
    for (const item of middleware) {
      yield* api.around(item);
    }
  })();
}

class ChatClientController<
  TLocalPart extends { readonly type: string; readonly id: string } = never,
> implements ChatClient<ChatMessage<TLocalPart>> {
  readonly id: string;
  readonly conversationId: string;
  readonly initialized: Promise<void>;
  readonly transport: ChatTransportControl;

  private readonly initWaiter = deferred<void>();
  private readonly parentScopeFactory: () => Scope;
  private readonly parentInitialized: Promise<void>;
  private readonly destroyParentScope: (() => Promise<void>) | null;
  private readonly options: ChatClientOptions<TLocalPart>;
  private readonly interaction: ChatInteractionRuntime<TLocalPart> | null;
  private interactionUnsubscribe: (() => void) | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly transportListeners = new Set<() => void>();
  private readonly commandQueue: CommandEntry[] = [];
  private readonly compactor: LiveChatCompactor;
  private pendingPublicationChanges: Partial<ChatSnapshot<ChatMessage<TLocalPart>>> = {};
  private snapshot: ChatSnapshot<ChatMessage<TLocalPart>> = makeInitialSnapshot<TLocalPart>();
  private serverSnapshot: ChatSnapshot<ChatMessage<TLocalPart>> = this.snapshot;
  private manualMessages: readonly ChatMessage<TLocalPart>[] | null = null;
  private queued: readonly QueuedUserMessage[] = [];
  private readonly queuedCompletions: Deferred<void>[] = [];
  private clientScope: Scope | null = null;
  private commandScope: Scope | null = null;
  private destroyClientScope: (() => Promise<void>) | null = null;
  private bootstrapTask: Task<void> | null = null;
  private activeTask: Task<void> | null = null;
  private activeRequest: ChatSendRequest | null = null;
  private readyForCommands = false;
  private initializedResolved = false;
  private closed = false;
  private closePromise: Promise<void> | null = null;
  private cursor: number | undefined;
  private readonly state: Json;
  private readonly context: readonly { readonly description: string; readonly value: string }[];
  private readonly forwardedProps: Json;

  constructor(
    bootstrapScope: Scope,
    parentInitialized: Promise<void>,
    options: ChatClientOptions<TLocalPart>,
    destroyParentScope: (() => Promise<void>) | null = null,
    parentScopeFactory: () => Scope = () => bootstrapScope,
  ) {
    this.parentScopeFactory = parentScopeFactory;
    this.parentInitialized = parentInitialized;
    this.destroyParentScope = destroyParentScope;
    this.options = options;
    this.interaction = options.interaction ?? null;
    this.id = options.clientId ?? crypto.randomUUID();
    this.conversationId = options.conversationId;
    this.initialized = this.initWaiter.promise;
    const pipelineFactory =
      typeof options.pipeline === "function"
        ? options.pipeline
        : defaultPipelineFactory(options.pipeline);
    this.compactor = new LiveChatCompactor(pipelineFactory);
    this.state = options.state ?? {};
    this.context = options.context ?? [];
    this.forwardedProps = options.forwardedProps ?? {};
    this.transport = {
      getSnapshot: () => ({ status: this.snapshot.connectionStatus, error: this.snapshot.error }),
      subscribe: (listener) => {
        this.transportListeners.add(listener);
        return () => this.transportListeners.delete(listener);
      },
      reconnect: () => this.reconnect(),
      disconnect: (reason) => this.enqueueCommand(() => this.disconnect(reason)),
    };
    if (this.interaction) {
      this.interaction.setOnCompletion((request, completion) => {
        void this.enqueueCommand(() => this.resumeElicit(request, completion)).catch(
          () => undefined,
        );
      });
      this.interactionUnsubscribe = this.interaction.onChange(() => this.publishProjection({}));
    }
    this.bootstrapTask = bootstrapScope.run(() => this.bootstrap());
  }

  getSnapshot(): ChatSnapshot<ChatMessage<TLocalPart>> {
    return this.snapshot;
  }

  getServerSnapshot(): ChatSnapshot<ChatMessage<TLocalPart>> {
    return this.serverSnapshot;
  }

  subscribe(listener: () => void): () => void {
    if (this.closed) {
      return () => undefined;
    }
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  sendMessage(input: UserMessageInput, options: SendMessageOptions = {}): Promise<void> {
    return this.enqueueCommand(() => ChatClientApi.operations.sendMessage(input, options));
  }

  regenerate(options: RegenerateOptions = {}): Promise<void> {
    return this.enqueueCommand(() => ChatClientApi.operations.regenerate(options));
  }

  stop(): Promise<void> {
    return this.enqueueCommand(() => ChatClientApi.operations.stop());
  }

  reconnect(): Promise<void> {
    return this.enqueueCommand(() => ChatClientApi.operations.reconnect());
  }

  setMessages(
    update:
      | readonly ChatMessage<TLocalPart>[]
      | ((current: readonly ChatMessage<TLocalPart>[]) => readonly ChatMessage<TLocalPart>[]),
  ): void {
    if (this.closed) {
      throw new ChatClientError("chat_client_closed", "Chat client is closed");
    }
    const current = this.manualMessages ?? this.snapshot.messages;
    this.manualMessages = deepFreeze([
      ...(typeof update === "function" ? update(current) : update),
    ]);
    this.publish({ messages: this.manualMessages }, false);
  }

  clearError(): void {
    if (this.closed) {
      throw new ChatClientError("chat_client_closed", "Chat client is closed");
    }
    this.publish({ error: null, status: "ready" });
  }

  close(): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }
    if (!this.readyForCommands) {
      this.closed = true;
      const failure = new ChatClientError(
        "chat_client_closed",
        "Chat client closed before initialization",
      );
      this.initWaiter.reject(failure);
      for (const entry of this.commandQueue.splice(0)) {
        entry.reject(failure);
      }
      this.closePromise = this.shutdownBeforeInitialization().then(() => undefined);
      return this.closePromise;
    }
    if (!this.initializedResolved) {
      const failure = new ChatClientError(
        "chat_client_closed",
        "Chat client closed before initialization",
      );
      this.initWaiter.reject(failure);
      for (const entry of this.commandQueue.splice(0)) {
        entry.reject(failure);
      }
    }
    const command = this.enqueueCommand(() => ChatClientApi.operations.close(), true);
    this.closePromise = command.then(() => this.shutdownAfterClose()).then(() => undefined);
    return this.closePromise;
  }

  private enqueueCommand(factory: () => Operation<void>, closing = false): Promise<void> {
    if (this.closed && !closing) {
      return Promise.reject(new ChatClientError("chat_client_closed", "Chat client is closed"));
    }
    if (!this.readyForCommands) {
      return new Promise<void>((resolve, reject) => {
        this.commandQueue.push({
          run: async () => {
            try {
              await this.runInClientScope(factory);
              resolve();
            } catch (error) {
              reject(error);
            }
          },
          reject,
        });
      });
    }
    return this.runInClientScope(factory);
  }

  private runInClientScope(factory: () => Operation<void>): Promise<void> {
    const scope = this.clientScope;
    if (!scope || (this.closed && !this.closePromise)) {
      return Promise.reject(new ChatClientError("chat_client_closed", "Chat client is closed"));
    }
    const commandScope = this.commandScope ?? scope;
    return commandScope.run(factory).then(() => undefined);
  }

  private *bootstrap(): Operation<void> {
    try {
      yield* call(() => this.parentInitialized);
      if (this.closed) {
        throw new ChatClientError("chat_client_closed", "Chat client closed before initialization");
      }
      const [scope, destroy] = createScope(this.parentScopeFactory());
      this.clientScope = scope;
      this.destroyClientScope = destroy;
      scope.set(ChatCommandContext, this.createCommandImplementation());
      const task = scope.run(() => this.initializeClient());
      yield* task;
    } catch (error) {
      const failure =
        error instanceof Error &&
        (error as Error & { code?: unknown }).code === "port_configuration_sealed"
          ? new ChatClientError(
              "chat_client_configuration_sealed",
              "Chat client configuration is sealed",
              error,
            )
          : asChatClientError(
              error,
              "chat_client_initialization_failed",
              "Chat client initialization failed",
            );
      this.publish({ status: "error", error: failure });
      this.initWaiter.reject(failure);
      for (const entry of this.commandQueue.splice(0)) {
        entry.reject(failure);
      }
      if (this.closed) {
        awaitDestroy(this.destroyClientScope);
      }
    }
  }

  private *initializeClient(): Operation<void> {
    this.commandScope = yield* useScope();
    yield* ChatCommandContext.set(this.createCommandImplementation());
    yield* ChatEventContext.set({ accept: (event) => this.processEvent(event) });
    if (this.options.setup) {
      yield* this.options.setup();
    }

    if (this.options.middleware) {
      yield* installMiddleware(ChatClientApi, this.options.middleware);
    }
    if (this.options.eventMiddleware) {
      yield* installMiddleware(ChatEventApi, this.options.eventMiddleware);
    }
    if (this.options.transport?.middleware) {
      yield* installMiddleware(ChatTransportPort.api, this.options.transport.middleware);
    }

    if (this.options.transport?.driver) {
      try {
        yield* ChatTransportPort.installDriver(this.options.transport.driver);
      } catch (error) {
        throw new ChatClientError(
          "chat_driver_duplicate",
          "Duplicate chat transport driver in client scope",
          error,
        );
      }
    } else if (!(yield* ChatTransportPort.isInstalled())) {
      yield* ChatTransportPort.installDriver(createHttpTransport(this.options.transport?.http));
    }

    if (this.options.scheduler) {
      try {
        yield* ChatSchedulerPort.installDriver(this.options.scheduler);
      } catch (error) {
        throw new ChatClientError(
          "chat_driver_duplicate",
          "Duplicate chat scheduler driver in client scope",
          error,
        );
      }
    }
    this.publish({ renderStatus: "loading" });
    try {
      const processors = pipelineProcessors(this.options.pipeline);
      if (processors) {
        yield* preloadProcessors(resolveProcessors(processors).processors);
      }
      this.publish({ renderStatus: "ready" });
    } catch (error) {
      const failure = asChatClientError(
        error,
        "chat_pipeline_failed",
        "Chat pipeline preload failed",
      );
      this.publish({ renderStatus: "error", error: failure });
    }

    this.readyForCommands = true;
    this.publish({ status: "ready", connectionStatus: "disconnected" });
    yield* ChatTransportPort.seal();
    yield* ChatSchedulerPort.seal();
    if (this.options.initialize) {
      yield* this.options.initialize(this);
    }
    this.initializedResolved = true;
    this.initWaiter.resolve(undefined);

    const pending = this.commandQueue.splice(0);
    for (const entry of pending) {
      if (this.closed) {
        entry.reject(new ChatClientError("chat_client_closed", "Chat client is closed"));
      } else {
        void entry.run().catch((error) => entry.reject(error));
      }
    }
    yield* suspend();
  }

  private createCommandImplementation(): ChatClientCommandContract {
    return {
      sendMessage: (input, options) => this.sendMessageImpl(input, options ?? {}),
      stop: () => this.stopImpl("user"),
      regenerate: (options) => this.regenerateImpl(options ?? {}),
      reconnect: () => this.reconnectImpl(),
      setMessages: (update) =>
        this.setMessagesImpl(
          update as
            | readonly ChatMessage<TLocalPart>[]
            | ((current: readonly ChatMessage<TLocalPart>[]) => readonly ChatMessage<TLocalPart>[]),
        ),
      clearError: () => this.clearErrorImpl(),
      close: () => this.closeImpl(),
    };
  }

  private *sendMessageImpl(input: UserMessageInput, options: SendMessageOptions): Operation<void> {
    this.ensureOpen();
    if (this.activeTask) {
      const policy = options.whenBusy ?? this.options.busy ?? "queue";
      if (policy === "drop") {
        throw new ChatClientError(
          "chat_busy_dropped",
          "Message dropped while chat client was busy",
        );
      }
      if (policy === "queue") {
        const queued: QueuedUserMessage = {
          id: "id" in input && input.id ? input.id : crypto.randomUUID(),
          input,
        };
        const completion = deferred<void>();
        this.queued = [...this.queued, queued];
        this.queuedCompletions.push(completion);
        this.publish({ queuedMessages: this.queued });
        yield* call(() => completion.promise);
        return;
      }
      yield* this.stopImpl("superseded");
    }

    const wire = createUserWire(input);
    const localBase = this.manualMessages ?? this.snapshot.messages;
    this.manualMessages = null;
    this.compactor.append(wire);
    this.publishProjection({ status: "submitted", connectionStatus: "connecting" });
    const runId = crypto.randomUUID();
    const request: ChatSendRequest = {
      trigger: "submit-message",
      clientId: this.id,
      conversationId: this.conversationId,
      runId,
      messages: [...messagesToWire(localBase), wire],
      state: this.state,
      context: this.context,
      forwardedProps: options.forwardedProps ?? this.forwardedProps,
    };
    yield* this.runRequest(request);
    yield* this.drainQueue();
  }

  private *regenerateImpl(options: RegenerateOptions): Operation<void> {
    this.ensureOpen();
    if (this.activeTask) {
      yield* this.stopImpl("regenerate");
    }
    const baseMessages = this.manualMessages ?? this.snapshot.messages;
    const target = options.messageId ?? lastRegeneratableMessageId(baseMessages);
    if (target) {
      const nested = [...baseMessages].some((message) => containsNestedMessage(message, target));
      if (nested) {
        throw new ChatClientError(
          "chat_regenerate_nested_unsupported",
          `Cannot regenerate nested message "${target}"`,
        );
      }
    }
    this.manualMessages = null;
    const request: ChatSendRequest = {
      trigger: "regenerate-message",
      clientId: this.id,
      conversationId: this.conversationId,
      runId: crypto.randomUUID(),
      ...(target !== undefined ? { messageId: target } : {}),
      messages: messagesToWire(baseMessages),
      state: this.state,
      context: this.context,
      forwardedProps: options.forwardedProps ?? this.forwardedProps,
    };
    this.publish({ status: "submitted", connectionStatus: "connecting" });
    yield* this.runRequest(request);
  }

  private *stopImpl(reason: string): Operation<void> {
    this.ensureOpen();
    if (reason === "user") {
      this.rejectQueued(new ChatClientError("chat_busy_dropped", "Queued messages were stopped"));
    }
    const active = this.activeTask;
    const request = this.activeRequest;
    if (request) {
      const signal = yield* useAbortSignal();
      const cancellation: ChatSendRequest = {
        ...request,
        trigger: "cancel-run",
        runId: request.runId,
        cancellationReason: reason,
      };
      try {
        const stream = yield* ChatTransportPort.api.operations.sendMessages(cancellation, signal);
        yield* this.consumeStream(stream, false);
        yield* this.flushPublication({}, true);
      } catch (error) {
        this.publish({
          error: asChatClientError(error, "chat_event_invalid", "Host cancellation failed"),
        });
      }
    }
    if (active) {
      yield* active.halt();
      this.activeTask = null;
      this.activeRequest = null;
    }
    this.publish({ connectionStatus: "disconnected", status: "ready" });
  }

  private *reconnectImpl(): Operation<void> {
    this.ensureOpen();
    const signal = yield* useAbortSignal();
    this.publish({ connectionStatus: "connecting" });
    try {
      const stream = yield* ChatTransportPort.api.operations.reconnectToStream(
        {
          clientId: this.id,
          conversationId: this.conversationId,
          ...(this.cursor !== undefined ? { cursor: this.cursor } : {}),
        },
        signal,
      );
      if (stream === null) {
        this.publish({
          connectionStatus: "disconnected",
          status: this.snapshot.status === "error" ? "ready" : this.snapshot.status,
        });
        return;
      }
      this.compactor.reset();
      this.manualMessages = null;
      this.publish({ connectionStatus: "connected" });
      const terminal = yield* this.consumeStream(stream, false);
      yield* this.flushPublication(
        {
          connectionStatus: "disconnected",
          status: terminal?.type === EventType.RUN_ERROR ? "error" : "ready",
        },
        true,
      );
    } catch (error) {
      const failure = asChatClientError(error, "chat_event_invalid", "Chat reconnect failed");
      this.publish({ connectionStatus: "error", status: "error", error: failure });
      throw failure;
    }
  }

  private *disconnect(reason?: string): Operation<void> {
    this.ensureOpen();
    yield* ChatTransportPort.api.operations.disconnect(reason);
    const active = this.activeTask;
    if (active) {
      yield* active.halt();
      this.activeTask = null;
      this.activeRequest = null;
    }
    this.publish({ connectionStatus: "disconnected" });
  }

  private *setMessagesImpl(
    update:
      | readonly ChatMessage<TLocalPart>[]
      | ((current: readonly ChatMessage<TLocalPart>[]) => readonly ChatMessage<TLocalPart>[]),
  ): Operation<void> {
    this.ensureOpen();
    const current = this.manualMessages ?? this.snapshot.messages;
    this.manualMessages = deepFreeze([
      ...(typeof update === "function" ? update(current) : update),
    ]);
    this.publish({ messages: this.manualMessages }, false);
  }

  private *clearErrorImpl(): Operation<void> {
    this.ensureOpen();
    this.publish({ status: "ready", error: null });
  }

  private *closeImpl(): Operation<void> {
    this.closed = true;
    this.readyForCommands = false;
    const failure = new ChatClientError("chat_client_closed", "Chat client is closed");
    this.rejectQueued(failure);
    for (const entry of this.commandQueue.splice(0)) {
      entry.reject(failure);
    }
  }

  private *runRequest(request: ChatSendRequest): Operation<void> {
    const task = yield* spawn(() => this.requestOperation(request));
    this.activeTask = task;
    this.activeRequest = request;
    try {
      yield* task;
    } finally {
      if (this.activeTask === task) {
        this.activeTask = null;
        this.activeRequest = null;
      }
    }
  }

  private *requestOperation(request: ChatSendRequest): Operation<void> {
    const signal = yield* useAbortSignal();
    try {
      const stream = yield* ChatTransportPort.api.operations.sendMessages(request, signal);
      this.publish({ connectionStatus: "connected" });
      const terminal = yield* this.consumeStream(stream, true);
      yield* this.flushPublication(
        {
          status: terminal?.type === EventType.RUN_ERROR ? "error" : "ready",
          connectionStatus: "disconnected",
        },
        true,
      );
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      const failure = asChatClientError(error, "chat_event_invalid", "Chat request failed");
      this.rejectQueued(failure);
      this.publish({ status: "error", connectionStatus: "error", error: failure });
      throw failure;
    }
  }

  private *consumeStream(
    stream: Stream<ChatStreamEvent, void>,
    requireTerminal: boolean,
  ): Operation<ChatStreamEvent | null> {
    const clockInstalled = yield* ChatSchedulerPort.isInstalled();
    let terminalEvent: ChatStreamEvent | null;
    if (clockInstalled) {
      const pacedTerminal = yield* this.consumePacedStream(stream);
      terminalEvent = pacedTerminal;
    } else {
      const unpacedTerminal = yield* this.consumeUnpacedStream(stream);
      terminalEvent = unpacedTerminal;
    }

    if (requireTerminal && terminalEvent === null) {
      throw new ChatClientError(
        "chat_transport_truncated",
        "Chat stream ended before a terminal AG-UI event",
      );
    }
    if (requireTerminal && this.compactor.pendingParents.length > 0) {
      throw new ChatClientError(
        "chat_activity_parent_missing",
        `Unresolved public activity parents: ${this.compactor.pendingParents.join(", ")}`,
      );
    }
    if (this.compactor.error) {
      throw this.compactor.error;
    }
    return terminalEvent;
  }

  private *consumePacedStream(
    stream: Stream<ChatStreamEvent, void>,
  ): Operation<ChatStreamEvent | null> {
    const events = yield* createEagerBuffer(stream);
    const clock = ChatSchedulerPort.api.operations.clock();
    let terminalEvent: ChatStreamEvent | null = null;

    for (const _tick of yield* each(clock)) {
      const batch = events.drain();
      terminalEvent = (yield* this.publishEventBatch(batch)) ?? terminalEvent;

      if (events.state.status === "error") {
        throw events.state.error;
      }
      if (events.state.status === "done") {
        return terminalEvent;
      }

      yield* each.next();
    }

    throw new ChatClientError(
      "chat_scheduler_closed",
      "Chat scheduler clock closed while the transport stream was active",
    );
  }

  private *consumeUnpacedStream(
    stream: Stream<ChatStreamEvent, void>,
  ): Operation<ChatStreamEvent | null> {
    const subscription = yield* stream;
    let terminalEvent: ChatStreamEvent | null = null;
    let next = yield* subscription.next();

    while (!next.done) {
      terminalEvent = (yield* this.publishEventBatch([next.value])) ?? terminalEvent;
      next = yield* subscription.next();
    }

    return terminalEvent;
  }

  private *publishEventBatch(batch: readonly ChatStreamEvent[]): Operation<ChatStreamEvent | null> {
    let terminalEvent: ChatStreamEvent | null = null;
    for (const event of batch) {
      yield* ChatEventApi.operations.accept(event);
      if (event.type === EventType.RUN_FINISHED || event.type === EventType.RUN_ERROR) {
        terminalEvent = event;
      }
    }
    if (batch.length > 0) {
      try {
        yield* this.compactor.pull();
      } catch (error) {
        this.recordPipelineFailure(error);
      }
      const changes = this.pendingPublicationChanges;
      this.pendingPublicationChanges = {};
      this.publishProjection(changes);
    }
    return terminalEvent;
  }

  private *processEvent(event: ChatStreamEvent): Operation<void> {
    try {
      for (const action of this.compactor.ingest(event)) {
        yield* this.interpretProjectionAction(action);
      }
    } catch (error) {
      const failure = asChatClientError(
        error,
        "chat_activity_invalid",
        "Public activity projection failed",
      );
      this.compactor.setError(failure);
      throw failure;
    }
    if (event.type === EventType.RUN_ERROR) {
      const failure = new ChatClientError(event.code ?? "chat_run_error", event.message);
      this.stagePublication({ status: "error", error: failure });
      return;
    }
    const streaming =
      event.type === EventType.RUN_STARTED ||
      event.type === EventType.TEXT_MESSAGE_START ||
      event.type === EventType.TEXT_MESSAGE_CONTENT ||
      event.type === EventType.REASONING_MESSAGE_START ||
      event.type === EventType.REASONING_MESSAGE_CONTENT ||
      event.type === EventType.TOOL_CALL_START ||
      event.type === EventType.TOOL_CALL_ARGS;
    this.stagePublication({
      status: streaming ? "streaming" : this.currentPublicationStatus(),
    });
  }

  private *interpretProjectionAction(action: LiveCompactorAction): Operation<void> {
    switch (action.type) {
      case "elicit-observed":
        this.interaction?.observe(action.request);
        return;
      case "elicit-settled":
        this.interaction?.settled(action.elicitId);
        return;
      case "elicit-cancelled":
        this.interaction?.cancel(action.elicitId);
        return;
    }
  }

  private *resumeElicit(
    request: ChatInteractionRequest,
    completion: ChatInteractionCompletion,
  ): Operation<void> {
    this.ensureOpen();
    const resume =
      completion.action === "cancel"
        ? [{ interruptId: request.elicitId, status: "cancelled" as const }]
        : [
            {
              interruptId: request.elicitId,
              status: "resolved" as const,
              ...(completion.action === "accept"
                ? { payload: { action: "accept" as const, content: completion.content } }
                : { payload: { action: "decline" as const } }),
            },
          ];
    const transportRequest: ChatSendRequest = {
      trigger: "submit-message",
      clientId: this.id,
      conversationId: this.conversationId,
      runId: crypto.randomUUID(),
      messages: messagesToWire(this.snapshot.messages),
      state: this.state,
      context: this.context,
      forwardedProps: this.forwardedProps,
      resume,
    };
    this.publish({ status: "submitted", connectionStatus: "connecting" });
    yield* this.runRequest(transportRequest);
  }

  private currentPublicationStatus(): ChatSnapshot<ChatMessage<TLocalPart>>["status"] {
    return this.pendingPublicationChanges.status ?? this.snapshot.status;
  }

  private stagePublication(changes: Partial<ChatSnapshot<ChatMessage<TLocalPart>>>): void {
    this.pendingPublicationChanges = { ...this.pendingPublicationChanges, ...changes };
  }

  private *flushPublication(
    changes: Partial<ChatSnapshot<ChatMessage<TLocalPart>>>,
    finishPipelines: boolean,
  ): Operation<void> {
    if (finishPipelines) {
      try {
        yield* this.compactor.pull(true);
      } catch (error) {
        this.recordPipelineFailure(error);
      }
    }
    this.stagePublication(changes);
    const finalChanges = this.pendingPublicationChanges;
    this.pendingPublicationChanges = {};
    this.publishProjection(finalChanges);
  }

  private recordPipelineFailure(error: unknown): void {
    const failure = asChatClientError(error, "chat_pipeline_failed", "Chat frame pipeline failed");
    this.publish({ renderStatus: "error", error: failure });
  }

  private *drainQueue(): Operation<void> {
    const queued = this.queued;
    const completions = this.queuedCompletions.splice(0);
    this.queued = [];
    this.publish({ queuedMessages: [] });
    for (let index = 0; index < queued.length; index += 1) {
      const item = queued[index]!;
      const completion = completions[index]!;
      try {
        yield* this.sendMessageImpl(item.input, { whenBusy: "queue" });
        completion.resolve(undefined);
      } catch (error) {
        completion.reject(error);
        for (const pending of completions.slice(index + 1)) {
          pending.reject(error);
        }
        throw error;
      }
    }
  }

  private rejectQueued(error: unknown): void {
    const completions = this.queuedCompletions.splice(0);
    this.queued = [];
    for (const completion of completions) {
      completion.reject(error);
    }
    if (completions.length > 0) {
      this.publish({ queuedMessages: [] });
    }
  }

  private publishProjection(changes: Partial<ChatSnapshot<ChatMessage<TLocalPart>>>): void {
    let messages: readonly ChatMessage<TLocalPart>[] = this.snapshot.messages;
    try {
      messages = this.compactor.materialize<TLocalPart>();
    } catch (error) {
      const failure = asChatClientError(
        error,
        "chat_activity_parent_missing",
        "Unable to materialize public chat messages",
      );
      changes = { ...changes, status: "error", error: failure };
    }
    const serverMessages = messages;
    if (this.interaction) {
      messages = overlayLocalParts(messages, this.interaction.localParts());
    }
    this.publish({ ...changes, messages }, false);
    this.serverSnapshot = deepFreeze({
      ...this.serverSnapshot,
      ...changes,
      messages: serverMessages,
      queuedMessages: changes.queuedMessages ?? this.queued,
    });
  }

  private publish(
    changes: Partial<ChatSnapshot<ChatMessage<TLocalPart>>>,
    updateServer = true,
  ): void {
    const next = deepFreeze({
      ...this.snapshot,
      ...changes,
      queuedMessages: changes.queuedMessages ?? this.queued,
    });
    this.snapshot = next;
    if (updateServer) {
      this.serverSnapshot = next;
    }
    // eslint-disable-next-line unicorn/no-useless-spread -- Publish to the listener snapshot that existed when this update began.
    for (const listener of [...this.listeners]) {
      listener();
    }
    if (changes.connectionStatus !== undefined || changes.error !== undefined) {
      // eslint-disable-next-line unicorn/no-useless-spread -- Subscription mutation must not alter the current publication set.
      for (const listener of [...this.transportListeners]) {
        listener();
      }
    }
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new ChatClientError("chat_client_closed", "Chat client is closed");
    }
  }

  private async shutdownBeforeInitialization(): Promise<void> {
    try {
      await this.bootstrapTask?.halt();
    } finally {
      await this.destroyOwnedResources();
    }
  }

  private async shutdownAfterClose(): Promise<void> {
    await this.destroyOwnedResources();
  }

  private async destroyOwnedResources(): Promise<void> {
    this.interactionUnsubscribe?.();
    this.interactionUnsubscribe = null;
    this.interaction?.dispose();
    try {
      await this.destroyClientScope?.();
    } finally {
      await this.destroyParentScope?.();
    }
  }

  async destroy(): Promise<void> {
    await this.close();
  }
}

function containsNestedMessage(message: ChatMessage<ChatLocalPart>, targetId: string): boolean {
  return message.parts.some((part) => {
    if (part.type === "message" && "message" in part) {
      const nested = part as { readonly message: ChatMessage<ChatLocalPart> };
      return nested.message.id === targetId || containsNestedMessage(nested.message, targetId);
    }
    if (!("parts" in part) || !Array.isArray(part.parts)) {
      return false;
    }
    const children = part.parts as readonly ChatPart<ChatLocalPart>[];
    return children.some(
      (child) =>
        child.type === "message" &&
        "message" in child &&
        ((child as { readonly message: ChatMessage<ChatLocalPart> }).message.id === targetId ||
          containsNestedMessage(
            (child as { readonly message: ChatMessage<ChatLocalPart> }).message,
            targetId,
          )),
    );
  });
}

function awaitDestroy(destroy: (() => Promise<void>) | null): void {
  if (destroy) {
    void destroy().catch(() => undefined);
  }
}

export function createChatClient<
  TLocalPart extends { readonly type: string; readonly id: string } = never,
>(options: ChatClientOptions<TLocalPart>): ChatClient<ChatMessage<TLocalPart>> {
  const [scope, destroy] = createScope();
  const controller = new ChatClientController<TLocalPart>(
    scope,
    Promise.resolve(),
    options,
    destroy,
    () => scope,
  );
  return controller;
}

export interface InternalRuntime {
  readonly bootstrapScope: Scope;
  scope: Scope;
  readonly initialized: Promise<void>;
}

export function createClientFromRuntime<
  TLocalPart extends { readonly type: string; readonly id: string } = never,
>(
  runtime: InternalRuntime,
  options: ChatClientOptions<TLocalPart>,
): ChatClient<ChatMessage<TLocalPart>> {
  const controller = new ChatClientController<TLocalPart>(
    runtime.bootstrapScope,
    runtime.initialized,
    options,
    null,
    () => runtime.scope,
  );
  return controller;
}
