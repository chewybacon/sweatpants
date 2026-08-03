import {
  createScope,
  suspend,
  useScope,
  withResolvers,
  type Around,
  type Operation,
} from "effection";
import { ChatClientError, asChatClientError } from "./errors.ts";
import { ChatClientApi, ChatEventApi, ChatTransportPort } from "./ports.ts";
import { createHttpTransport } from "./http.ts";
import {
  createClientFromRuntime,
  type ChatClient,
  type ChatClientOptions,
  type ChatRuntimeOptions,
  type ChatRuntimeControl,
  type InternalRuntime,
} from "./client.ts";
import type { ClientChatMessage as ChatMessage } from "@sweatpants/chat-core";

function* installMiddleware<T extends object>(
  api: { around(middleware: Partial<Around<T>>): Operation<void> },
  middleware: readonly Partial<Around<T>>[],
): Operation<void> {
  for (const item of middleware) {
    yield* api.around(item);
  }
}

function isPortDriverDuplicate(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as Error & { readonly code?: unknown }).code === "port_driver_duplicate"
  );
}

export interface ChatRuntime {
  readonly initialized: Promise<void>;
  createClient<TLocalPart extends { readonly type: string; readonly id: string } = never>(
    options: ChatClientOptions<TLocalPart>,
  ): ChatClient<ChatMessage<TLocalPart>>;
  close(): Promise<void>;
}

export function createChatRuntime(options: ChatRuntimeOptions = {}): ChatRuntime {
  const [scope, destroy] = createScope();
  const initialized = withResolvers<void>("chat runtime initialization");
  const initializedTask = scope.run(() => initialized.operation);
  void initializedTask.catch(() => undefined);
  let initializationFinished = false;
  let closed = false;
  const internal: InternalRuntime = {
    bootstrapScope: scope,
    scope,
    initialized: initializedTask,
  };

  const initTask = scope.run(function* (): Operation<void> {
    try {
      internal.scope = yield* useScope();
      if (options.setup) {
        yield* options.setup();
      }
      if (options.middleware) {
        yield* installMiddleware(ChatClientApi, options.middleware);
      }
      if (options.eventMiddleware) {
        yield* installMiddleware(ChatEventApi, options.eventMiddleware);
      }
      if (options.transport?.middleware) {
        yield* installMiddleware(ChatTransportPort.api, options.transport.middleware);
      }
      const connection = options.connection ?? options.transport?.driver;
      if (connection) {
        try {
          yield* ChatTransportPort.installDriver(connection);
        } catch (error) {
          if (!isPortDriverDuplicate(error)) {
            throw error;
          }
          throw new ChatClientError(
            "chat_driver_duplicate",
            "Duplicate chat transport driver in runtime scope",
            error,
          );
        }
      }
      // A runtime may opt into a concrete HTTP transport for all children. It
      // remains a composition-owned default, not a hidden global singleton.
      if (
        !connection &&
        (options.transport?.http || options.api !== undefined || options.fetcher !== undefined)
      ) {
        yield* ChatTransportPort.installDriver(
          createHttpTransport(
            options.transport?.http ??
              (options.api !== undefined || options.fetcher !== undefined
                ? {
                    ...(options.api !== undefined ? { api: options.api } : {}),
                    ...(options.fetcher !== undefined ? { fetch: options.fetcher } : {}),
                  }
                : undefined),
          ),
        );
      }
      if (options.initialize) {
        const control: ChatRuntimeControl = { initialized: initializedTask, scope };
        yield* options.initialize(control);
      }
      initializationFinished = true;
      initialized.resolve(undefined);
      yield* suspend();
    } catch (error) {
      const failure = asChatClientError(
        error,
        "chat_client_initialization_failed",
        "Chat runtime initialization failed",
      );
      initialized.reject(failure);
      throw failure;
    }
  });
  void initTask.catch(() => undefined);

  return {
    initialized: initializedTask,
    createClient<TLocalPart extends { readonly type: string; readonly id: string } = never>(
      clientOptions: ChatClientOptions<TLocalPart>,
    ) {
      if (closed) {
        throw new ChatClientError("chat_client_closed", "Chat runtime is closed");
      }
      return createClientFromRuntime(internal, clientOptions);
    },
    close: async () => {
      if (closed) {
        return;
      }
      closed = true;
      if (!initializationFinished) {
        initialized.reject(new ChatClientError("chat_client_closed", "Chat runtime is closed"));
      }
      try {
        await destroy();
      } catch (error) {
        throw asChatClientError(error, "chat_client_closed", "Chat runtime close failed");
      }
    },
  };
}
