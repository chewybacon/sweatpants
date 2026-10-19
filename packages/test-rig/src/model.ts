import { createFoundationSimulationServer } from "@simulacrum/foundation-simulator";
import type { Json } from "@sweatpants/foundation";

export interface OpenAiResponsesRequest {
  model?: unknown;
  input?: unknown;
  tools?: unknown;
  tool_choice?: unknown;
  stream?: unknown;
  [key: string]: unknown;
}
export interface CapturedModelRequest {
  readonly body: OpenAiResponsesRequest;
  readonly headers: Readonly<Record<string, string>>;
  readonly pullId: string;
}
export type RequestExpectation =
  | Partial<OpenAiResponsesRequest>
  | ((request: CapturedModelRequest) => void);
export interface SimulatedToolCall {
  id: string;
  name: string;
  arguments: Json;
}
export interface SimulatedProviderError {
  code: string;
  message: string;
  status?: number;
}
export interface TextStreamController {
  releaseNext(): Promise<void>;
  finish(): Promise<void>;
  fail(error: SimulatedProviderError): Promise<void>;
  disconnect(): Promise<void>;
}
export interface PendingModelRequest extends CapturedModelRequest {
  readonly respond: {
    text(text: string): Promise<void>;
    text(options: { chunks: readonly string[]; release: "manual" }): Promise<TextStreamController>;
    toolCalls(
      calls: readonly SimulatedToolCall[],
      options?: { argumentChunkSize?: number },
    ): Promise<void>;
    textAndToolCalls(text: string, calls: readonly SimulatedToolCall[]): Promise<void>;
    malformedToolCall(call: { id: string; name: string; arguments: string }): Promise<void>;
    error(error: SimulatedProviderError): Promise<void>;
    awaitAbort(): Promise<void>;
  };
}
export interface ModelHandle {
  expectRequest(expectation: RequestExpectation): Promise<PendingModelRequest>;
  /**
   * Consume the oldest buffered provider request, or wait for the next one.
   * Requires the simulator to run with `unmatchedRequests: "buffer"`.
   * An optional expectation validates (never skips) the consumed request.
   */
  nextRequest(expectation?: RequestExpectation): Promise<PendingModelRequest>;
  requests(): readonly CapturedModelRequest[];
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}
const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
function partial(actual: unknown, expected: unknown): boolean {
  if (isObject(expected)) {
    return isObject(actual) && Object.entries(expected).every(([k, v]) => partial(actual[k], v));
  }
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      expected.length === actual.length &&
      expected.every((v, i) => partial(actual[i], v))
    );
  }
  return Object.is(actual, expected);
}
function bounded(v: unknown): string {
  return JSON.stringify(v, (key, value) =>
    /authorization|api.?key|cookie|token|account/i.test(key) ? "[redacted]" : value,
  ).slice(0, 2000);
}
function sse(res: { write(chunk: string): unknown }, event: Record<string, unknown>) {
  res.write(`event: ${String(event["type"])}\ndata: ${JSON.stringify(event)}\n\n`);
}
function envelope(
  id: string,
  model: string,
  status: "in_progress" | "completed" | "failed",
  output: unknown[],
  failure?: SimulatedProviderError,
) {
  return {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status,
    model,
    output,
    error: failure
      ? { code: failure.code, type: "simulator_error", message: failure.message.slice(0, 2000) }
      : null,
    incomplete_details: null,
    instructions: null,
    metadata: {},
    parallel_tool_calls: true,
    previous_response_id: null,
    store: false,
    temperature: 1,
    tool_choice: "auto",
    tools: [],
    top_p: 1,
    truncation: "disabled",
    usage:
      status === "completed"
        ? {
            input_tokens: 1,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: 1,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: 2,
          }
        : null,
  };
}
function errorEnvelope(code: string, message: string) {
  return { error: { code, type: "simulator_error", message: message.slice(0, 2000) } };
}
function assertExpectation(expectation: RequestExpectation, request: CapturedModelRequest): void {
  if (typeof expectation === "function") {
    expectation(request);
  } else if (!partial(request.body, expectation)) {
    throw new Error(
      `Model request mismatch; expected ${bounded(expectation)}, actual ${bounded(request.body)}`,
    );
  }
}

export interface ModelSimulator {
  readonly baseUrl: string;
  readonly model: ModelHandle;
  verify(): void;
  close(): Promise<void>;
}

export interface ModelSimulatorOptions {
  /**
   * "poison" (default): a request with no armed expectation fails the rig.
   * "buffer": unmatched requests queue up until `nextRequest()` consumes them,
   * enabling causal-order ("ask late") scenario scripts.
   */
  unmatchedRequests?: "poison" | "buffer";
}

