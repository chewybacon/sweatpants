export * from "./ag-ui.ts";
export * from "./model.ts";
export * from "./history.ts";
export * from "./chat.ts";
export * from "./transport.ts";
export * from "./scenario.ts";

import { createAgUiProbe } from "./ag-ui.ts";
import { createPiAiModelProvider } from "@sweatpants/model-provider-pi-ai";
import { type Model, type StreamOptions } from "@sweatpants/model-provider";
import { call, createScope, type Operation } from "effection";
import { createChatRuntime, type ChatFetch, type ChatRuntime } from "./chat.ts";
import {
  startModelSimulator,
  type ModelHandle,
  type ModelSimulator,
  type PendingModelRequest,
} from "./model.ts";
import { createStreamTransportHandle } from "./transport.ts";
import { scenario, type ScenarioContext } from "./scenario.ts";

/** Optional application-owned seams used by causal lifecycle scenarios. */
export interface TestApplicationScenario {
  /** Graceful, composition-owned shutdown of the active Host generation. */
  gracefulShutdown?(options: { graceMs: number }): Promise<void>;
  armFault?(point: string): Promise<void>;
  waitForFault?(point: string): Promise<void>;
  readHistory?(sessionId: string, cursor?: string): Promise<unknown>;
  checkpointEvidence?(executionId: string): Promise<unknown | null>;
  storageMetrics?(): Promise<unknown>;
  /** Checkpoint persistence errors are non-fatal in production but fatal in tests. */
  checkpointErrors?(): Promise<readonly unknown[]>;
}

export interface TestApplication {
  handle(request: Request): Promise<Response>;
  close(): Promise<void>;
  trace?(conversationId: string): Promise<unknown>;
  scenario?: TestApplicationScenario;
}

interface NativeChatTestEndpoints {
  readonly postChat: (request: Request) => Promise<Response>;
  readonly readChat: (input: { request: Request; conversationId: string }) => Promise<Response>;
  readonly pageHistory: (input: { request: Request; conversationId: string }) => Promise<Response>;
}

interface EndpointApplication {
  handleEndpoint<Input>(
    endpoint: (input: Input) => Promise<Response>,
    input: Input,
  ): Promise<Response>;
  close(): Promise<void>;
}

function conversationIdAt(pathname: string, suffix = ""): string | null {
  const match = new RegExp(`^/api/chat/([^/]+)${suffix}/?$`).exec(pathname);
  if (!match) {
    return null;
  }
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return null;
  }
}

/** Route adapter used by test servers that mount the native chat HTTP contract. */
export function routeNativeChatTestApplication(
  application: EndpointApplication,
  endpoints: NativeChatTestEndpoints,
): TestApplication {
  return {
    async handle(request: Request): Promise<Response> {
      if (request.method.toUpperCase() !== "POST") {
        return new Response(null, { status: 405, headers: { Allow: "POST" } });
      }
      const pathname = new URL(request.url).pathname;
      if (pathname === "/api/chat" || pathname === "/chat") {
        return application.handleEndpoint(endpoints.postChat, request);
      }
      const historyConversationId = conversationIdAt(pathname, "/history:page");
      if (historyConversationId) {
        return application.handleEndpoint(endpoints.pageHistory, {
          request,
          conversationId: historyConversationId,
        });
      }
      const conversationId = conversationIdAt(pathname);
      if (conversationId) {
        return application.handleEndpoint(endpoints.readChat, { request, conversationId });
      }
      return new Response(null, { status: 404 });
    },
    close: () => application.close(),
  };
}

export interface TestModelInstallation {
  baseUrl: string;
  apiKey: string;
  modelId: string;
  providerOptions: { cacheRetention: "short" };
  compat: { sendSessionAffinityHeaders: true; sendSessionIdHeader: true };
  model: Model;
  streamOptions: StreamOptions;
  install(): Operation<void>;
}

export interface TestApplicationFactoryContext {
  model: TestModelInstallation;
  signal: AbortSignal;
}

