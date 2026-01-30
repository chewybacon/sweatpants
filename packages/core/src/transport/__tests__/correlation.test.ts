import { describe, it, expect } from "@effectionx/vitest";
import { spawn, sleep, type Operation, type Stream, type Subscription } from "effection";
import { createTransportPair } from "../pair.ts";
import { createCorrelation, type CorrelatedTransport } from "../correlation.ts";
import type {
  TransportRequest,
  ProgressMessage,
  ResponseMessage,
  ElicitResponse,
} from "../../types/transport.ts";

/**
 * Helper to consume a stream and collect progress values.
 */
function* consumeStream<T, R>(
  stream: Stream<T, R>,
  onProgress?: (value: T) => void
): Operation<R> {
  const subscription: Subscription<T, R> = yield* stream;
  let next = yield* subscription.next();

  while (!next.done) {
    if (onProgress) {
      onProgress(next.value);
    }
    next = yield* subscription.next();
  }

  return next.value;
}

describe("createCorrelation", () => {
  it("should create a correlated transport", function* () {
    const [principal] = yield* createTransportPair();
    const correlated: CorrelatedTransport = yield* createCorrelation(principal);

    expect(correlated).toBeDefined();
    expect(correlated.request).toBeDefined();
  });

  it("should send request and receive response", function* () {
    const [principal, operative] = yield* createTransportPair();
    const correlated: CorrelatedTransport = yield* createCorrelation(principal);

    const request: TransportRequest = {
      id: "req-1",
      kind: "elicit",
      type: "location",
      payload: { accuracy: "high" },
    };

    // Start the request
    let finalResponse: ElicitResponse | undefined;
    yield* spawn(function* () {
      finalResponse = yield* consumeStream(
        correlated.request<unknown, ElicitResponse>(request)
      );
    });

    yield* sleep(0);

    // Operative receives the request
    const operativeSub = yield* operative;
    const received = yield* operativeSub.next();

    expect(received.done).toBe(false);
    if (!received.done) {
      expect(received.value).toEqual(request);
    }

    // Operative sends response
    const response: ResponseMessage = {
      type: "response",
      id: "req-1",
      response: { status: "accepted", content: { lat: 40.7128, lng: -74.006 } },
    };
    yield* operative.send(response);
    yield* sleep(0);

    expect(finalResponse).toEqual({
      status: "accepted",
      content: { lat: 40.7128, lng: -74.006 },
    });
  });

  it("should receive progress events before response", function* () {
    const [principal, operative] = yield* createTransportPair();
    const correlated: CorrelatedTransport = yield* createCorrelation(principal);

    const request: TransportRequest = {
      id: "req-1",
      kind: "elicit",
      type: "location",
      payload: { accuracy: "high" },
    };

    const progressReceived: unknown[] = [];
    let finalResponse: ElicitResponse | undefined;

    yield* spawn(function* () {
      finalResponse = yield* consumeStream(
        correlated.request<unknown, ElicitResponse>(request),
        (progress) => {
          progressReceived.push(progress);
        }
      );
    });

    yield* sleep(0);

    // Read the request from operative
    const operativeSub = yield* operative;
    yield* operativeSub.next();

    // Operative sends progress
    const progress1: ProgressMessage = {
      type: "progress",
      id: "req-1",
      data: { status: "requesting-permission" },
    };
    yield* operative.send(progress1);
    yield* sleep(0);

    expect(progressReceived).toHaveLength(1);
    expect(progressReceived[0]).toEqual({ status: "requesting-permission" });

    // Operative sends more progress
    const progress2: ProgressMessage = {
      type: "progress",
      id: "req-1",
      data: { status: "acquiring" },
    };
    yield* operative.send(progress2);
    yield* sleep(0);

    expect(progressReceived).toHaveLength(2);
    expect(progressReceived[1]).toEqual({ status: "acquiring" });

    // Operative sends final response
    const response: ResponseMessage = {
      type: "response",
      id: "req-1",
      response: { status: "accepted", content: { lat: 40.7128, lng: -74.006 } },
    };
    yield* operative.send(response);
    yield* sleep(0);

    expect(finalResponse).toEqual({
      status: "accepted",
      content: { lat: 40.7128, lng: -74.006 },
    });
  });

  it("should handle multiple concurrent requests", function* () {
    const [principal, operative] = yield* createTransportPair();
    const correlated: CorrelatedTransport = yield* createCorrelation(principal);

    const responses: Record<string, ElicitResponse> = {};

    // Start two concurrent requests
    yield* spawn(function* () {
      responses["req-1"] = yield* consumeStream(
        correlated.request<unknown, ElicitResponse>({
          id: "req-1",
          kind: "elicit",
          type: "location",
          payload: {},
        })
      );
    });

    yield* spawn(function* () {
      responses["req-2"] = yield* consumeStream(
        correlated.request<unknown, ElicitResponse>({
          id: "req-2",
          kind: "elicit",
          type: "clipboard",
          payload: {},
        })
      );
    });

    yield* sleep(0);

    // Read both requests from operative
    const operativeSub = yield* operative;
    yield* operativeSub.next();
    yield* operativeSub.next();

    // Respond out of order
    yield* operative.send({
      type: "response",
      id: "req-2",
      response: { status: "accepted", content: { text: "clipboard" } },
    });

    yield* operative.send({
      type: "response",
      id: "req-1",
      response: { status: "denied" },
    });

    yield* sleep(0);

    expect(responses["req-1"]).toEqual({ status: "denied" });
    expect(responses["req-2"]).toEqual({
      status: "accepted",
      content: { text: "clipboard" },
    });
  });

  it("should handle declined response", function* () {
    const [principal, operative] = yield* createTransportPair();
    const correlated: CorrelatedTransport = yield* createCorrelation(principal);

    let response: ElicitResponse | undefined;

    yield* spawn(function* () {
      response = yield* consumeStream(
        correlated.request<unknown, ElicitResponse>({
          id: "req-1",
          kind: "elicit",
          type: "confirmation",
          payload: { message: "Book this flight?" },
        })
      );
    });

    yield* sleep(0);

    const operativeSub = yield* operative;
    yield* operativeSub.next();

    yield* operative.send({
      type: "response",
      id: "req-1",
      response: { status: "declined" },
    });

    yield* sleep(0);

    expect(response).toEqual({ status: "declined" });
  });

  it("should handle 'other' response", function* () {
    const [principal, operative] = yield* createTransportPair();
    const correlated: CorrelatedTransport = yield* createCorrelation(principal);

    let response: ElicitResponse | undefined;

    yield* spawn(function* () {
      response = yield* consumeStream(
        correlated.request<unknown, ElicitResponse>({
          id: "req-1",
          kind: "elicit",
          type: "flight-selection",
          payload: { flights: [] },
        })
      );
    });

    yield* sleep(0);

    const operativeSub = yield* operative;
    yield* operativeSub.next();

    yield* operative.send({
      type: "response",
      id: "req-1",
      response: {
        status: "other",
        content: "What's the weather in Tokyo?",
      },
    });

    yield* sleep(0);

    expect(response).toEqual({
      status: "other",
      content: "What's the weather in Tokyo?",
    });
  });

  it("should handle cancelled response", function* () {
    const [principal, operative] = yield* createTransportPair();
    const correlated: CorrelatedTransport = yield* createCorrelation(principal);

    let response: ElicitResponse | undefined;

    yield* spawn(function* () {
      response = yield* consumeStream(
        correlated.request<unknown, ElicitResponse>({
          id: "req-1",
          kind: "elicit",
          type: "form",
          payload: { fields: [] },
        })
      );
    });

    yield* sleep(0);

    const operativeSub = yield* operative;
    yield* operativeSub.next();

    yield* operative.send({
      type: "response",
      id: "req-1",
      response: { status: "cancelled" },
    });

    yield* sleep(0);

    expect(response).toEqual({ status: "cancelled" });
  });
});
