import { installOperationMiddleware } from "@sweatpants/foundation";
import { EventType } from "@ag-ui/core";
import {
  call,
  createScope,
  each,
  scoped,
  spawn,
  suspend,
  useAbortSignal,
  useScope,
  withResolvers,
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
  advanceConversationAuthority,
  appendAGUIMessage,
  ConversationSegmentValidator,
  createChatProjection,
  isConversationAuthorityFrame,
  isConversationWindowFrame,
  materializeChatMessages,
  type ConversationAuthority,
  type ConversationStreamEvent,
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
import {
  createPipeline,
  markdown,
  shiki,
  mermaid,
  math,
  resolveProcessors,
  type PipelineConfig,
  type Processor,
  type ProcessorPreset,
} from "@sweatpants/frame-renderer";
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
  /** Explicitly declare that no durable conversation head exists yet. */
  readonly initialConversation?: "new";
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
  loadOlder(): Promise<void>;
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

type RequestTaskOutcome =
  | { readonly ok: true; readonly terminal: AGUIEvent | null }
  | { readonly ok: false; readonly error: unknown };

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

function initialPreludeComplete(events: readonly ConversationStreamEvent[]): boolean {
  if (events[0]?.type === EventType.RUN_ERROR) {
    return true;
  }
  if (isConversationAuthorityFrame(events[0]!) && events[1]?.type === EventType.RUN_ERROR) {
    return true;
  }
  if (events[0]?.type === EventType.RUN_STARTED) {
    return (
      events[1] !== undefined &&
      events[2] !== undefined &&
      isConversationWindowFrame(events[1]) &&
      isConversationAuthorityFrame(events[2]) &&
      events[2].authority.state === "running"
    );
  }
  return (
    events[0] !== undefined &&
    events[1] !== undefined &&
    isConversationWindowFrame(events[0]) &&
    isConversationAuthorityFrame(events[1])
  );
}

function commandLifetime(): { readonly issuedAt: number; readonly expiresAt: number } {
  const issuedAt = Date.now();
  return { issuedAt, expiresAt: issuedAt + 5 * 60_000 };
}

function makeInitialSnapshot<TLocalPart extends ChatLocalPart = never>(): ChatUISnapshot<
  ChatUIMessage<TLocalPart>
> {
  return deepFreeze({
    messages: Object.freeze([]),
    history: Object.freeze({ hasOlder: false, loadingOlder: false, error: null }),
    applicationState: Object.freeze({}),
    authority: null,
    canSendMessage: false,
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

function pendingUserMessage<TLocalPart extends ChatLocalPart = never>(
  message: Extract<ChatTransportRequestMessage, { role: "user" }>,
): ChatUIMessage<TLocalPart> | null {
  return (
    materializeChatMessages<TLocalPart>(appendAGUIMessage(createChatProjection(), message))[0] ??
    null
  );
}

function userContentToWire(
  content: ChatContent,
): Extract<ChatTransportRequestMessage, { role: "user" }>["content"] {
  if (typeof content === "string") {
    return content;
  }
  return content.map((part: ChatContentPart) => {
    if (part.type === "text") {
      return { type: "text", text: part.text };
    }
    return part.metadata === null
      ? { type: part.type, source: part.source }
      : { type: part.type, source: part.source, metadata: part.metadata };
  });
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
    whenBusy: option.whenBusy ?? base.whenBusy,
    maxSize: option.maxSize ?? base.maxSize,
    onOverflow: option.onOverflow ?? base.onOverflow,
  };
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
  private readonly pendingUserMessages = new Map<string, ChatUIMessage<TLocalPart>>();
  private clientScope: Scope | null = null;
  private commandScope: Scope | null = null;
  private destroyClientScope: (() => Promise<void>) | null = null;
  private bootstrapTask: Task<void> | null = null;
  private activeTask: Task<RequestTaskOutcome> | null = null;
  private readonly intentionallyInterruptedTasks = new WeakSet<Task<RequestTaskOutcome>>();
  /** Monotonic authority survives temporary UI synchronization uncertainty. */
  private authorityBaseline: ConversationAuthority | null = null;
  private lastStreamEventType: string | null = null;
  private olderHistoryCursor: string | null = null;
  private knownWindowToken: string | null = null;
  private historyGeneration = 0;
  private historyLoadPromise: Promise<void> | null = null;
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
    if (options.initialConversation === "new") {
      this.snapshot = deepFreeze({
        ...this.snapshot,
        authority: {
          conversationId: this.threadId,
          revision: null,
          state: "idle",
          activeLogicalTurnId: null,
          activeExecutionId: null,
          latestCompletedExecutionId: null,
        },
        canSendMessage: true,
      });
      this.serverSnapshot = this.snapshot;
      this.authorityBaseline = this.snapshot.authority;
    }
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

  loadOlder(): Promise<void> {
    if (this.historyLoadPromise) {
      return this.historyLoadPromise;
    }
    const pending = this.enqueueCommand(() => ChatClientApi.operations.loadOlder());
    const tracked = pending.finally(() => {
      if (this.historyLoadPromise === tracked) {
        this.historyLoadPromise = null;
      }
    });
    this.historyLoadPromise = tracked;
    return tracked;
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
      yield* installOperationMiddleware(ChatClientApi, this.options.middleware);
    }
    if (this.options.eventMiddleware) {
      yield* installOperationMiddleware(ChatEventApi, this.options.eventMiddleware);
    }
    if (this.options.transport?.middleware) {
      yield* installOperationMiddleware(ChatTransportPort.api, this.options.transport.middleware);
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
              api: this.options.api,
              fetch: this.options.fetcher,
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
        resolveProcessors(processors);
      }
      this.publish({ renderStatus: "ready" });
    } catch (error) {
      const failure = asChatClientError(
        error,
        "chat_pipeline_failed",
        "Chat pipeline configuration failed",
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
    if (this.snapshot.authority === null) {
      yield* this.reconnectImpl();
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
      loadOlder: () => this.loadOlderHistory(),
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

  private transportIdentity(): Pick<
    ChatTransportRequest,
    "clientId" | "conversationId" | "knownWindowToken"
  > {
    return {
      clientId: this.id,
      conversationId: this.threadId,
      /* CONDITIONAL-SPREAD: Omitting knownWindowToken preserves existing projection fields when this partial update is merged. */
      ...(this.knownWindowToken === null ? {} : { knownWindowToken: this.knownWindowToken }),
    };
  }

  private *sendMessageImpl(input: UserMessageInput, options: SendMessageOptions): Operation<void> {
    this.ensureOpen();
    const authority = this.snapshot.authority;
    if (authority?.state === "deleted") {
      throw new ChatClientError("chat_conversation_deleted", "Conversation is deleted");
    }
    if (this.activeTask || (authority !== null && authority.state !== "idle")) {
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
      if (this.snapshot.authority?.state !== "idle") {
        throw new ChatClientError(
          "chat_authority_not_idle",
          "Conversation did not become idle after interruption",
        );
      }
    }
    const commandAuthority = this.snapshot.authority;
    if (commandAuthority === null) {
      throw new ChatClientError(
        "chat_authority_unknown",
        "Conversation authority must be hydrated before sending a message",
      );
    }

    const wire = createUserWire(input);
    this.manualMessages = null;
    const pending = pendingUserMessage<TLocalPart>(wire);
    if (!pending) {
      throw new ChatClientError(
        "chat_event_invalid",
        `Unable to materialize pending user message ${wire.id}`,
      );
    }
    this.pendingUserMessages.set(wire.id, pending);
    const runId = crypto.randomUUID();
    this.publishProjection({
      authority: null,
      status: "submitted",
      error: null,
      connectionStatus: "connecting",
      runId,
    });
    const request: ChatTransportRequest = {
      command: {
        type: "send-message",
        commandId: runId,
        ...commandLifetime(),
        basisRevision: commandAuthority.revision,
        messageId: wire.id,
      },
      ...this.transportIdentity(),
      userMessage: wire,
      runId,
      state: this.state,
      context: this.context,
      forwardedProps: options.forwardedProps ?? this.forwardedProps,
    };
    const terminal = yield* this.runRequest(request);
    yield* this.finishRequest(terminal);
  }

  private *regenerateImpl(options: RegenerateOptions): Operation<void> {
    this.ensureOpen();
    if (this.activeTask || this.snapshot.authority?.state !== "idle") {
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
      command: {
        type: "regenerate",
        commandId: runId,
        ...commandLifetime(),
        basisRevision: this.snapshot.authority?.revision ?? null,
        /* CONDITIONAL-SPREAD: Omitting targetMessageId preserves existing projection fields when this partial update is merged. */
        ...(target === undefined ? {} : { targetMessageId: target }),
      },
      ...this.transportIdentity(),
      runId,
      state: this.state,
      context: this.context,
      forwardedProps: options.forwardedProps ?? this.forwardedProps,
    };
    this.publish({ authority: null, status: "submitted", connectionStatus: "connecting", runId });
    const terminal = yield* this.runRequest(request);
    yield* this.finishRequest(terminal);
  }

  private *stopImpl(reason: string): Operation<void> {
    this.ensureOpen();
    if (reason === "user") {
      this.rejectQueued(new ChatClientError("chat_busy_dropped", "Queued messages were stopped"));
    }
    const active = this.activeTask;
    const authority = this.snapshot.authority;
    if (authority !== null && authority.state !== "idle" && authority.state !== "deleted") {
      const signal = yield* useAbortSignal();
      const cancellationRunId = crypto.randomUUID();
      const cancellation: ChatTransportRequest = {
        command: {
          type: "interrupt-turn",
          commandId: cancellationRunId,
          ...commandLifetime(),
          basisRevision: authority.revision,
          logicalTurnId: authority.activeLogicalTurnId,
          executionId: authority.activeExecutionId,
          reason,
        },
        ...this.transportIdentity(),
        runId: cancellationRunId,
        state: this.state,
        context: this.context,
        forwardedProps: this.forwardedProps,
      };
      try {
        this.publish({ authority: null, connectionStatus: "connecting" });
        const stream = yield* ChatTransportPort.api.operations.sendMessages(cancellation, signal);
        // Once the Host has accepted the explicit control request, the old
        // response consumer is obsolete. Halt only that consumer; Host-owned
        // workflow host, cleanup, writer, and terminal publication continue.
        if (active) {
          this.intentionallyInterruptedTasks.add(active);
          try {
            yield* active.halt();
          } catch (error) {
            if (!(error instanceof Error) || error.message !== "halted") {
              throw error;
            }
          } finally {
            if (this.activeTask === active) {
              this.activeTask = null;
            }
          }
        }
        const terminal = yield* this.consumeStream(stream, true);
        if (
          terminal?.type !== EventType.RUN_ERROR ||
          terminal.code !== "PROGRAM_CANCELLED" ||
          this.snapshot.authority?.state !== "idle"
        ) {
          throw new ChatClientError(
            "chat_cancel_not_terminal",
            "Host cancellation did not reach authoritative terminal cancellation",
          );
        }
        yield* this.flushPublication({}, true);
      } catch (error) {
        const failure = asChatClientError(
          error,
          "chat_transport_failed",
          "Host cancellation failed",
        );
        this.publish({ error: failure });
        throw failure;
      }
    }
    this.publish({ connectionStatus: "disconnected", status: "ready", runId: null });
    if (authority !== null && authority.state !== "idle" && authority.state !== "deleted") {
      yield* this.reconnectImpl();
    }
  }

  private *reconnectImpl(drainQueued = true): Operation<void> {
    this.ensureOpen();
    const signal = yield* useAbortSignal();
    this.publish({ authority: null, connectionStatus: "connecting" });
    try {
      const stream = yield* ChatTransportPort.api.operations.reconnectToStream(
        this.transportIdentity(),
        signal,
      );
      if (stream === null) {
        this.acceptAuthority({
          conversationId: this.threadId,
          revision: null,
          state: "idle",
          activeLogicalTurnId: null,
          activeExecutionId: null,
          latestCompletedExecutionId: null,
        });
        this.publish({
          authority: this.authorityBaseline,
          connectionStatus: "disconnected",
          status: this.snapshot.status === "error" ? "ready" : this.snapshot.status,
          runId: null,
        });
        return;
      }
      // ConversationWindow.applyWindow owns reset/continue semantics. Keep
      // same-lineage sealed pages available so a reset window can preserve
      // already loaded history while replacing only hot/live state.
      this.manualMessages = null;
      this.publish({ connectionStatus: "connected" });
      const terminal = yield* this.consumeStream(stream, false);
      if (this.snapshot.authority === null) {
        throw new ChatClientError(
          "chat_authority_missing",
          "Conversation hydration ended without authoritative lifecycle state",
        );
      }
      const parked =
        (terminal?.type === EventType.RUN_FINISHED && terminal.outcome?.type === "interrupt") ||
        this.snapshot.authority.state === "parked";
      const authorityActive =
        this.snapshot.authority.state === "running" ||
        this.snapshot.authority.state === "recovering";
      yield* this.flushPublication(
        {
          connectionStatus: "disconnected",
          // CONDITIONAL-SPREAD: preserve existing error unless this segment supplies a terminal diagnostic.
          ...(terminal?.type === EventType.RUN_ERROR
            ? { error: new ChatClientError(terminal.code ?? "chat_run_failed", terminal.message) }
            : {}),
          status:
            terminal?.type === EventType.RUN_ERROR
              ? "error"
              : authorityActive
                ? "streaming"
                : "ready",
          runId: null,
        },
        true,
        drainQueued && !parked,
      );
      // Parked authority itself controls sendability; no request object is retained.
    } catch (error) {
      const failure = asChatClientError(error, "chat_transport_failed", "Chat reconnect failed");
      this.publish({ connectionStatus: "error", status: "error", error: failure });
      throw failure;
    }
  }

  private *loadOlderHistory(): Operation<void> {
    this.ensureOpen();
    const cursor = this.olderHistoryCursor;
    if (cursor === null) {
      return;
    }
    const generation = this.historyGeneration;
    const signal = yield* useAbortSignal();
    this.publish({
      history: { ...this.snapshot.history, loadingOlder: true, error: null },
    });
    try {
      const load = ChatTransportPort.api.operations.loadHistoryPage as
        | undefined
        | ((
            conversationId: string,
            pageCursor: string,
            abortSignal: AbortSignal,
          ) => Operation<import("@sweatpants/chat-core").PublicHistoryPage>);
      if (!load) {
        throw new ChatClientError(
          "chat_transport_unavailable",
          "The chat transport does not support history paging",
        );
      }
      const page = yield* load(this.threadId, cursor, signal);
      if (generation !== this.historyGeneration || cursor !== this.olderHistoryCursor) {
        return;
      }
      this.compactor.applyHistoryPage(page);
      this.olderHistoryCursor = page.nextOlderCursor;
      yield* this.flushPublication(
        {
          history: {
            hasOlder: this.olderHistoryCursor !== null,
            loadingOlder: false,
            error: null,
          },
        },
        true,
        false,
      );
    } catch (error) {
      if (generation !== this.historyGeneration || cursor !== this.olderHistoryCursor) {
        throw error;
      }
      const rawCode =
        error instanceof Error && typeof (error as Error & { code?: unknown }).code === "string"
          ? (error as Error & { code: string }).code
          : "public_history_cursor_invalid";
      const allowed = new Set([
        "public_history_cursor_invalid",
        "public_history_cursor_expired",
        "public_history_frontier_changed",
        "public_root_conflict",
        "public_history_parent_missing",
      ]);
      const historyError = Object.assign(
        error instanceof Error ? error : new Error("Public history page failed"),
        { code: allowed.has(rawCode) ? rawCode : "public_history_cursor_invalid" },
      ) as ChatUISnapshot["history"]["error"];
      this.publish({
        history: { ...this.snapshot.history, loadingOlder: false, error: historyError },
      });
      throw error;
    } finally {
      if (
        generation === this.historyGeneration &&
        cursor === this.olderHistoryCursor &&
        this.snapshot.history.loadingOlder
      ) {
        this.publish({
          history: { ...this.snapshot.history, loadingOlder: false },
        });
      }
    }
  }

  private *disconnect(reason?: string): Operation<void> {
    this.ensureOpen();
    yield* ChatTransportPort.api.operations.disconnect(reason);
    const active = this.activeTask;
    if (active) {
      yield* active.halt();
      this.activeTask = null;
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
    this.publish({});
  }

  private *requestTaskOutcome(request: ChatTransportRequest): Operation<RequestTaskOutcome> {
    try {
      return {
        ok: true,
        terminal: yield* scoped(() => this.requestOperation(request)),
      };
    } catch (error) {
      return { ok: false, error };
    }
  }

  private *runRequest(request: ChatTransportRequest): Operation<AGUIEvent | null> {
    // Paced streams own a background reader. requestTaskOutcome contains reader
    // failures so they become outcomes instead of faulting the long-lived client.
    const task = yield* spawn(() => this.requestTaskOutcome(request));
    this.activeTask = task;
    let failure: ChatClientError | null = null;
    try {
      let outcome: RequestTaskOutcome;
      try {
        outcome = yield* task;
      } catch (error) {
        if (
          this.intentionallyInterruptedTasks.has(task) &&
          error instanceof Error &&
          error.message === "halted"
        ) {
          return null;
        }
        if (error instanceof Error && error.message === "halted") {
          throw error;
        }
        outcome = { ok: false, error };
      }
      if (outcome.ok) {
        return outcome.terminal;
      }
      const transportFailure = asChatClientError(
        outcome.error,
        "chat_transport_failed",
        "Chat request failed",
      );
      const recoverable =
        transportFailure.code === "chat_transport_failed" ||
        transportFailure.code === "chat_transport_truncated";
      if (recoverable && (yield* this.reconcileAcceptedSend(request))) {
        return null;
      }
      failure = transportFailure;
      this.rejectQueued(failure);
      throw failure;
    } finally {
      if (this.activeTask === task) {
        this.activeTask = null;
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
      throw asChatClientError(error, "chat_transport_failed", "Chat request failed");
    }
  }

  private *reconcileAcceptedSend(request: ChatTransportRequest): Operation<boolean> {
    if (
      request.command.type !== "send-message" ||
      this.pendingUserMessages.has(request.command.messageId)
    ) {
      return false;
    }

    try {
      // The original request still owns activeTask. Queue draining resumes in
      // finishRequest after this recovery operation proves terminal authority.
      yield* this.reconnectImpl(false);
    } catch {
      return false;
    }

    const authority = this.snapshot.authority;
    if (authority === null || authority.revision === null) {
      return false;
    }
    const terminalAuthority = authority.state === "idle" || authority.state === "parked";
    const revisionAdvanced =
      request.command.basisRevision === null ||
      BigInt(authority.revision) > BigInt(request.command.basisRevision);
    const userMessageCommitted = !this.pendingUserMessages.has(request.command.messageId);

    return (
      terminalAuthority &&
      revisionAdvanced &&
      userMessageCommitted &&
      this.snapshot.status !== "error"
    );
  }

  private *finishRequest(terminal: AGUIEvent | null): Operation<void> {
    const runError = terminal?.type === EventType.RUN_ERROR ? terminal : null;
    const parked =
      (terminal?.type === EventType.RUN_FINISHED && terminal.outcome?.type === "interrupt") ||
      this.snapshot.authority?.state === "parked";
    const runFailure = runError
      ? new ChatClientError(runError.code ?? "chat_run_error", runError.message)
      : null;
    if (runFailure) {
      this.rejectQueued(runFailure);
    }
    yield* this.flushPublication(
      {
        status: runError ? "error" : "ready",
        connectionStatus: "disconnected",
        runId: null,
        /* CONDITIONAL-SPREAD: Omitting error preserves existing projection fields when this partial update is merged. */
        ...(runFailure ? { error: runFailure } : {}),
      },
      true,
      !parked && runFailure === null,
    );
  }

  private *consumeStream(
    stream: Stream<ConversationStreamEvent, void>,
    requireTerminal: boolean,
  ): Operation<AGUIEvent | null> {
    const validator = new ConversationSegmentValidator();
    const clockInstalled = yield* ChatSchedulerPort.isInstalled();
    let terminalEvent: AGUIEvent | null;
    if (clockInstalled) {
      const pacedTerminal = yield* this.consumePacedStream(stream, validator);
      terminalEvent = pacedTerminal;
    } else {
      const unpacedTerminal = yield* this.consumeUnpacedStream(stream, validator);
      terminalEvent = unpacedTerminal;
    }

    if (this.closed) {
      return terminalEvent;
    }
    if (this.snapshot.authority === null) {
      throw new ChatClientError(
        "chat_authority_missing",
        "Chat stream ended without authoritative lifecycle state",
      );
    }
    if (requireTerminal && terminalEvent?.type === EventType.RUN_FINISHED) {
      const expectedAuthorityState =
        terminalEvent.outcome?.type === "interrupt" ? "parked" : "idle";
      if (this.snapshot.authority.state !== expectedAuthorityState) {
        throw new ChatClientError(
          "chat_authority_terminal_mismatch",
          `Terminal ${terminalEvent.type} requires ${expectedAuthorityState} authority, observed ${this.snapshot.authority.state}@${String(this.snapshot.authority.revision)}`,
        );
      }
    }
    if (
      requireTerminal &&
      terminalEvent === null &&
      (this.snapshot.authority.state === "running" ||
        this.snapshot.authority.state === "recovering")
    ) {
      throw new ChatClientError(
        "chat_transport_truncated",
        `Chat stream ended while conversation authority remained ${this.snapshot.authority.state}@${String(this.snapshot.authority.revision)} (last frame: ${String(this.lastStreamEventType)})`,
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
    stream: Stream<ConversationStreamEvent, void>,
    validator: ConversationSegmentValidator,
  ): Operation<AGUIEvent | null> {
    const events = yield* createEagerBuffer(stream);
    const clock = ChatSchedulerPort.api.operations.clock();
    let terminalEvent: AGUIEvent | null = null;
    let prelude: ConversationStreamEvent[] = [];
    let rollingWindow: ConversationStreamEvent[] = [];
    let segmentStarted = false;

    for (const _tick of yield* each(clock)) {
      // A clock release and the transport reader can settle in the same turn.
      // Yield once so the eager reader's atomic buffer includes all values that
      // causally preceded this presentation tick.
      yield* call(() => Promise.resolve());
      // Completion belongs to this drain. Rendering below may suspend while
      // the reader buffers more events and reaches EOF; those need another tick.
      const drainedState = events.state;
      const publishable: ConversationStreamEvent[] = [];
      for (const event of events.drain()) {
        validator.push(event);
        if (segmentStarted) {
          if (rollingWindow.length > 0) {
            rollingWindow.push(event);
            if (isConversationAuthorityFrame(event)) {
              publishable.push(...rollingWindow);
              rollingWindow = [];
            }
          } else if (isConversationWindowFrame(event)) {
            rollingWindow = [event];
          } else {
            publishable.push(event);
          }
          continue;
        }
        prelude.push(event);
        if (initialPreludeComplete(prelude)) {
          publishable.push(...prelude);
          prelude = [];
          segmentStarted = true;
        }
      }
      if (publishable.length > 0) {
        terminalEvent = (yield* this.publishEventBatch(publishable)) ?? terminalEvent;
      }

      if (terminalEvent !== null) {
        while (events.state.status === "open") {
          yield* call(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
        }
        for (const trailing of events.drain()) {
          validator.push(trailing);
        }
        if (events.state.status === "error") {
          throw events.state.error;
        }
        if (!this.closed) {
          validator.finish();
        }
        return terminalEvent;
      }

      if (drainedState.status === "error") {
        throw drainedState.error;
      }
      if (drainedState.status === "done") {
        if (!this.closed) {
          validator.finish();
        }
        if (prelude.length > 0) {
          terminalEvent = (yield* this.publishEventBatch(prelude)) ?? terminalEvent;
        }
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
    stream: Stream<ConversationStreamEvent, void>,
    validator: ConversationSegmentValidator,
  ): Operation<AGUIEvent | null> {
    const subscription = yield* stream;
    let terminalEvent: AGUIEvent | null = null;
    let prelude: ConversationStreamEvent[] = [];
    let rollingWindow: ConversationStreamEvent[] = [];
    let segmentStarted = false;
    let next = yield* subscription.next();

    while (!next.done) {
      const event = next.value;
      validator.push(event);
      if (segmentStarted) {
        if (rollingWindow.length > 0) {
          rollingWindow.push(event);
          if (isConversationAuthorityFrame(event)) {
            terminalEvent = (yield* this.publishEventBatch(rollingWindow)) ?? terminalEvent;
            rollingWindow = [];
          }
        } else if (isConversationWindowFrame(event)) {
          rollingWindow = [event];
        } else {
          terminalEvent = (yield* this.publishEventBatch([event])) ?? terminalEvent;
        }
      } else {
        prelude.push(event);
        if (initialPreludeComplete(prelude)) {
          terminalEvent = (yield* this.publishEventBatch(prelude)) ?? terminalEvent;
          prelude = [];
          segmentStarted = true;
        }
      }
      next = yield* subscription.next();
    }
    if (!this.closed) {
      validator.finish();
    }
    if (prelude.length > 0) {
      terminalEvent = (yield* this.publishEventBatch(prelude)) ?? terminalEvent;
    }

    return terminalEvent;
  }

  private *publishEventBatch(
    batch: readonly ConversationStreamEvent[],
  ): Operation<AGUIEvent | null> {
    let terminalEvent: AGUIEvent | null = null;
    let presentationCount = 0;
    for (const event of batch) {
      this.lastStreamEventType = String(event.type);
      if (isConversationAuthorityFrame(event)) {
        this.acceptAuthority(event.authority);
        continue;
      }
      if (isConversationWindowFrame(event)) {
        if (event.conversationId !== this.threadId) {
          throw new ChatClientError(
            "conversation_window_invalid",
            `Window for ${event.conversationId} cannot control ${this.threadId}`,
          );
        }
        const actions = this.compactor.applyWindow(event);
        for (const action of actions) {
          yield* this.interpretProjectionAction(action);
        }
        this.knownWindowToken = event.windowToken;
        this.olderHistoryCursor = event.olderHistoryCursor;
        this.historyGeneration += 1;
        this.stagePublication({
          applicationState: event.applicationState,
          history: {
            hasOlder: event.olderHistoryCursor !== null,
            loadingOlder: false,
            error: null,
          },
        });
        presentationCount += 1;
        continue;
      }
      presentationCount += 1;
      yield* ChatEventApi.operations.accept(event);
      if (event.type === EventType.RUN_FINISHED || event.type === EventType.RUN_ERROR) {
        terminalEvent = event;
      }
    }
    if (presentationCount > 0 || Object.keys(this.pendingPublicationChanges).length > 0) {
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

  private acceptAuthority(authority: ConversationAuthority): void {
    try {
      const advanced = advanceConversationAuthority(
        this.authorityBaseline,
        authority,
        this.threadId,
      );
      this.authorityBaseline = advanced;
      if (advanced.state === "deleted") {
        this.compactor.reset();
        this.manualMessages = null;
        this.pendingUserMessages.clear();
        this.knownWindowToken = null;
        this.olderHistoryCursor = null;
        this.historyGeneration += 1;
        this.interaction?.dispose();
        const failure = new ChatClientError("chat_conversation_deleted", "Conversation is deleted");
        const completions = this.queuedCompletions.splice(0);
        this.queued = [];
        for (const completion of completions) {
          completion.reject(failure);
        }
        this.stagePublication({
          history: { hasOlder: false, loadingOlder: false, error: null },
          queue: [],
        });
      }
      if (advanced !== this.snapshot.authority) {
        this.stagePublication({ authority: advanced });
      }
    } catch (error) {
      throw new ChatClientError(
        "chat_authority_invalid",
        error instanceof Error ? error.message : "Conversation authority is invalid",
        error,
      );
    }
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
      /* CONDITIONAL-SPREAD: Omitting runId preserves existing projection fields when this partial update is merged. */
      ...(event.type === EventType.RUN_STARTED ? { runId: event.runId } : {}),
    });
  }

  private *interpretProjectionAction(action: LiveCompactorAction): Operation<void> {
    switch (action.type) {
      case "elicit-observed": {
        const parentRunId = this.pendingPublicationChanges.runId ?? this.snapshot.runId;
        this.interaction?.observe({
          ...action.request,
          /* CONDITIONAL-SPREAD: Omitting parentRunId preserves existing projection fields when this partial update is merged. */
          ...(parentRunId ? { parentRunId } : {}),
        });
        return;
      }
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
    const active = this.activeTask;
    if (active) {
      // Activity projection can render an elicitation before the parked
      // RUN_FINISHED frame is consumed. Retain the local completion and join
      // that response task before opening the resume transport.
      yield* active;
    }
    const payload: Json | undefined =
      completion.action === "cancel"
        ? undefined
        : completion.action === "accept"
          ? { action: "accept", content: completion.content }
          : { action: "decline" };
    const authority = this.snapshot.authority;
    if (authority?.state !== "parked") {
      throw new ChatClientError(
        "chat_authority_not_parked",
        "Elicitation response requires parked conversation authority",
      );
    }
    const runId = crypto.randomUUID();
    const transportRequest: ChatTransportRequest = {
      command: {
        type: "respond-to-elicit",
        commandId: runId,
        ...commandLifetime(),
        basisRevision: authority.revision,
        logicalTurnId: authority.activeLogicalTurnId,
        executionId: authority.activeExecutionId,
        interruptId: request.elicitId,
        status: completion.action === "cancel" ? "cancelled" : "resolved",
        /* CONDITIONAL-SPREAD: Omitting payload preserves existing projection fields when this partial update is merged. */
        ...(payload !== undefined ? { payload } : {}),
      },
      ...this.transportIdentity(),
      runId,
      state: this.state,
      context: this.context,
      forwardedProps: this.forwardedProps,
      /* CONDITIONAL-SPREAD: Omitting parentRunId preserves existing projection fields when this partial update is merged. */
      ...(request.parentRunId ? { parentRunId: request.parentRunId } : {}),
    };
    this.publish({ authority: null, status: "submitted", connectionStatus: "connecting" });
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
    drainQueued = true,
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
    if (drainQueued) {
      yield* this.drainQueue();
    }
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
    for (const id of this.pendingUserMessages.keys()) {
      if (serverMessages.some((message) => message.id === id)) {
        this.pendingUserMessages.delete(id);
      }
    }
    if (this.pendingUserMessages.size > 0) {
      messages = [...serverMessages, ...this.pendingUserMessages.values()];
    }
    if (this.interaction) {
      messages = overlayLocalParts(messages, this.interaction.localParts());
    }
    const serverAuthority = Object.prototype.hasOwnProperty.call(changes, "authority")
      ? (changes.authority ?? null)
      : this.serverSnapshot.authority;
    // Publish the deterministic server view before notifying subscribers so a
    // callback never observes the previous status with the new client view.
    this.serverSnapshot = deepFreeze({
      ...this.serverSnapshot,
      ...changes,
      authority: serverAuthority,
      canSendMessage: serverAuthority?.state === "idle" && this.activeTask === null && !this.closed,
      messages: serverMessages,
      // Busy-send queues are local UX state, never authoritative server state.
      queue: [],
    });
    this.publish({ ...changes, messages }, false);
  }

  private publish(
    changes: Partial<ChatUISnapshot<ChatUIMessage<TLocalPart>>>,
    updateServer = true,
  ): void {
    const authority = Object.prototype.hasOwnProperty.call(changes, "authority")
      ? (changes.authority ?? null)
      : this.snapshot.authority;
    const next = deepFreeze({
      ...this.snapshot,
      ...changes,
      authority,
      canSendMessage: authority?.state === "idle" && this.activeTask === null && !this.closed,
      queue: changes.queue ?? this.queued,
    });
    this.snapshot = next;
    if (updateServer) {
      const serverChanges = Object.fromEntries(
        Object.entries(changes).filter(([key]) => key !== "messages"),
      ) as Partial<ChatUISnapshot<ChatUIMessage<TLocalPart>>>;
      const serverAuthority = Object.prototype.hasOwnProperty.call(serverChanges, "authority")
        ? (serverChanges.authority ?? null)
        : this.serverSnapshot.authority;
      this.serverSnapshot = deepFreeze({
        ...this.serverSnapshot,
        ...serverChanges,
        authority: serverAuthority,
        canSendMessage:
          serverAuthority?.state === "idle" && this.activeTask === null && !this.closed,
        // Do not leak a local successor queue through the authoritative view.
        queue: [],
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
