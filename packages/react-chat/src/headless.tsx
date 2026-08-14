import {
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ComponentProps,
  type ComponentType,
} from "react";
import { call, type Operation } from "effection";
import { raf } from "@effectionx/raf";
import {
  createChatClient as createHeadlessChatClient,
  createChatRuntime as createHeadlessChatRuntime,
  type ChatClient as HeadlessChatClient,
  type ChatClientOptions as HeadlessChatClientOptions,
  type ChatRuntimeOptions as HeadlessChatRuntimeOptions,
  type ChatUISnapshot,
  type ChatUIMessage,
  type ChatUIPart,
  type ChatTransportOptions,
  type ChatFetch,
  type ChatQueueOption,
  type PipelinePreset,
  type ChatClientMiddleware,
  type ChatEventMiddleware,
  type ChatSchedulerDriver,
  ChatSchedulerPort,
} from "@sweatpants/chat-client";
import type { PipelineConfig } from "@sweatpants/chat-client/pipeline";
import type { Json } from "@sweatpants/foundation";
import type { ClientPlugin } from "@sweatpants/tool-session/mcp";
import type { ReactElicitCapabilities } from "./plugin.ts";
import { ReactInteractionRuntime } from "./react-interaction.ts";
import type { ReactRenderPart } from "./react-types.ts";

export type { ReactRenderPart } from "./react-types.ts";

export type ReactChatUIPart = ChatUIPart<ReactRenderPart>;
export type ReactChatUIMessage = ChatUIMessage<ReactRenderPart>;
export type ReactChatClient = HeadlessChatClient<ReactChatUIMessage>;
export interface ReactChatRuntime {
  readonly initialized: Promise<void>;
  createClient(options: CreateReactChatClientOptions): ReactChatClient;
  close(): Promise<void>;
}

export type ReactSchedulerDriver = ChatSchedulerDriver;

function* installRafScheduler(): Operation<void> {
  if (yield* ChatSchedulerPort.isInstalled()) {
    return;
  }
  if (typeof globalThis.requestAnimationFrame !== "function") {
    return;
  }
  yield* ChatSchedulerPort.installDriver({ clock: () => raf });
}

function reactSetup(
  setup: HeadlessChatClientOptions<ReactRenderPart>["setup"],
  scheduler: ReactSchedulerDriver | undefined,
): NonNullable<HeadlessChatClientOptions<ReactRenderPart>["setup"]> {
  return function* (): Operation<void> {
    if (setup) {
      yield* setup();
    }
    if (!scheduler) {
      yield* installRafScheduler();
    }
  };
}

export interface CreateReactChatClientOptions extends Omit<
  HeadlessChatClientOptions<ReactRenderPart>,
  "interaction" | "pipeline"
> {
  readonly runtime?: ReactChatRuntime;
  readonly api?: string;
  readonly pipeline?: PipelinePreset | PipelineConfig;
  readonly plugins?: readonly ClientPlugin<ReactElicitCapabilities>[];
}

export function createChatClient(options: CreateReactChatClientOptions): ReactChatClient {
  const { api, pipeline, plugins, runtime, ...headlessOptions } = options;
  if (runtime) {
    return runtime.createClient({
      ...headlessOptions,
      ...(api !== undefined ? { api } : {}),
      ...(pipeline !== undefined ? { pipeline } : {}),
      ...(plugins !== undefined ? { plugins } : {}),
      ...(options.scheduler !== undefined ? { scheduler: options.scheduler } : {}),
    });
  }
  const transport: ChatTransportOptions | undefined =
    headlessOptions.transport ??
    (api !== undefined || headlessOptions.fetcher !== undefined
      ? {
          http: {
            ...(api !== undefined ? { api } : {}),
            ...(headlessOptions.fetcher !== undefined ? { fetch: headlessOptions.fetcher } : {}),
          },
        }
      : undefined);
  const interaction = new ReactInteractionRuntime(plugins === undefined ? {} : { plugins });
  const clientOptions = {
    ...headlessOptions,
    ...(transport !== undefined ? { transport } : {}),
    setup: reactSetup(headlessOptions.setup, options.scheduler),
    interaction,
    ...(pipeline !== undefined ? { pipeline } : {}),
  } satisfies HeadlessChatClientOptions<ReactRenderPart>;
  return createHeadlessChatClient(clientOptions);
}

