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
  type ChatSnapshot,
  type ChatMessage,
  type ChatPart,
  type ChatTransportOptions,
  type PipelinePreset,
  type ChatClientMiddleware,
  type ChatEventMiddleware,
  type ChatSchedulerDriver,
  ChatSchedulerPort,
} from "@sweatpants/chat-client";
import type { PipelineConfig } from "@sweatpants/chat-client/pipeline";
import type { ClientPlugin } from "@sweatpants/tool-session/mcp";
import type { ReactElicitCapabilities } from "./plugin.ts";
import { ReactInteractionRuntime } from "./react-interaction.ts";
import type { ReactRenderPart } from "./react-types.ts";

export type { ReactRenderPart } from "./react-types.ts";

export type ReactChatPart = ChatPart<ReactRenderPart>;
export type ReactChatMessage = ChatMessage<ReactRenderPart>;
export type ReactChatClient = HeadlessChatClient<ReactChatMessage>;
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
    headlessOptions.transport ?? (api ? { http: { api } } : undefined);
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
        headlessOptions.transport ?? (api ? { http: { api } } : undefined);
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
      readonly conversationId: string;
      readonly api?: string;
      readonly transport?: ChatTransportOptions;
      readonly middleware?: readonly ChatClientMiddleware[];
      readonly eventMiddleware?: readonly ChatEventMiddleware[];
      readonly setup?: HeadlessChatClientOptions<ReactRenderPart>["setup"];
      readonly initialize?: HeadlessChatClientOptions<ReactRenderPart>["initialize"];
      readonly plugins?: readonly ClientPlugin<ReactElicitCapabilities>[];
      readonly pipeline?: PipelinePreset | PipelineConfig;
      readonly scheduler?: ReactSchedulerDriver;
      readonly busy?: "queue" | "drop" | "interrupt";
    };

export interface UseChatResult {
  readonly messages: readonly ReactChatMessage[];
  readonly status: ChatSnapshot<ReactChatMessage>["status"];
  readonly connectionStatus: ChatSnapshot<ReactChatMessage>["connectionStatus"];
  readonly renderStatus: ChatSnapshot<ReactChatMessage>["renderStatus"];
  readonly error: Error | null;
  readonly queuedMessages: ChatSnapshot<ReactChatMessage>["queuedMessages"];
  readonly client: ReactChatClient;
  readonly sendMessage: ReactChatClient["sendMessage"];
  readonly regenerate: ReactChatClient["regenerate"];
  readonly stop: ReactChatClient["stop"];
  readonly reconnect: ReactChatClient["reconnect"];
  readonly setMessages: ReactChatClient["setMessages"];
  readonly clearError: ReactChatClient["clearError"];
}

type OwnedUseChatOptions = Extract<UseChatOptions, { readonly conversationId: string }>;
type ExternalUseChatOptions = Extract<UseChatOptions, { readonly client: ReactChatClient }>;

function isExternalOptions(options: UseChatOptions): options is ExternalUseChatOptions {
  return "client" in options;
}

function ownedIdentity(options: OwnedUseChatOptions): string {
  return JSON.stringify({
    conversationId: options.conversationId,
    api: options.api,
    busy: options.busy,
    pipeline:
      typeof options.pipeline === "string" ? options.pipeline : options.pipeline?.processors,
    plugins: options.plugins?.map((plugin) => plugin.client.toolName),
  });
}

/** Thin external-store React adapter over the headless ChatClient. */
export function useHeadlessChat(options: UseChatOptions): UseChatResult {
  const external = isExternalOptions(options);
  const identity = external ? "external" : ownedIdentity(options);
  const owned = useMemo(() => {
    if (isExternalOptions(options)) {
      return { client: options.client, runtime: null as ReactChatRuntime | null };
    }
    const ownedOptions: OwnedUseChatOptions = options;
    const ownedRuntime = ownedOptions.runtime ?? createChatRuntime();
    const createdOptions: CreateReactChatClientOptions = {
      conversationId: ownedOptions.conversationId,
      ...(ownedOptions.runtime !== undefined ? { runtime: ownedOptions.runtime } : {}),
      ...(ownedOptions.api !== undefined ? { api: ownedOptions.api } : {}),
      ...(ownedOptions.transport !== undefined ? { transport: ownedOptions.transport } : {}),
      ...(ownedOptions.middleware !== undefined ? { middleware: ownedOptions.middleware } : {}),
      ...(ownedOptions.eventMiddleware !== undefined
        ? { eventMiddleware: ownedOptions.eventMiddleware }
        : {}),
      ...(ownedOptions.setup !== undefined ? { setup: ownedOptions.setup } : {}),
      initialize:
        ownedOptions.initialize ??
        (function* (control): Operation<void> {
          yield* call(() => control.reconnect());
        } satisfies NonNullable<HeadlessChatClientOptions<ReactRenderPart>["initialize"]>),
      ...(ownedOptions.pipeline !== undefined ? { pipeline: ownedOptions.pipeline } : {}),
      ...(ownedOptions.scheduler !== undefined ? { scheduler: ownedOptions.scheduler } : {}),
      ...(ownedOptions.busy !== undefined ? { busy: ownedOptions.busy } : {}),
      ...(ownedOptions.plugins !== undefined ? { plugins: ownedOptions.plugins } : {}),
    };
    return {
      client: createChatClient({ ...createdOptions, runtime: ownedRuntime }),
      runtime: ownedOptions.runtime === undefined ? ownedRuntime : null,
    };
    // The identity is intentionally the only dependency: option objects are
    // configuration values, not an invitation to recreate an active client.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity]);

  const client = owned.client;
  const ownershipGeneration = useRef(0);
  useEffect(() => {
    if (external) {
      return;
    }
    const generation = ++ownershipGeneration.current;
    return () => {
      queueMicrotask(() => {
        // eslint-disable-next-line react-hooks/exhaustive-deps -- The live generation intentionally detects a remount before deferred teardown.
        if (ownershipGeneration.current !== generation) {
          return;
        }
        void client.close();
        void owned.runtime?.close();
      });
    };
  }, [client, external, owned.runtime]);

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