export interface TestRigOptions {
  binding: "in-process" | "http";
  createApplication(
    context: TestApplicationFactoryContext,
  ): TestApplication | Promise<TestApplication>;
  barrierTimeoutMs?: number;
  scenarioTimeoutMs?: number;
  cancellationTimeoutMs?: number;
  modelId?: string;
  /**
   * Low-level `withTestRig` defaults to "poison" for pre-armed promise barriers.
   * `withTestScenario` always selects "buffer" for causal-order scripts.
   */
  unmatchedRequests?: "poison" | "buffer";
}

import type { ScenarioLifecycleControls, TestRig } from "./rig-types.ts";
export type { ScenarioLifecycleControls, TestRig } from "./rig-types.ts";

export interface TestRigBodyContext {
  signal: AbortSignal;
}

/** Explicit descriptor for the test rig's OpenAI Responses HTTP simulator. */
export function createSimulatorModel(modelId: string, baseUrl: string): Model {
  return {
    id: modelId,
    name: modelId,
    api: "openai-responses",
    provider: "openai",
    baseUrl,
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 16384,
  };
}

function createModelInstallation(baseUrl: string, modelId: string): TestModelInstallation {
  const apiKey = "sk-sweatpants-test-only";
  const providerOptions = { cacheRetention: "short" as const };
  const compat = {
    sendSessionAffinityHeaders: true as const,
    sendSessionIdHeader: true as const,
  };
  const model = {
    ...createSimulatorModel(modelId, baseUrl),
    compat,
  };
  const streamOptions: StreamOptions = {
    apiKey,
    providerOptions,
  };
  return {
    baseUrl,
    apiKey,
    modelId,
    providerOptions,
    compat,
    model,
    streamOptions,
    *install(): Operation<void> {
      yield* createPiAiModelProvider().install({
        model,
        streamOptions,
      });
    },
  };
}

async function createHttpBinding(
  application: TestApplication,
): Promise<{ fetch: ChatFetch; close(): Promise<void> }> {
  const { createServer } = await import("node:http");
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.from(chunk));
      }
      // Node accepts duplex for request bodies; the DOM RequestInit omits it.
      const init = {
        method: req.method,
        headers: req.headers as HeadersInit,
        body: chunks.length ? Buffer.concat(chunks) : undefined,
        duplex: chunks.length ? "half" : undefined,
      } satisfies RequestInit & { duplex?: "half" };
      const request = new Request(`http://127.0.0.1${req.url ?? "/"}`, init);
      const response = await application.handle(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) {
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          res.write(chunk);
        }
      }
      res.end();
    } catch (error) {
      if (res.headersSent) {
        // Once a streaming response has started, an error is a broken
        // connection—not another payload frame. Appending error text would
        // corrupt NDJSON/SSE and test the parser instead of transport recovery.
        res.destroy(error instanceof Error ? error : new Error(String(error)));
      } else {
        res.statusCode = 500;
        res.end(error instanceof Error ? error.message : String(error));
      }
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("HTTP binding did not expose a port");
  }
  return {
    fetch: (input, init) => {
      const raw =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const url = new URL(raw, "http://127.0.0.1");
      return globalThis.fetch(`http://127.0.0.1:${address.port}${url.pathname}${url.search}`, init);
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      }),
  };
}

export function withTestScenario<T>(
  options: TestRigOptions,
  script: (scenario: ScenarioContext) => Operation<T>,
): Promise<T> {
  return withTestRig({ ...options, unmatchedRequests: "buffer" }, (rig) => scenario(rig, script));
}