export async function startModelSimulator(
  onPoison?: (error: Error) => void,
  simulatorOptions?: ModelSimulatorOptions,
): Promise<ModelSimulator> {
  const bufferUnmatched = simulatorOptions?.unmatchedRequests === "buffer";
  const captured: CapturedModelRequest[] = [];
  const expectations: Array<{
    expectation: RequestExpectation;
    wait: Deferred<PendingModelRequest>;
  }> = [];
  const arrivals: PendingModelRequest[] = [];
  const arrivalWaiters: Array<{
    expectation?: RequestExpectation;
    wait: Deferred<PendingModelRequest>;
  }> = [];
  const pending = new Set<PendingModelRequest>();
  let closed = false;
  let root: Error | undefined;
  const poison = (error: Error) => {
    if (root) {
      return root;
    }
    root = error;
    onPoison?.(error);
    for (const x of expectations.splice(0)) {
      x.wait.reject(error);
    }
    for (const x of arrivalWaiters.splice(0)) {
      x.wait.reject(error);
    }
    return error;
  };
  const assertActive = () => {
    if (root) {
      throw root;
    }
    if (closed) {
      throw new Error("Test rig model simulator is closed");
    }
  };
  const createSimulation = createFoundationSimulationServer({
    port: 0,
    simulationContextPage: "/_simulacrum",
    extendRouter(router) {
      router.post("/v1/responses", (req, res) => {
        if (closed) {
          res.status(409).json(errorEnvelope("rig_closed", "Simulator is closed"));
          return;
        }
        const body = req.body as OpenAiResponsesRequest;
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) {
          if (!/authorization|cookie|api.?key/i.test(k) && typeof v === "string") {
            headers[k] = v;
          }
        }
        const pullId = headers["x-client-request-id"] ?? "";
        const request: CapturedModelRequest = Object.freeze({
          body: structuredClone(body),
          headers: Object.freeze(headers),
          pullId,
        });
        captured.push(request);
        let registered = expectations.shift();
        if (!registered && bufferUnmatched) {
          // Route the fully-constructed handle into the arrival buffer (or hand
          // it to the oldest waiting nextRequest caller) instead of poisoning.
          const wait = deferred<PendingModelRequest>();
          void wait.promise.then(
            (handle) => {
              const waiter = arrivalWaiters.shift();
              if (!waiter) {
                arrivals.push(handle);
                return undefined;
              }
              try {
                if (waiter.expectation) {
                  assertExpectation(waiter.expectation, handle);
                }
                waiter.wait.resolve(handle);
              } catch (cause) {
                waiter.wait.reject(
                  poison(cause instanceof Error ? cause : new Error(String(cause))),
                );
              }
              return undefined;
            },
            () => undefined,
          );
          registered = { expectation: () => {}, wait };
        }
        if (!registered) {
          const e = poison(new Error(`Unexpected model request: ${bounded(body)}`));
          res.status(409).json(errorEnvelope("simulator_unexpected_request", e.message));
          return;
        }
        try {
          assertExpectation(registered.expectation, request);
        } catch (cause) {
          const e = poison(cause instanceof Error ? cause : new Error(String(cause)));
          registered.wait.reject(e);
          res.status(409).json(errorEnvelope("model_request_mismatch", e.message));
          return;
        }
        let answered = false;
        const responseId = `resp_${crypto.randomUUID()}`;
        const model = typeof body.model === "string" ? body.model : "sweatpants-test";
        let sequence = 0;
        const begin = () => {
          assertActive();
          if (answered) {
            throw poison(new Error("duplicate_barrier_resolution: model request already answered"));
          }
          answered = true;
          res.status(200);
          res.setHeader("content-type", "text/event-stream; charset=utf-8");
          res.setHeader("cache-control", "no-cache");
          res.flushHeaders();
          sse(res, {
            type: "response.created",
            sequence_number: sequence++,
            response: envelope(responseId, model, "in_progress", []),
          });
        };
        const finish = (output: unknown[]) => {
          sse(res, {
            type: "response.completed",
            sequence_number: sequence++,
            response: envelope(responseId, model, "completed", output),
          });
          res.write("data: [DONE]\n\n");
          res.end();
          pending.delete(handle);
        };
        const failResponse = (error: SimulatedProviderError) => {
          sse(res, {
            type: "response.failed",
            sequence_number: sequence++,
            response: envelope(responseId, model, "failed", [], error),
          });
          res.end();
          pending.delete(handle);
        };
        const disconnectResponse = () => {
          pending.delete(handle);
          res.destroy();
        };
        const textSetup = (chunks: readonly string[]) => {
          const id = `msg_${crypto.randomUUID()}`;
          const base = {
            id,
            type: "message",
            role: "assistant",
            status: "in_progress",
            content: [],
          };
          sse(res, {
            type: "response.output_item.added",
            sequence_number: sequence++,
            output_index: 0,
            item: base,
          });
          sse(res, {
            type: "response.content_part.added",
            sequence_number: sequence++,
            item_id: id,
            output_index: 0,
            content_index: 0,
            part: { type: "output_text", text: "", annotations: [] },
          });
          let index = 0;
          let text = "";
          let terminal: "finished" | "failed" | "disconnected" | undefined;
          const assertStreamOpen = (action: string) => {
            if (terminal) {
              throw poison(
                new Error(
                  `duplicate_barrier_resolution: cannot ${action}; stream already ${terminal}`,
                ),
              );
            }
          };
          const emitUnchecked = () => {
            if (index >= chunks.length) {
              throw poison(new Error("duplicate_barrier_resolution: no text chunk remains"));
            }
            const delta = chunks[index++]!;
            text += delta;
            sse(res, {
              type: "response.output_text.delta",
              sequence_number: sequence++,
              item_id: id,
              output_index: 0,
              content_index: 0,
              delta,
            });
          };
          const emit = () => {
            assertStreamOpen("release a chunk");
            emitUnchecked();
          };
          const end = () => {
            assertStreamOpen("finish");
            while (index < chunks.length) {
              emitUnchecked();
            }
            terminal = "finished";
            sse(res, {
              type: "response.output_text.done",
              sequence_number: sequence++,
              item_id: id,
              output_index: 0,
              content_index: 0,
              text,
            });
            const item = {
              ...base,
              status: "completed",
              content: [{ type: "output_text", text, annotations: [] }],
            };
            sse(res, {
              type: "response.output_item.done",
              sequence_number: sequence++,
              output_index: 0,
              item,
            });
            finish([item]);
          };
          const fail = (error: SimulatedProviderError) => {
            assertStreamOpen("fail");
            terminal = "failed";
            failResponse(error);
          };
          const disconnect = () => {
            assertStreamOpen("disconnect");
            terminal = "disconnected";
            disconnectResponse();
          };
          return { emit, end, fail, disconnect };
        };
        const emitToolCalls = (
          calls: readonly {
            id: string;
            name: string;
            argumentsJson: string;
          }[],
          argumentChunkSize?: number,
          leadingText?: string,
        ) => {
          const output: unknown[] = [];
          let outputOffset = 0;
          if (leadingText !== undefined) {
            const id = `msg_${crypto.randomUUID()}`;
            const item = {
              id,
              type: "message",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: leadingText, annotations: [] }],
            };
            sse(res, {
              type: "response.output_item.added",
              sequence_number: sequence++,
              output_index: 0,
              item: { ...item, status: "in_progress", content: [] },
            });
            sse(res, {
              type: "response.content_part.added",
              sequence_number: sequence++,
              item_id: id,
              output_index: 0,
              content_index: 0,
              part: { type: "output_text", text: "", annotations: [] },
            });
            sse(res, {
              type: "response.output_text.delta",
              sequence_number: sequence++,
              item_id: id,
              output_index: 0,
              content_index: 0,
              delta: leadingText,
            });
            sse(res, {
              type: "response.output_text.done",
              sequence_number: sequence++,
              item_id: id,
              output_index: 0,
              content_index: 0,
              text: leadingText,
            });
            sse(res, {
              type: "response.output_item.done",
              sequence_number: sequence++,
              output_index: 0,
              item,
            });
            output.push(item);
            outputOffset = 1;
          }
          for (const [i, call] of calls.entries()) {
            const outputIndex = i + outputOffset;
            const id = `fc_${crypto.randomUUID()}`;
            const base = {
              id,
              type: "function_call",
              call_id: call.id,
              name: call.name,
              arguments: "",
              status: "in_progress",
            };
            sse(res, {
              type: "response.output_item.added",
              sequence_number: sequence++,
              output_index: outputIndex,
              item: base,
            });
            const chunks = argumentChunkSize
              ? Array.from(
                  { length: Math.ceil(call.argumentsJson.length / argumentChunkSize) },
                  (_, index) =>
                    call.argumentsJson.slice(
                      index * argumentChunkSize,
                      (index + 1) * argumentChunkSize,
                    ),
                )
              : [call.argumentsJson];
            for (const delta of chunks) {
              sse(res, {
                type: "response.function_call_arguments.delta",
                sequence_number: sequence++,
                item_id: id,
                output_index: outputIndex,
                delta,
              });
            }
            sse(res, {
              type: "response.function_call_arguments.done",
              sequence_number: sequence++,
              item_id: id,
              output_index: outputIndex,
              arguments: call.argumentsJson,
            });
            const item = {
              ...base,
              arguments: call.argumentsJson,
              status: "completed",
            };
            output.push(item);
            sse(res, {
              type: "response.output_item.done",
              sequence_number: sequence++,
              output_index: outputIndex,
              item,
            });
          }
          finish(output);
        };
        const handle: PendingModelRequest = {
          ...request,
          respond: {
            text: (async (value: string | { chunks: readonly string[]; release: "manual" }) => {
              begin();
              const stream = textSetup(typeof value === "string" ? [value] : value.chunks);
              if (typeof value === "string") {
                stream.end();
                return;
              }
              return {
                async releaseNext() {
                  assertActive();
                  stream.emit();
                },
                async finish() {
                  assertActive();
                  stream.end();
                },
                async fail(error) {
                  assertActive();
                  stream.fail(error);
                },
                async disconnect() {
                  assertActive();
                  stream.disconnect();
                },
              };
            }) as PendingModelRequest["respond"]["text"],
            async toolCalls(calls, options) {
              begin();
              emitToolCalls(
                calls.map((call) => ({ ...call, argumentsJson: JSON.stringify(call.arguments) })),
                options?.argumentChunkSize,
              );
            },
            async textAndToolCalls(text, calls) {
              begin();
              emitToolCalls(
                calls.map((call) => ({ ...call, argumentsJson: JSON.stringify(call.arguments) })),
                undefined,
                text,
              );
            },
            async malformedToolCall(call) {
              begin();
              emitToolCalls([{ ...call, argumentsJson: call.arguments }]);
            },
            async error(error) {
              assertActive();
              if (answered) {
                throw poison(
                  new Error("duplicate_barrier_resolution: model request already answered"),
                );
              }
              answered = true;
              res.status(error.status ?? 500).json(errorEnvelope(error.code, error.message));
              pending.delete(handle);
            },
            async awaitAbort() {
              assertActive();
              if (answered) {
                throw poison(
                  new Error("duplicate_barrier_resolution: model request already answered"),
                );
              }
              answered = true;
              await new Promise<void>((resolve) => {
                const complete = () => {
                  pending.delete(handle);
                  resolve();
                };
                res.once("close", complete);
              });
            },
          },
        };
        pending.add(handle);
        registered.wait.resolve(handle);
        req.on("aborted", () => {
          if (!answered) {
            poison(new Error(`Provider request ${pullId || "<unknown>"} aborted before response`));
          }
        });
      });
    },
  });
  // Bind the same address we advertise. A wildcard IPv6 socket can overlap
  // an IPv4 listener on macOS and route our requests to another local service.
  const listening = await createSimulation().listen({ port: 0, host: "127.0.0.1" });
  if (listening.port === undefined) {
    await listening.ensureClose();
    throw new Error("Simulator did not expose a port");
  }
  const model: ModelHandle = {
    expectRequest(expectation) {
      try {
        assertActive();
        const wait = deferred<PendingModelRequest>();
        expectations.push({ expectation, wait });
        return wait.promise;
      } catch (e) {
        return Promise.reject(e);
      }
    },
    nextRequest(expectation) {
      try {
        assertActive();
        if (!bufferUnmatched) {
          throw new Error('nextRequest requires the simulator option unmatchedRequests: "buffer"');
        }
        const buffered = arrivals.shift();
        if (buffered) {
          if (expectation) {
            try {
              assertExpectation(expectation, buffered);
            } catch (cause) {
              throw poison(cause instanceof Error ? cause : new Error(String(cause)));
            }
          }
          return Promise.resolve(buffered);
        }
        const wait = deferred<PendingModelRequest>();
        arrivalWaiters.push({ expectation: expectation, wait });
        return wait.promise;
      } catch (e) {
        return Promise.reject(e);
      }
    },
    requests() {
      return Object.freeze(captured.map((x) => Object.freeze(structuredClone(x))));
    },
  };
  return {
    baseUrl: `http://127.0.0.1:${listening.port}/v1`,
    model,
    verify() {
      assertActive();
      if (expectations.length) {
        throw poison(new Error(`${expectations.length} unclaimed model expectation(s)`));
      }
      if (arrivalWaiters.length) {
        throw poison(new Error(`${arrivalWaiters.length} unclaimed nextRequest waiter(s)`));
      }
      if (arrivals.length) {
        throw poison(new Error(`${arrivals.length} unconsumed buffered model request(s)`));
      }
      if (pending.size) {
        throw poison(new Error(`${pending.size} unanswered model request(s)`));
      }
    },
    async close() {
      closed = true;
      for (const x of expectations.splice(0)) {
        x.wait.reject(root ?? new Error("Simulator closed"));
      }
      for (const x of arrivalWaiters.splice(0)) {
        x.wait.reject(root ?? new Error("Simulator closed"));
      }
      await listening.ensureClose();
    },
  };
}
