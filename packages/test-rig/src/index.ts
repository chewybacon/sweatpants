export * from "./model.ts";
export * from "./history.ts";
export * from "./chat.ts";
export * from "./transport.ts";
export * from "./scenario.ts";

import {
  createOpenAiResponsesModel,
  createPiAiModelProviderDriver,
  installPiAiModelProvider,
  type Model,
  type StreamOptions,
} from "@sweatpants/model-provider-pi-ai";
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

export interface TestApplication {
  handle(request: Request): Promise<Response>;
  close(): Promise<void>;
  trace?(conversationId: string): Promise<unknown>;
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

import type { TestRig } from "./rig-types.ts";
export type { TestRig } from "./rig-types.ts";

export interface TestRigBodyContext {
  signal: AbortSignal;
}

function createModelInstallation(baseUrl: string, modelId: string): TestModelInstallation {
  const apiKey = "sk-sweatpants-test-only";
  const providerOptions = { cacheRetention: "short" as const };
  const compat = {
    sendSessionAffinityHeaders: true as const,
    sendSessionIdHeader: true as const,
  };
  const model = {
    ...createOpenAiResponsesModel(modelId, baseUrl),
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
      yield* installPiAiModelProvider({
        driver: createPiAiModelProviderDriver(),
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
      const request = new Request(`http://127.0.0.1${req.url ?? "/"}`, {
        ...(req.method ? { method: req.method } : {}),
        headers: req.headers as HeadersInit,
        ...(chunks.length ? { body: Buffer.concat(chunks), duplex: "half" as never } : {}),
      });
      const response = await application.handle(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) {
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          res.write(chunk);
        }
      }
      res.end();
    } catch (error) {
      res.statusCode = 500;
      res.end(error instanceof Error ? error.message : String(error));
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

    chatRuntime = createChatRuntime({
      fetch: binding.fetch,
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
    const close = async (strict: boolean) => {
      if (closed) {
        return;
      }
      closed = true;
      let verification: unknown;
      if (strict) {
        try {
          simulator!.verify();
          chatRuntime!.verify();
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

    const rig: TestRig = {
      get model() {
        if (root) {
          throw root;
        }
        return modelHandle;
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
        return createStreamTransportHandle(binding!.fetch, barrierTimeoutMs);
      },
      get fetch() {
        if (root) {
          throw root;
        }
        return binding!.fetch;
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