export function createChatRuntime(options: HeadlessChatRuntimeOptions = {}): ReactChatRuntime {
  const runtime = createHeadlessChatRuntime(options);
  return {
    initialized: runtime.initialized,
    createClient: (clientOptions) => {
      const { api, pipeline, plugins, ...headlessOptions } = clientOptions;
      const transport: ChatTransportOptions | undefined =
        headlessOptions.transport ??
        (api !== undefined || headlessOptions.fetcher !== undefined
          ? {
              http: {
                ...(api !== undefined ? { api } : {}),
                ...(headlessOptions.fetcher !== undefined
                  ? { fetch: headlessOptions.fetcher }
                  : {}),
              },
            }
          : undefined);
      return runtime.createClient({
        ...headlessOptions,
        ...(transport !== undefined ? { transport } : {}),
        setup: reactSetup(headlessOptions.setup, clientOptions.scheduler),
        interaction: new ReactInteractionRuntime(plugins === undefined ? {} : { plugins }),
        ...(pipeline !== undefined ? { pipeline } : {}),
      });
    },
    close: () => runtime.close(),
  };
}

export type UseChatOptions =
  | {
      readonly client: ReactChatClient;
    }
  | {
      readonly client?: never;
      readonly runtime?: ReactChatRuntime;
      readonly threadId: string;
      readonly api?: string;
      readonly fetcher?: ChatFetch;
      readonly connection?: HeadlessChatClientOptions<ReactRenderPart>["connection"];
      readonly transport?: ChatTransportOptions;
      readonly middleware?: readonly ChatClientMiddleware[];
      readonly eventMiddleware?: readonly ChatEventMiddleware[];
      readonly setup?: HeadlessChatClientOptions<ReactRenderPart>["setup"];
      readonly initialize?: HeadlessChatClientOptions<ReactRenderPart>["initialize"];
      readonly plugins?: readonly ClientPlugin<ReactElicitCapabilities>[];
      readonly pipeline?: PipelinePreset | PipelineConfig;
      readonly scheduler?: ReactSchedulerDriver;
      readonly queue?: ChatQueueOption;
      readonly state?: Json;
      readonly context?: HeadlessChatClientOptions<ReactRenderPart>["context"];
      readonly forwardedProps?: Json;
    };

export interface UseChatResult {
  readonly messages: readonly ReactChatUIMessage[];
  readonly authority: ChatUISnapshot<ReactChatUIMessage>["authority"];
  readonly canSendMessage: boolean;
  readonly status: ChatUISnapshot<ReactChatUIMessage>["status"];
  readonly connectionStatus: ChatUISnapshot<ReactChatUIMessage>["connectionStatus"];
  readonly renderStatus: ChatUISnapshot<ReactChatUIMessage>["renderStatus"];
  readonly error: Error | null;
  readonly runId: ChatUISnapshot<ReactChatUIMessage>["runId"];
  readonly queue: ChatUISnapshot<ReactChatUIMessage>["queue"];
  readonly client: ReactChatClient;
  readonly sendMessage: ReactChatClient["sendMessage"];
  readonly regenerate: ReactChatClient["regenerate"];
  readonly stop: ReactChatClient["stop"];
  readonly reconnect: ReactChatClient["reconnect"];
  readonly cancelQueued: ReactChatClient["cancelQueued"];
  readonly setMessages: ReactChatClient["setMessages"];
  readonly clearError: ReactChatClient["clearError"];
}

type OwnedUseChatOptions = Extract<UseChatOptions, { readonly threadId: string }>;
type ExternalUseChatOptions = Extract<UseChatOptions, { readonly client: ReactChatClient }>;

interface PendingCommand {
  run(client: ReactChatClient): void;
  reject(error: unknown): void;
}

interface PendingOwnedChat {
  readonly client: ReactChatClient;
  start(): void;
  close(): Promise<void>;
}