export async function withTestRig<T>(
  options: TestRigOptions,
  body: (rig: TestRig, context: TestRigBodyContext) => Promise<T>,
): Promise<T> {
  const abort = new AbortController();
  let state: TestRig["state"] = "active";
  let root: Error | undefined;
  let simulator: ModelSimulator | undefined;
  let application: TestApplication | undefined;
  let binding: { fetch: ChatFetch; close(): Promise<void> } | undefined;
  let chatRuntime: ChatRuntime | undefined;
  const barrierTimeoutMs = options.barrierTimeoutMs ?? 10_000;
  const cancellationTimeoutMs = options.cancellationTimeoutMs ?? 5_000;

  const poison = (error: Error) => {
    if (!root) {
      root = error;
      state = "poisoned";
      chatRuntime?.poison(error);
    }
    return root;
  };

  const agui = createAgUiProbe(poison);

  const bounded = async <Value>(
    label: string,
    promise: PromiseLike<Value>,
    timeoutMs: number,
  ): Promise<Value> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve(promise),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`${label} exceeded ${timeoutMs}ms`)),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  };

  try {
    simulator = await startModelSimulator(poison, {
      unmatchedRequests: options.unmatchedRequests ?? "poison",
    });
    const modelInstallation = createModelInstallation(
      simulator.baseUrl,
      options.modelId ?? "sweatpants-acceptance",
    );
    const createApplicationGeneration = async () => {
      application = await options.createApplication({
        signal: abort.signal,
        model: modelInstallation,
      });
      binding =
        options.binding === "in-process"
          ? {
              fetch: (input, init) => {
                const raw =
                  typeof input === "string"
                    ? input
                    : input instanceof URL
                      ? input.toString()
                      : input.url;
                return application!.handle(new Request(new URL(raw, "http://localhost"), init));
              },
              close: async () => {},
            }
          : await createHttpBinding(application);
    };

    const replaceApplicationGeneration = async () => {
      const retiringApplication = application;
      const retiringBinding = binding;
      if (!retiringApplication || !retiringBinding) {
        throw new Error("Test rig cannot replace an application before it is installed");
      }
      await retiringBinding.close();
      await retiringApplication.close();
      await createApplicationGeneration();
    };

    await createApplicationGeneration();

    const observedFetch: ChatFetch = async (input, init) => {
      const response = await binding!.fetch(input, init);
      const raw =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const pathname = new URL(raw, "http://localhost").pathname;
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      if (pathname.endsWith("/chat") && method.toUpperCase() === "POST") {
        return agui.observe(response);
      }
      if (pathname.endsWith("/chat") && method.toUpperCase() === "GET") {
        return agui.observeReplay(response);
      }
      return response;
    };

    chatRuntime = createChatRuntime({
      // Resolve the binding at request time so a causal scenario can replace a
      // Host while retaining its model simulator and durable substrate.
      fetch: observedFetch,
      barrierTimeoutMs,
      onPoison: poison,
      getRootFailure: () => root,
    });

    const boundedModelBarrier = (promise: Promise<PendingModelRequest>, label: string) =>
      bounded(label, promise, barrierTimeoutMs).catch((error) => {
        throw poison(error instanceof Error ? error : new Error(String(error)));
      });
    const modelHandle: ModelHandle = {
      expectRequest(expectation) {
        return boundedModelBarrier(
          simulator!.model.expectRequest(expectation),
          "barrier_timeout: model request barrier",
        );
      },
      nextRequest(expectation) {
        return boundedModelBarrier(
          simulator!.model.nextRequest(expectation),
          "barrier_timeout: next model request",
        );
      },
      requests: () => simulator!.model.requests(),
    };

    const [bodyScope, destroyBodyScope] = createScope();
    let closed = false;
    // Close owns strict observation plus bounded cleanup so teardown failures remain test-visible.
    // fallow-ignore-next-line complexity
    const close = async (strict: boolean) => {
      if (closed) {
        return;
      }
      closed = true;
      let verification: unknown;
      if (strict) {
        try {
          await bounded("AG-UI observation", agui.settle(), cancellationTimeoutMs);
          simulator!.verify();
          chatRuntime!.verify();
          const checkpointErrors = await application?.scenario?.checkpointErrors?.();
          if (checkpointErrors && checkpointErrors.length > 0) {
            throw new Error(
              `Checkpoint persistence failed during scenario: ${checkpointErrors
                .map((error) => (error instanceof Error ? error.message : String(error)))
                .join("; ")}`,
            );
          }
        } catch (error) {
          verification = error;
        }
      }
      state = "cancelling";
      abort.abort(root);
      const cleanupErrors: Error[] = [];
      for (const [label, cleanup] of [
        ["body scope cancellation", () => destroyBodyScope()],
        ["chat runtime cleanup", () => chatRuntime!.close()],
        ["chat binding cleanup", () => binding!.close()],
        ["application cleanup", () => application!.close()],
        ["model simulator cleanup", () => simulator!.close()],
      ] as const) {
        try {
          await bounded(label, Promise.resolve().then(cleanup), cancellationTimeoutMs);
        } catch (error) {
          const cause = error instanceof Error ? error : new Error(String(error));
          cleanupErrors.push(new Error(`${label}: ${cause.message}`, { cause }));
        }
      }
      agui.close(root);
      state = "closed";
      if (verification) {
        if (verification instanceof Error && cleanupErrors.length > 0) {
          Object.defineProperty(verification, "cleanupErrors", { value: cleanupErrors });
        }
        throw verification;
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          cleanupErrors,
          `Test rig cleanup failed: ${cleanupErrors.map((error) => error.message).join("; ")}`,
        );
      }
    };

    const missingScenarioCapability = (capability: string): never => {
      throw new Error(
        `Scenario ${capability} requires a TestApplication.scenario.${capability}() adapter`,
      );
    };
    const lifecycle: ScenarioLifecycleControls = {
      async gracefulShutdown(shutdownOptions) {
        const shutdown = application?.scenario?.gracefulShutdown;
        if (!shutdown) {
          return missingScenarioCapability("gracefulShutdown");
        }
        await shutdown(shutdownOptions);
      },
      replace: () => replaceApplicationGeneration(),
      async armFault(point) {
        const armFault = application?.scenario?.armFault;
        if (!armFault) {
          return missingScenarioCapability("armFault");
        }
        await armFault(point);
      },
      async waitForFault(point) {
        const waitForFault = application?.scenario?.waitForFault;
        if (!waitForFault) {
          return missingScenarioCapability("waitForFault");
        }
        await waitForFault(point);
      },
      async readHistory(sessionId, cursor) {
        const readHistory = application?.scenario?.readHistory;
        if (!readHistory) {
          return missingScenarioCapability("readHistory");
        }
        return await readHistory(sessionId, cursor);
      },
      async checkpointEvidence(executionId) {
        const checkpointEvidence = application?.scenario?.checkpointEvidence;
        if (!checkpointEvidence) {
          return missingScenarioCapability("checkpointEvidence");
        }
        return await checkpointEvidence(executionId);
      },
      async storageMetrics() {
        const storageMetrics = application?.scenario?.storageMetrics;
        if (!storageMetrics) {
          return missingScenarioCapability("storageMetrics");
        }
        return await storageMetrics();
      },
    };

    const rig: TestRig = {
      get model() {
        if (root) {
          throw root;
        }
        return modelHandle;
      },
      get agui() {
        if (root) {
          throw root;
        }
        return agui;
      },
      get chat() {
        if (root) {
          throw root;
        }
        return chatRuntime!.handle;
      },
      get streams() {
        if (root) {
          throw root;
        }
        return createStreamTransportHandle(observedFetch, barrierTimeoutMs);
      },
      get fetch() {
        if (root) {
          throw root;
        }
        return observedFetch;
      },
      get lifecycle() {
        if (root) {
          throw root;
        }
        return lifecycle;
      },
      get state() {
        return state;
      },
      verifyAndClose: () => close(true),
      [Symbol.asyncDispose]: () => close(false),
    };

    const timeout = options.scenarioTimeoutMs ?? 60_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = poison(new Error(`scenario_timeout after ${timeout}ms`));
        abort.abort(error);
        reject(error);
      }, timeout);
    });

    const bodyTask = bodyScope.run(function* () {
      return yield* call(() => body(rig, { signal: abort.signal }));
    });

    let result: T;
    try {
      result = await Promise.race([bodyTask, timeoutPromise]);
    } catch (error) {
      if (root) {
        chatRuntime.poison(root);
      }
      try {
        await bounded("body scope cancellation", destroyBodyScope(), cancellationTimeoutMs);
      } catch {
        // Preserve the primary body/timeout error.
      }
      try {
        await close(false);
      } catch {
        // Preserve the primary body/timeout error.
      }
      throw error;
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }

    await close(true);
    return result;
  } catch (error) {
    if (binding) {
      try {
        await binding.close();
      } catch {
        // Best-effort cleanup.
      }
    }
    if (application) {
      try {
        await application.close();
      } catch {
        // Best-effort cleanup.
      }
    }
    if (simulator) {
      try {
        await simulator.close();
      } catch {
        // Best-effort cleanup.
      }
    }
    state = "closed";
    throw error;
  }
}
