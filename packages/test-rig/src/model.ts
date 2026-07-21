import { createFoundationSimulationServer } from "@simulacrum/foundation-simulator";

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
  arguments: Record<string, unknown>;
}
export interface TextStreamController {
  releaseNext(): Promise<void>;
  finish(): Promise<void>;
}
export interface PendingModelRequest extends CapturedModelRequest {
  readonly respond: {
    text(text: string): Promise<void>;
    text(options: { chunks: readonly string[]; release: "manual" }): Promise<TextStreamController>;
    toolCalls(calls: readonly SimulatedToolCall[]): Promise<void>;
  };
}
export interface ModelHandle {
  expectRequest(expectation: RequestExpectation): Promise<PendingModelRequest>;
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
  status: "in_progress" | "completed",
  output: unknown[],
) {
  return {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status,
    model,
    output,
    error: null,
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

export interface ModelSimulator {
  readonly baseUrl: string;
  readonly model: ModelHandle;
  verify(): void;
  close(): Promise<void>;
}

export async function startModelSimulator(
  onPoison?: (error: Error) => void,
): Promise<ModelSimulator> {
  const captured: CapturedModelRequest[] = [];
  const expectations: Array<{
    expectation: RequestExpectation;
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
        const registered = expectations.shift();
        if (!registered) {
          const e = poison(new Error(`Unexpected model request: ${bounded(body)}`));
          res.status(409).json(errorEnvelope("simulator_unexpected_request", e.message));
          return;
        }
        try {
          if (typeof registered.expectation === "function") {
            registered.expectation(request);
          } else if (!partial(body, registered.expectation)) {
            throw new Error(
              `Model request mismatch; expected ${bounded(registered.expectation)}, actual ${bounded(body)}`,
            );
          }
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
          let index = 0,
            text = "",
            done = false;
          const emit = () => {
            if (index >= chunks.length) {
              throw new Error("duplicate_barrier_resolution: no text chunk remains");
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
          const end = () => {
            if (done) {
              throw poison(new Error("duplicate_barrier_resolution: stream already finished"));
            }
            done = true;
            while (index < chunks.length) {
              emit();
            }
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
          return { emit, end };
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
              };
            }) as PendingModelRequest["respond"]["text"],
            async toolCalls(calls) {
              begin();
              const output: unknown[] = [];
              for (const [i, call] of calls.entries()) {
                const id = `fc_${crypto.randomUUID()}`,
                  json = JSON.stringify(call.arguments),
                  base = {
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
                  output_index: i,
                  item: base,
                });
                sse(res, {
                  type: "response.function_call_arguments.delta",
                  sequence_number: sequence++,
                  item_id: id,
                  output_index: i,
                  delta: json,
                });
                sse(res, {
                  type: "response.function_call_arguments.done",
                  sequence_number: sequence++,
                  item_id: id,
                  output_index: i,
                  arguments: json,
                });
                const item = { ...base, arguments: json, status: "completed" };
                output.push(item);
                sse(res, {
                  type: "response.output_item.done",
                  sequence_number: sequence++,
                  output_index: i,
                  item,
                });
              }
              finish(output);
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
  const listening = await createSimulation().listen(0);
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
      if (pending.size) {
        throw poison(new Error(`${pending.size} unanswered model request(s)`));
      }
    },
    async close() {
      closed = true;
      for (const x of expectations.splice(0)) {
        x.wait.reject(root ?? new Error("Simulator closed"));
      }
      await listening.ensureClose();
    },
  };
}