function createPendingOwnedChat(options: OwnedUseChatOptions): PendingOwnedChat {
  const clientId = crypto.randomUUID();
  const pendingSnapshot: ChatUISnapshot<ReactChatUIMessage> = Object.freeze({
    messages: Object.freeze([]) as readonly ReactChatUIMessage[],
    authority: null,
    canSendMessage: false,
    status: "ready",
    connectionStatus: "disconnected",
    renderStatus: "loading",
    error: null,
    runId: null,
    queue: Object.freeze([]),
  });
  const listeners = new Set<() => void>();
  const pendingCommands: PendingCommand[] = [];
  const pendingMessageUpdates: Array<(client: ReactChatClient) => void> = [];
  let resolveInitialized!: () => void;
  let rejectInitialized!: (error: unknown) => void;
  const initialized = new Promise<void>((resolve, reject) => {
    resolveInitialized = resolve;
    rejectInitialized = reject;
  });
  void initialized.catch(() => undefined);
  let actual: ReactChatClient | null = null;
  let actualUnsubscribe: (() => void) | undefined;
  let runtimeToClose: ReactChatRuntime | null = null;
  let started = false;
  let closed = false;

  const notify = (): void => {
    for (const listener of [...listeners]) {
      listener();
    }
  };

  const rejectPending = (error: unknown): void => {
    for (const command of pendingCommands.splice(0)) {
      command.reject(error);
    }
    pendingMessageUpdates.splice(0);
  };

  const flushPending = (client: ReactChatClient): void => {
    for (const update of pendingMessageUpdates.splice(0)) {
      update(client);
    }
    for (const command of pendingCommands.splice(0)) {
      command.run(client);
    }
  };

  const attach = (client: ReactChatClient): void => {
    actual = client;
    actualUnsubscribe = client.subscribe(notify);
    client.initialized.then(
      () => {
        if (closed) {
          return;
        }
        resolveInitialized();
        flushPending(client);
        notify();
      },
      (error) => {
        rejectInitialized(error);
        rejectPending(error);
        notify();
      },
    );
  };

  const invoke = <T,>(operation: (client: ReactChatClient) => Promise<T>): Promise<T> => {
    if (actual) {
      return operation(actual);
    }
    if (closed) {
      return Promise.reject(new Error("Owned React chat client is closed"));
    }
    return new Promise<T>((resolve, reject) => {
      pendingCommands.push({
        run(client) {
          try {
            void operation(client).then(resolve, reject);
          } catch (error) {
            reject(error);
          }
        },
        reject,
      });
    });
  };

  const transport: ReactChatClient["transport"] = {
    getSnapshot: () => actual?.transport.getSnapshot() ?? { status: "disconnected", error: null },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reconnect: () => invoke((client) => client.transport.reconnect()),
    disconnect: (reason) => invoke((client) => client.transport.disconnect(reason)),
  };

  const closeClient = async (): Promise<void> => {
    if (closed) {
      return;
    }
    closed = true;
    const error = new Error("Owned React chat client is closed");
    rejectInitialized(error);
    rejectPending(error);
    actualUnsubscribe?.();
    actualUnsubscribe = undefined;
    try {
      await actual?.close();
    } finally {
      await runtimeToClose?.close();
      runtimeToClose = null;
    }
  };

  const client = {
    id: clientId,
    threadId: options.threadId,
    initialized,
    transport,
    getSnapshot: () => actual?.getSnapshot() ?? pendingSnapshot,
    getServerSnapshot: () => actual?.getServerSnapshot() ?? pendingSnapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    sendMessage: (
      input: Parameters<ReactChatClient["sendMessage"]>[0],
      sendOptions?: Parameters<ReactChatClient["sendMessage"]>[1],
    ) => invoke((owned) => owned.sendMessage(input, sendOptions)),
    regenerate: (regenerateOptions?: Parameters<ReactChatClient["regenerate"]>[0]) =>
      invoke((owned) => owned.regenerate(regenerateOptions)),
    stop: () => invoke((owned) => owned.stop()),
    reconnect: () => invoke((owned) => owned.reconnect()),
    cancelQueued: (id: string) => invoke((owned) => owned.cancelQueued(id)),
    setMessages(update: Parameters<ReactChatClient["setMessages"]>[0]): void {
      if (actual) {
        actual.setMessages(update);
        return;
      }
      if (closed) {
        throw new Error("Owned React chat client is closed");
      }
      pendingMessageUpdates.push((owned) => owned.setMessages(update));
    },
    clearError(): void {
      if (actual) {
        actual.clearError();
        return;
      }
      if (closed) {
        throw new Error("Owned React chat client is closed");
      }
      pendingMessageUpdates.push((owned) => owned.clearError());
    },
    close: closeClient,
  } satisfies ReactChatClient;

  return {
    client,
    start(): void {
      if (started || closed) {
        return;
      }
      started = true;
      const runtime = options.runtime ?? createChatRuntime();
      runtimeToClose = options.runtime === undefined ? runtime : null;
      try {
        const createdOptions: CreateReactChatClientOptions = {
          threadId: options.threadId,
          clientId,
          runtime,
          ...(options.api !== undefined ? { api: options.api } : {}),
          ...(options.fetcher !== undefined ? { fetcher: options.fetcher } : {}),
          ...(options.connection !== undefined ? { connection: options.connection } : {}),
          ...(options.transport !== undefined ? { transport: options.transport } : {}),
          ...(options.middleware !== undefined ? { middleware: options.middleware } : {}),
          ...(options.eventMiddleware !== undefined
            ? { eventMiddleware: options.eventMiddleware }
            : {}),
          ...(options.setup !== undefined ? { setup: options.setup } : {}),
          initialize:
            options.initialize ??
            (function* (control): Operation<void> {
              yield* call(() => control.reconnect());
            } satisfies NonNullable<HeadlessChatClientOptions<ReactRenderPart>["initialize"]>),
          ...(options.plugins !== undefined ? { plugins: options.plugins } : {}),
          ...(options.pipeline !== undefined ? { pipeline: options.pipeline } : {}),
          ...(options.scheduler !== undefined ? { scheduler: options.scheduler } : {}),
          ...(options.queue !== undefined ? { queue: options.queue } : {}),
          ...(options.state !== undefined ? { state: options.state } : {}),
          ...(options.context !== undefined ? { context: options.context } : {}),
          ...(options.forwardedProps !== undefined
            ? { forwardedProps: options.forwardedProps }
            : {}),
        };
        attach(createChatClient(createdOptions));
      } catch (error) {
        rejectInitialized(error);
        rejectPending(error);
        void runtimeToClose?.close();
        runtimeToClose = null;
      }
    },
    close: closeClient,
  };
}

