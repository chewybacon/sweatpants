import { EventType } from "@ag-ui/core";
import {
  call,
  createScope,
  each,
  spawn,
  suspend,
  useAbortSignal,
  useScope,
  withResolvers,
  type Around,
  type Operation,
  type Scope,
  type Stream,
  type Task,
  type WithResolvers,
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
import { createHttpTransport, type ChatFetch, type HttpTransportOptions } from "./http.ts";
import {
  projectChatMessagesToAGUI as messagesToAGUI,
  type ChatUIMessage,
  type ChatContent,
  type ChatContentPart,
  type ChatLocalPart,
  type ChatUIPart,
  type ChatTransportRequest,
  type ChatTransportRequestMessage,
  type ChatUISnapshot,
  type AGUIEvent,
  type ChatTransportContract,
  type ChatTransportControl,
  type ChatQueueOption,
  type FramePipelineFactory,
  type RegenerateOptions,
  type SendMessageOptions,
  type UserMessageInput,
  type ClientElicitFact,
  type QueuedUserMessage,
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
  /** Lower-level driver slot; prefer ChatClientOptions.connection at the public boundary. */
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
  readonly threadId: string;
  readonly clientId?: string;
  /** HTTP endpoint used with the fetcher convenience. */
  readonly api?: string;
  /** Custom request/reconnect boundary. */
  readonly connection?: ChatTransportContract;
  readonly transport?: ChatTransportOptions;
  /** Fetch-compatible transport convenience used when no custom driver is supplied. */
  readonly fetcher?: ChatFetch;
  readonly middleware?: readonly ChatClientMiddleware[];
  readonly eventMiddleware?: readonly ChatEventMiddleware[];
  readonly pipeline?: PipelineConfig | PipelinePreset | FramePipelineFactory;
  readonly scheduler?: ChatSchedulerDriver;
  readonly interaction?: ChatInteractionRuntime<TLocalPart>;
  readonly queue?: ChatQueueOption;
  readonly setup?: () => Operation<void>;
  readonly initialize?: (client: ChatClientControl<TLocalPart>) => Operation<void>;
  readonly state?: Json;
  /** AG-UI context entries forwarded to the host; never an authorization claim. */
  readonly context?: readonly { readonly description: string; readonly value: string }[];
  /** Untrusted serializable properties forwarded to host request policy. */
  readonly forwardedProps?: Json;
}

export interface ChatRuntimeOptions {
  /** HTTP endpoint used with the fetcher convenience for child clients. */
  readonly api?: string;
  /** Default custom request/reconnect boundary for child clients. */
  readonly connection?: ChatTransportContract;
  readonly transport?: ChatTransportOptions;
  /** Fetch-compatible transport convenience for child clients without a custom driver. */
  readonly fetcher?: ChatFetch;
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
  readonly threadId: string;
  getSnapshot(): ChatUISnapshot<ChatUIMessage<TLocalPart>>;
  reconnect(): Promise<void>;
}

export type ChatSchedulerDriver = ChatSchedulerContract;

export interface ChatClient<TMessage extends ChatUIMessage<ChatLocalPart> = ChatUIMessage> {
  readonly id: string;
  readonly threadId: string;
  readonly initialized: Promise<void>;
  readonly transport: ChatTransportControl;
  getSnapshot(): ChatUISnapshot<TMessage>;
  getServerSnapshot(): ChatUISnapshot<TMessage>;
  subscribe(listener: () => void): () => void;
  sendMessage(input: UserMessageInput, options?: SendMessageOptions): Promise<void>;
  regenerate(options?: RegenerateOptions): Promise<void>;
  stop(): Promise<void>;
  reconnect(): Promise<void>;
  cancelQueued(id: string): Promise<void>;
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

function makeInitialSnapshot<TLocalPart extends ChatLocalPart = never>(): ChatUISnapshot<
  ChatUIMessage<TLocalPart>
> {
  return deepFreeze({
    messages: Object.freeze([]),
    status: "ready" as const,
    connectionStatus: "disconnected" as const,
    renderStatus: "loading" as const,
    error: null,
    runId: null,
    queue: Object.freeze([]),
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

function lastRegeneratableMessageId<TLocalPart extends ChatLocalPart>(
  messages: readonly ChatUIMessage<TLocalPart>[],
): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === "assistant" || message.role === "user") {
      return message.id;
    }
  }
  return undefined;
}

function createUserWire(
  input: UserMessageInput,
): Extract<ChatTransportRequestMessage, { role: "user" }> {
  if (typeof input === "string") {
    return { id: crypto.randomUUID(), role: "user", content: input };
  }
  return {
    id: input.id ?? crypto.randomUUID(),
    role: "user",
    content: userContentToWire(input.content),
  };
}

function userContentToWire(
  content: ChatContent,
): Extract<ChatTransportRequestMessage, { role: "user" }>["content"] {
  if (typeof content === "string") return content;
  return content.map((part: ChatContentPart) => {
    if (part.type === "text") return { type: "text", text: part.text };
    return part.metadata === null
      ? { type: part.type, source: part.source }
      : { type: part.type, source: part.source, metadata: part.metadata };
  });
}

function runAgentInput(input: {
  readonly threadId: string;
  readonly runId: string;
  readonly messages: readonly ChatTransportRequestMessage[];
  readonly state: Json;
  readonly context: readonly { readonly description: string; readonly value: string }[];
  readonly forwardedProps: Json;
  readonly parentRunId?: string;
  readonly resume?: readonly {
    readonly interruptId: string;
    readonly status: "resolved" | "cancelled";
    readonly payload?: Json;
  }[];
}): ChatTransportRequest["input"] {
  return {
    threadId: input.threadId,
    runId: input.runId,
    messages: [...input.messages],
    state: input.state,
    tools: [],
    context: [...input.context],
    forwardedProps: input.forwardedProps,
    ...(input.parentRunId === undefined ? {} : { parentRunId: input.parentRunId }),
    ...(input.resume === undefined ? {} : { resume: [...input.resume] }),
  };
}

interface ResolvedQueueOptions {
  readonly whenBusy: "queue" | "drop" | "interrupt";
  readonly maxSize?: number;
  readonly onOverflow: "reject" | "drop-oldest";
}

function isQueueBusyPolicy(value: unknown): value is ResolvedQueueOptions["whenBusy"] {
  return value === "queue" || value === "drop" || value === "interrupt";
}

function isQueueOverflowPolicy(value: unknown): value is ResolvedQueueOptions["onOverflow"] {
  return value === "reject" || value === "drop-oldest";
}

function invalidQueueOption(message: string): never {
  throw new ChatClientError("chat_queue_invalid", message);
}

function isPortDriverDuplicate(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as Error & { readonly code?: unknown }).code === "port_driver_duplicate"
  );
}

