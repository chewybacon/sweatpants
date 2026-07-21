import { createFoundationSimulationServer } from "@simulacrum/foundation-simulator";

export type SimulatedModelResponse =
  | {
      type: "tool_call";
      name: string;
      arguments: Record<string, unknown>;
      callId?: string;
    }
  | {
      type: "text";
      text: string;
    };

export interface OpenAiResponsesRequest {
  model?: unknown;
  input?: unknown;
  tools?: unknown;
  tool_choice?: unknown;
  stream?: unknown;
  [key: string]: unknown;
}

export interface PendingModelRequest {
  request: OpenAiResponsesRequest;
  /** Stable Program Runtime pull identity forwarded by pi-ai. */
  pullId?: string;
  respond(response: SimulatedModelResponse): Promise<void>;
}

export interface OpenAiResponsesSimulator {
  baseUrl: string;
  requests: OpenAiResponsesRequest[];
  /** Wait until the real OpenAI adapter reaches its next provider boundary. */
  nextRequest(): Promise<PendingModelRequest>;
  assertIdle(): void;
  close(): Promise<void>;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function sse(res: { write(chunk: string): unknown }, event: Record<string, unknown>): void {
  res.write(`event: ${String(event["type"])}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function responseEnvelope(
  id: string,
  model: string,
  status: "in_progress" | "completed",
  output: unknown[],
): Record<string, unknown> {
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

function writeToolCall(
  res: { write(chunk: string): unknown },
  responseId: string,
  model: string,
  scripted: Extract<SimulatedModelResponse, { type: "tool_call" }>,
): void {
  const callId = scripted.callId ?? `call_${crypto.randomUUID()}`;
  const itemId = `fc_${crypto.randomUUID()}`;
  const argumentsJson = JSON.stringify(scripted.arguments);
  const pendingItem = {
    id: itemId,
    type: "function_call",
    call_id: callId,
    name: scripted.name,
    arguments: "",
    status: "in_progress",
  };
  const completedItem = {
    ...pendingItem,
    arguments: argumentsJson,
    status: "completed",
  };

  sse(res, {
    type: "response.output_item.added",
    sequence_number: 1,
    output_index: 0,
    item: pendingItem,
  });
  sse(res, {
    type: "response.function_call_arguments.delta",
    sequence_number: 2,
    item_id: itemId,
    output_index: 0,
    delta: argumentsJson,
  });
  sse(res, {
    type: "response.function_call_arguments.done",
    sequence_number: 3,
    item_id: itemId,
    output_index: 0,
    arguments: argumentsJson,
  });
  sse(res, {
    type: "response.output_item.done",
    sequence_number: 4,
    output_index: 0,
    item: completedItem,
  });
  sse(res, {
    type: "response.completed",
    sequence_number: 5,
    response: responseEnvelope(responseId, model, "completed", [completedItem]),
  });
}

function writeText(
  res: { write(chunk: string): unknown },
  responseId: string,
  model: string,
  text: string,
): void {
  const itemId = `msg_${crypto.randomUUID()}`;
  const pendingItem = {
    id: itemId,
    type: "message",
    role: "assistant",
    status: "in_progress",
    content: [],
  };
  const completedItem = {
    ...pendingItem,
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };

  sse(res, {
    type: "response.output_item.added",
    sequence_number: 1,
    output_index: 0,
    item: pendingItem,
  });
  sse(res, {
    type: "response.content_part.added",
    sequence_number: 2,
    item_id: itemId,
    output_index: 0,
    content_index: 0,
    part: { type: "output_text", text: "", annotations: [] },
  });
  sse(res, {
    type: "response.output_text.delta",
    sequence_number: 3,
    item_id: itemId,
    output_index: 0,
    content_index: 0,
    delta: text,
  });
  sse(res, {
    type: "response.output_text.done",
    sequence_number: 4,
    item_id: itemId,
    output_index: 0,
    content_index: 0,
    text,
  });
  sse(res, {
    type: "response.output_item.done",
    sequence_number: 5,
    output_index: 0,
    item: completedItem,
  });
  sse(res, {
    type: "response.completed",
    sequence_number: 6,
    response: responseEnvelope(responseId, model, "completed", [completedItem]),
  });
}

/**
 * Interactive tracer simulator. Each real provider request remains suspended
 * until the test obtains it through nextRequest() and supplies a response.
 */
export async function startOpenAiResponsesSimulator(): Promise<OpenAiResponsesSimulator> {
  const requests: OpenAiResponsesRequest[] = [];
  const pending: PendingModelRequest[] = [];
  const waiters: Deferred<PendingModelRequest>[] = [];
  let unanswered = 0;
  let closed = false;

  function publish(request: PendingModelRequest): void {
    const waiter = waiters.shift();
    if (waiter) {
      waiter.resolve(request);
    } else {
      pending.push(request);
    }
  }

  const createSimulation = createFoundationSimulationServer({
    port: 0,
    simulationContextPage: "/_simulacrum",
    extendRouter(router) {
      router.post("/v1/responses", (req, res) => {
        const request = req.body as OpenAiResponsesRequest;
        requests.push(request);
        unanswered += 1;
        let responded = false;

        const header = req.headers["x-client-request-id"];
        const pullId = Array.isArray(header) ? header[0] : header;
        publish({
          request,
          ...(pullId ? { pullId } : {}),
          async respond(scripted) {
            if (responded) {
              throw new Error("Pending model request was already answered");
            }
            if (closed) {
              throw new Error("OpenAI simulator is closed");
            }
            responded = true;
            unanswered -= 1;

            const model = typeof request.model === "string" ? request.model : "sweatpants-spike";
            const responseId = `resp_${crypto.randomUUID()}`;
            res.status(200);
            res.setHeader("content-type", "text/event-stream; charset=utf-8");
            res.setHeader("cache-control", "no-cache");
            res.setHeader("connection", "keep-alive");
            res.flushHeaders();

            sse(res, {
              type: "response.created",
              sequence_number: 0,
              response: responseEnvelope(responseId, model, "in_progress", []),
            });
            if (scripted.type === "tool_call") {
              writeToolCall(res, responseId, model, scripted);
            } else {
              writeText(res, responseId, model, scripted.text);
            }
            res.write("data: [DONE]\n\n");
            res.end();
          },
        });
      });
    },
  });

  const listening = await createSimulation().listen(0);
  if (listening.port === undefined) {
    await listening.ensureClose();
    throw new Error("OpenAI simulator did not expose a listening port");
  }

  return {
    baseUrl: `http://127.0.0.1:${listening.port}/v1`,
    requests,
    nextRequest() {
      if (closed) {
        return Promise.reject(new Error("OpenAI simulator is closed"));
      }
      const request = pending.shift();
      if (request) {
        return Promise.resolve(request);
      }
      const waiter = deferred<PendingModelRequest>();
      waiters.push(waiter);
      return waiter.promise;
    },
    assertIdle() {
      if (unanswered > 0) {
        throw new Error(`OpenAI simulator has ${unanswered} unanswered request(s)`);
      }
      if (pending.length > 0) {
        throw new Error(`OpenAI simulator has ${pending.length} unclaimed request(s)`);
      }
    },
    async close() {
      closed = true;
      const error = new Error("OpenAI simulator closed while waiting for a request");
      for (const waiter of waiters.splice(0)) {
        waiter.reject(error);
      }
      await listening.ensureClose();
    },
  };
}