function isExternalOptions(options: UseChatOptions): options is ExternalUseChatOptions {
  return "client" in options;
}

function ownedIdentity(options: OwnedUseChatOptions): string {
  return JSON.stringify({
    threadId: options.threadId,
    api: options.api,
    state: options.state,
    context: options.context,
    forwardedProps: options.forwardedProps,
    queue: options.queue,
    pipeline:
      typeof options.pipeline === "string" ? options.pipeline : options.pipeline?.processors,
    plugins: options.plugins?.map((plugin) => ({
      toolName: plugin.client.toolName,
      ownerInterfaceDigest: plugin.client.ownerInterfaceDigest,
      bindingIds: [...plugin.client.bindings.keys()],
    })),
  });
}

/** Thin external-store React adapter over the headless ChatClient. */
export function useHeadlessChat(options: UseChatOptions): UseChatResult {
  const external = isExternalOptions(options);
  const identity = external ? "external" : ownedIdentity(options);
  const externalClient = external ? options.client : null;
  const owned = useMemo(() => {
    if (externalClient) {
      return { client: externalClient, resource: null as PendingOwnedChat | null };
    }
    const resource = createPendingOwnedChat(options as OwnedUseChatOptions);
    return { client: resource.client, resource };
    // The identity is intentionally the only configuration dependency. The
    // pending resource has no scope or network side effects during render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity, externalClient]);

  const client = owned.client;
  const ownedResourceRef = useRef<PendingOwnedChat | null>(owned.resource);
  ownedResourceRef.current = owned.resource;
  const ownershipGeneration = useRef(0);
  useEffect(() => {
    const resource = owned.resource;
    if (!resource) {
      return;
    }
    const generation = ++ownershipGeneration.current;
    resource.start();
    return () => {
      queueMicrotask(() => {
        // eslint-disable-next-line react-hooks/exhaustive-deps -- The live generation intentionally detects a remount before deferred teardown.
        if (ownershipGeneration.current !== generation && ownedResourceRef.current === resource) {
          return;
        }
        void resource.close();
      });
    };
  }, [owned.resource]);

  const snapshot = useSyncExternalStore(
    client.subscribe.bind(client),
    client.getSnapshot.bind(client),
    client.getServerSnapshot.bind(client),
  );
  return {
    ...snapshot,
    client,
    sendMessage: client.sendMessage.bind(client),
    regenerate: client.regenerate.bind(client),
    stop: client.stop.bind(client),
    reconnect: client.reconnect.bind(client),
    cancelQueued: client.cancelQueued.bind(client),
    setMessages: client.setMessages.bind(client),
    clearError: client.clearError.bind(client),
  };
}

export type ReactRenderableProps<TResponse = unknown> = {
  readonly onRespond: (value: TResponse) => void;
  readonly disabled?: boolean;
  readonly response?: TResponse;
};

export type ReactResponseFor<TComponent extends ComponentType<unknown>> =
  ComponentProps<TComponent> extends {
    readonly onRespond: (value: infer TResponse) => void;
  }
    ? TResponse
    : never;