function normalizeQueueOption(option: ChatQueueOption | undefined): ResolvedQueueOptions {
  const base: ResolvedQueueOptions = {
    whenBusy: "queue",
    onOverflow: "reject",
  };
  if (option === undefined) {
    return base;
  }
  if (typeof option === "string") {
    if (!isQueueBusyPolicy(option)) {
      return invalidQueueOption(`Unknown chat queue whenBusy policy: ${String(option)}`);
    }
    return { ...base, whenBusy: option };
  }
  if (option === null || typeof option !== "object" || Array.isArray(option)) {
    return invalidQueueOption("Chat queue options must be a policy string or object");
  }
  if (option.whenBusy !== undefined && !isQueueBusyPolicy(option.whenBusy)) {
    return invalidQueueOption(`Unknown chat queue whenBusy policy: ${String(option.whenBusy)}`);
  }
  if (option.onOverflow !== undefined && !isQueueOverflowPolicy(option.onOverflow)) {
    return invalidQueueOption(`Unknown chat queue onOverflow policy: ${String(option.onOverflow)}`);
  }
  if (option.maxSize !== undefined) {
    if (!Number.isInteger(option.maxSize) || option.maxSize < 0) {
      return invalidQueueOption("Chat queue maxSize must be a non-negative integer");
    }
  }
  return {
    ...base,
    ...(option.whenBusy !== undefined ? { whenBusy: option.whenBusy } : {}),
    ...(option.maxSize !== undefined ? { maxSize: option.maxSize } : {}),
    ...(option.onOverflow !== undefined ? { onOverflow: option.onOverflow } : {}),
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
> implements ChatClient<ChatUIMessage<TLocalPart>> {
  readonly id: string;
  readonly threadId: string;
  readonly initialized: Promise<void>;
  readonly transport: ChatTransportControl;

  private readonly initWaiter = withResolvers<void>("chat client initialization");
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
  private readonly queueOptions: ResolvedQueueOptions;
  private pendingPublicationChanges: Partial<ChatUISnapshot<ChatUIMessage<TLocalPart>>> = {};
  private snapshot: ChatUISnapshot<ChatUIMessage<TLocalPart>> = makeInitialSnapshot<TLocalPart>();
  private serverSnapshot: ChatUISnapshot<ChatUIMessage<TLocalPart>> = this.snapshot;
  private manualMessages: readonly ChatUIMessage<TLocalPart>[] | null = null;
  private queued: readonly QueuedUserMessage[] = [];
  private readonly queuedCompletions: WithResolvers<void>[] = [];
  private clientScope: Scope | null = null;
  private commandScope: Scope | null = null;
  private destroyClientScope: (() => Promise<void>) | null = null;
  private bootstrapTask: Task<void> | null = null;
  private activeTask: Task<AGUIEvent | null> | null = null;
  private activeRequest: ChatTransportRequest | null = null;
  private readyForCommands = false;
  private initializedResolved = false;
  private closed = false;
  private closePromise: Promise<void> | null = null;
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
    this.threadId = options.threadId;
    this.queueOptions = normalizeQueueOption(options.queue);
    this.initialized = bootstrapScope.run(() => this.initWaiter.operation);
    void this.initialized.catch(() => undefined);
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

  getSnapshot(): ChatUISnapshot<ChatUIMessage<TLocalPart>> {
    return this.snapshot;
  }

  getServerSnapshot(): ChatUISnapshot<ChatUIMessage<TLocalPart>> {
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

  cancelQueued(id: string): Promise<void> {
    return this.enqueueCommand(() => ChatClientApi.operations.cancelQueued(id));
  }

  setMessages(
    update:
      | readonly ChatUIMessage<TLocalPart>[]
      | ((current: readonly ChatUIMessage<TLocalPart>[]) => readonly ChatUIMessage<TLocalPart>[]),
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
    const parentScope = this.clientScope;
    if (!parentScope || (this.closed && !this.closePromise)) {
      return Promise.reject(new ChatClientError("chat_client_closed", "Chat client is closed"));
    }
    // Every public command gets a child scope. A rejected busy/queue command
    // must not fault the shared client scope and halt an unrelated active turn.
    const [commandScope, destroy] = createScope(this.commandScope ?? parentScope);
    const task = commandScope.run(function* (): Operation<
      { readonly ok: true } | { readonly ok: false; readonly error: unknown }
    > {
      try {
        yield* factory();
        return { ok: true };
      } catch (error) {
        return { ok: false, error };
      }
    });
    return task
      .then((result) => {
        if (!result.ok) {
          throw result.error;
        }
      })
      .finally(() => destroy().catch(() => undefined));
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

    const connection = this.options.connection ?? this.options.transport?.driver;
    if (connection) {
      try {
        yield* ChatTransportPort.installDriver(connection);
      } catch (error) {
        if (!isPortDriverDuplicate(error)) {
          throw error;
        }
        throw new ChatClientError(
          "chat_driver_duplicate",
          "Duplicate chat transport driver in client scope",
          error,
        );
      }
    } else if (!(yield* ChatTransportPort.isInstalled())) {
      const http =
        this.options.transport?.http ??
        (this.options.api !== undefined || this.options.fetcher !== undefined
          ? {
              ...(this.options.api !== undefined ? { api: this.options.api } : {}),
              ...(this.options.fetcher !== undefined ? { fetch: this.options.fetcher } : {}),
            }
          : undefined);
      yield* ChatTransportPort.installDriver(createHttpTransport(http));
    }

    if (this.options.scheduler) {
      try {
        yield* ChatSchedulerPort.installDriver(this.options.scheduler);
      } catch (error) {
        if (!isPortDriverDuplicate(error)) {
          throw error;
        }
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
      cancelQueued: (id) => this.cancelQueuedImpl(id),
      setMessages: (update) =>
        this.setMessagesImpl(
          update as
            | readonly ChatUIMessage<TLocalPart>[]
            | ((
                current: readonly ChatUIMessage<TLocalPart>[],
              ) => readonly ChatUIMessage<TLocalPart>[]),
        ),
      clearError: () => this.clearErrorImpl(),
      close: () => this.closeImpl(),
    };
  }

  private *sendMessageImpl(input: UserMessageInput, options: SendMessageOptions): Operation<void> {
    this.ensureOpen();
    if (this.activeTask) {
      const policy = options.whenBusy ?? this.queueOptions.whenBusy;
      if (policy === "drop") {
        return;
      }
      if (policy === "queue") {
        const queued: QueuedUserMessage = {
          id: typeof input === "string" ? crypto.randomUUID() : (input.id ?? crypto.randomUUID()),
          input,
          createdAt: Date.now(),
        };
        if (
          this.queueOptions.maxSize !== undefined &&
          this.queued.length >= this.queueOptions.maxSize
        ) {
          if (this.queueOptions.onOverflow !== "drop-oldest" || this.queueOptions.maxSize === 0) {
            throw new ChatClientError(
              "chat_queue_full",
              `Chat queue is full (maxSize: ${this.queueOptions.maxSize})`,
            );
          }
          const droppedCompletion = this.queuedCompletions.shift();
          this.queued = this.queued.slice(1);
          droppedCompletion?.reject(
            new ChatClientError("chat_queue_dropped", "Queued message was dropped oldest-first"),
          );
        }
        const completion = withResolvers<void>("queued chat message");
        this.queued = [...this.queued, queued];
        this.queuedCompletions.push(completion);
        this.publish({ queue: this.queued });
        yield* completion.operation;
        return;
      }
      yield* this.stopImpl("superseded");
    }

    const wire = createUserWire(input);
    const localBase = this.manualMessages ?? this.snapshot.messages;
    this.manualMessages = null;
    this.compactor.append(wire);
    const runId = crypto.randomUUID();
    this.publishProjection({ status: "submitted", connectionStatus: "connecting", runId });
    const request: ChatTransportRequest = {
      trigger: "submit-message",
      clientId: this.id,
      conversationId: this.threadId,
      input: runAgentInput({
        threadId: this.threadId,
        runId,
        messages: [...messagesToAGUI(localBase), wire],
        state: this.state,
        context: this.context,
        forwardedProps: options.forwardedProps ?? this.forwardedProps,
      }),
    };
    const terminal = yield* this.runRequest(request);
    yield* this.finishRequest(terminal);
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
    const runId = crypto.randomUUID();
    const request: ChatTransportRequest = {
      trigger: "regenerate-message",
      clientId: this.id,
      conversationId: this.threadId,
      ...(target === undefined ? {} : { messageId: target }),
      input: runAgentInput({
        threadId: this.threadId,
        runId,
        messages: messagesToAGUI(baseMessages),
        state: this.state,
        context: this.context,
        forwardedProps: options.forwardedProps ?? this.forwardedProps,
      }),
    };
    this.publish({ status: "submitted", connectionStatus: "connecting", runId });
    const terminal = yield* this.runRequest(request);
    yield* this.finishRequest(terminal);
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
      const cancellation: ChatTransportRequest = {
        ...request,
        trigger: "cancel-run",
        cancellationReason: reason,
      };
      try {
        const stream = yield* ChatTransportPort.api.operations.sendMessages(cancellation, signal);
        yield* this.consumeStream(stream, false);
        yield* this.flushPublication({}, true);
      } catch (error) {
        this.publish({
          error: asChatClientError(error, "chat_transport_failed", "Host cancellation failed"),
        });
      }
    }
    if (active) {
      yield* active.halt();
      this.activeTask = null;
      this.activeRequest = null;
    }
    this.publish({ connectionStatus: "disconnected", status: "ready", runId: null });
  }

  private *reconnectImpl(): Operation<void> {
    this.ensureOpen();
    const signal = yield* useAbortSignal();
    this.publish({ connectionStatus: "connecting" });
    try {
      const stream = yield* ChatTransportPort.api.operations.reconnectToStream(
        {
          clientId: this.id,
          threadId: this.threadId,
        },
        signal,
      );
      if (stream === null) {
        this.publish({
          connectionStatus: "disconnected",
          status: this.snapshot.status === "error" ? "ready" : this.snapshot.status,
          runId: null,
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
          runId: null,
        },
        true,
      );
    } catch (error) {
      const failure = asChatClientError(error, "chat_transport_failed", "Chat reconnect failed");
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
    this.publish({ connectionStatus: "disconnected", runId: null });
  }

  private *cancelQueuedImpl(id: string): Operation<void> {
    this.ensureOpen();
    const index = this.queued.findIndex((item) => item.id === id);
    if (index === -1) {
      return;
    }
    const completion = this.queuedCompletions.splice(index, 1)[0];
    this.queued = [...this.queued.slice(0, index), ...this.queued.slice(index + 1)];
    // Cancellation is an intentional local no-op, not a failed transport
    // request. The caller can observe removal through the queue snapshot.
    completion?.resolve(undefined);
    this.publish({ queue: this.queued });
  }

  private *setMessagesImpl(
    update:
      | readonly ChatUIMessage<TLocalPart>[]
      | ((current: readonly ChatUIMessage<TLocalPart>[]) => readonly ChatUIMessage<TLocalPart>[]),
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

  private *runRequest(request: ChatTransportRequest): Operation<AGUIEvent | null> {
    const task = yield* spawn(() => this.requestOperation(request));
    this.activeTask = task;
    this.activeRequest = request;
    let failure: ChatClientError | null = null;
    try {
      return yield* task;
    } catch (error) {
      if (error instanceof ChatClientError) {
        failure = error;
      }
      throw error;
    } finally {
      if (this.activeTask === task) {
        this.activeTask = null;
        this.activeRequest = null;
      }
      if (failure) {
        this.publish({ status: "error", connectionStatus: "error", error: failure, runId: null });
      }
    }
  }

  private *requestOperation(request: ChatTransportRequest): Operation<AGUIEvent | null> {
    const signal = yield* useAbortSignal();
    try {
      const stream = yield* ChatTransportPort.api.operations.sendMessages(request, signal);
      this.publish({ connectionStatus: "connected" });
      return yield* this.consumeStream(stream, true);
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      const failure = asChatClientError(error, "chat_transport_failed", "Chat request failed");
      this.rejectQueued(failure);
      throw failure;
    }
  }

  private *finishRequest(terminal: AGUIEvent | null): Operation<void> {
    const runError = terminal?.type === EventType.RUN_ERROR ? terminal : null;
    yield* this.flushPublication(
      {
        status: runError ? "error" : "ready",
        connectionStatus: "disconnected",
        runId: null,
        ...(runError
          ? { error: new ChatClientError(runError.code ?? "chat_run_error", runError.message) }
          : {}),
      },
      true,
    );
  }

  private *consumeStream(
    stream: Stream<AGUIEvent, void>,
    requireTerminal: boolean,
  ): Operation<AGUIEvent | null> {
    const clockInstalled = yield* ChatSchedulerPort.isInstalled();
    let terminalEvent: AGUIEvent | null;
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

  private *consumePacedStream(stream: Stream<AGUIEvent, void>): Operation<AGUIEvent | null> {
    const events = yield* createEagerBuffer(stream);
    const clock = ChatSchedulerPort.api.operations.clock();
    let terminalEvent: AGUIEvent | null = null;

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

  private *consumeUnpacedStream(stream: Stream<AGUIEvent, void>): Operation<AGUIEvent | null> {
    const subscription = yield* stream;
    let terminalEvent: AGUIEvent | null = null;
    let next = yield* subscription.next();

    while (!next.done) {
      terminalEvent = (yield* this.publishEventBatch([next.value])) ?? terminalEvent;
      next = yield* subscription.next();
    }

    return terminalEvent;
  }

  private *publishEventBatch(batch: readonly AGUIEvent[]): Operation<AGUIEvent | null> {
    let terminalEvent: AGUIEvent | null = null;
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

  private *processEvent(event: AGUIEvent): Operation<void> {
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
      ...(event.type === EventType.RUN_STARTED ? { runId: event.runId } : {}),
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
    const transportRequest: ChatTransportRequest = {
      trigger: "submit-message",
      clientId: this.id,
      conversationId: this.threadId,
      input: runAgentInput({
        threadId: this.threadId,
        runId: crypto.randomUUID(),
        messages: messagesToAGUI(this.snapshot.messages),
        state: this.state,
        context: this.context,
        forwardedProps: this.forwardedProps,
        resume,
      }),
    };
    this.publish({ status: "submitted", connectionStatus: "connecting" });
    const terminal = yield* this.runRequest(transportRequest);
    yield* this.finishRequest(terminal);
  }

  private currentPublicationStatus(): ChatUISnapshot<ChatUIMessage<TLocalPart>>["status"] {
    return this.pendingPublicationChanges.status ?? this.snapshot.status;
  }

  private stagePublication(changes: Partial<ChatUISnapshot<ChatUIMessage<TLocalPart>>>): void {
    this.pendingPublicationChanges = { ...this.pendingPublicationChanges, ...changes };
  }

  private *flushPublication(
    changes: Partial<ChatUISnapshot<ChatUIMessage<TLocalPart>>>,
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
    yield* this.drainQueue();
  }

  private recordPipelineFailure(error: unknown): void {
    const failure = asChatClientError(error, "chat_pipeline_failed", "Chat frame pipeline failed");
    this.publish({ renderStatus: "error", error: failure });
  }

  private *drainQueue(): Operation<void> {
    const queued = this.queued;
    const completions = this.queuedCompletions.splice(0);
    this.queued = [];
    this.publish({ queue: [] });
    for (let index = 0; index < queued.length; index += 1) {
      const item = queued[index]!;
      const completion = completions[index]!;
      try {
        yield* this.sendMessageImpl(item.input, { whenBusy: "queue" });
        completion.resolve(undefined);
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        completion.reject(failure);
        for (const pending of completions.slice(index + 1)) {
          pending.reject(failure);
        }
        throw error;
      }
    }
  }

  private rejectQueued(error: unknown): void {
    const completions = this.queuedCompletions.splice(0);
    this.queued = [];
    const failure = error instanceof Error ? error : new Error(String(error));
    for (const completion of completions) {
      completion.reject(failure);
    }
    if (completions.length > 0) {
      this.publish({ queue: [] });
    }
  }

  private publishProjection(changes: Partial<ChatUISnapshot<ChatUIMessage<TLocalPart>>>): void {
    let messages: readonly ChatUIMessage<TLocalPart>[] = this.snapshot.messages;
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
      queue: changes.queue ?? this.queued,
    });
  }

  private publish(
    changes: Partial<ChatUISnapshot<ChatUIMessage<TLocalPart>>>,
    updateServer = true,
  ): void {
    const next = deepFreeze({
      ...this.snapshot,
      ...changes,
      queue: changes.queue ?? this.queued,
    });
    this.snapshot = next;
    if (updateServer) {
      const serverChanges = Object.fromEntries(
        Object.entries(changes).filter(([key]) => key !== "messages"),
      ) as Partial<ChatUISnapshot<ChatUIMessage<TLocalPart>>>;
      this.serverSnapshot = deepFreeze({
        ...this.serverSnapshot,
        ...serverChanges,
        queue: changes.queue ?? this.queued,
      });
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

function containsNestedMessage(message: ChatUIMessage<ChatLocalPart>, targetId: string): boolean {
  return message.parts.some((part) => {
    if (part.type === "message" && "message" in part) {
      const nested = part as { readonly message: ChatUIMessage<ChatLocalPart> };
      return nested.message.id === targetId || containsNestedMessage(nested.message, targetId);
    }
    if (!("parts" in part) || !Array.isArray(part.parts)) {
      return false;
    }
    const children = part.parts as readonly ChatUIPart<ChatLocalPart>[];
    return children.some(
      (child) =>
        child.type === "message" &&
        "message" in child &&
        ((child as { readonly message: ChatUIMessage<ChatLocalPart> }).message.id === targetId ||
          containsNestedMessage(
            (child as { readonly message: ChatUIMessage<ChatLocalPart> }).message,
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
>(options: ChatClientOptions<TLocalPart>): ChatClient<ChatUIMessage<TLocalPart>> {
  // Validate before allocating the owned root scope so malformed configuration
  // cannot leave a scope behind while the controller is being constructed.
  normalizeQueueOption(options.queue);
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
): ChatClient<ChatUIMessage<TLocalPart>> {
  const controller = new ChatClientController<TLocalPart>(
    runtime.bootstrapScope,
    runtime.initialized,
    options,
    null,
    () => runtime.scope,
  );
  return controller;
}
