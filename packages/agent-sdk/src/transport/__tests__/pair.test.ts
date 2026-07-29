import { describe, it, expect } from "@effectionx/vitest";
import { spawn, sleep } from "effection";
import { createTransportPair } from "../pair.ts";
import type {
  TransportRequest,
  ProgressMessage,
  ResponseMessage,
  PrincipalIncoming,
  OperativeIncoming,
} from "../../types/transport.ts";

describe("createTransportPair", () => {
  it("should create a connected pair of transports", function* () {
    const [principal, operative] = yield* createTransportPair();

    expect(principal).toBeDefined();
    expect(operative).toBeDefined();
    expect(principal.send).toBeDefined();
    expect(operative.send).toBeDefined();
  });

  it("should send requests from principal to operative", function* () {
    const [principal, operative] = yield* createTransportPair();

    const request: TransportRequest = {
      id: "req-1",
      kind: "elicit",
      type: "location",
      payload: { accuracy: "high" },
    };

    const receivedRequests: OperativeIncoming[] = [];

    yield* spawn(function* () {
      const sub = yield* operative;
      const result = yield* sub.next();
      if (!result.done) {
        receivedRequests.push(result.value);
      }
    });

    yield* sleep(0);
    yield* principal.send(request);
    yield* sleep(0);

    expect(receivedRequests).toHaveLength(1);
    expect(receivedRequests[0]).toEqual(request);
  });

  it("should send progress from operative to principal", function* () {
    const [principal, operative] = yield* createTransportPair();

    const progress: ProgressMessage = {
      type: "progress",
      id: "req-1",
      data: { status: "loading" },
    };

    const receivedMessages: PrincipalIncoming[] = [];

    yield* spawn(function* () {
      const sub = yield* principal;
      const result = yield* sub.next();
      if (!result.done) {
        receivedMessages.push(result.value);
      }
    });

    yield* sleep(0);
    yield* operative.send(progress);
    yield* sleep(0);

    expect(receivedMessages).toHaveLength(1);
    expect(receivedMessages[0]).toEqual(progress);
  });

  it("should send responses from operative to principal", function* () {
    const [principal, operative] = yield* createTransportPair();

    const response: ResponseMessage = {
      type: "response",
      id: "req-1",
      response: { status: "accepted", content: { lat: 40.7128, lng: -74.006 } },
    };

    const receivedMessages: PrincipalIncoming[] = [];

    yield* spawn(function* () {
      const sub = yield* principal;
      const result = yield* sub.next();
      if (!result.done) {
        receivedMessages.push(result.value);
      }
    });

    yield* sleep(0);
    yield* operative.send(response);
    yield* sleep(0);

    expect(receivedMessages).toHaveLength(1);
    expect(receivedMessages[0]).toEqual(response);
  });

  it("should handle multiple concurrent requests", function* () {
    const [principal, operative] = yield* createTransportPair();

    const request1: TransportRequest = {
      id: "req-1",
      kind: "elicit",
      type: "location",
      payload: {},
    };

    const request2: TransportRequest = {
      id: "req-2",
      kind: "notify",
      type: "message",
      payload: { text: "Hello" },
    };

    const receivedRequests: OperativeIncoming[] = [];

    yield* spawn(function* () {
      const sub = yield* operative;
      for (let i = 0; i < 2; i++) {
        const result = yield* sub.next();
        if (!result.done) {
          receivedRequests.push(result.value);
        }
      }
    });

    yield* sleep(0);
    yield* principal.send(request1);
    yield* principal.send(request2);
    yield* sleep(0);

    expect(receivedRequests).toHaveLength(2);
    expect(receivedRequests[0]).toEqual(request1);
    expect(receivedRequests[1]).toEqual(request2);
  });

  it("should handle bidirectional communication", function* () {
    const [principal, operative] = yield* createTransportPair();

    const request: TransportRequest = {
      id: "req-1",
      kind: "elicit",
      type: "confirmation",
      payload: { message: "Confirm?" },
    };

    const progress: ProgressMessage = {
      type: "progress",
      id: "req-1",
      data: { status: "user-viewing" },
    };

    const response: ResponseMessage = {
      type: "response",
      id: "req-1",
      response: { status: "accepted", content: true },
    };

    const operativeReceived: OperativeIncoming[] = [];
    const principalReceived: PrincipalIncoming[] = [];

    // Operative receives requests
    yield* spawn(function* () {
      const sub = yield* operative;
      const result = yield* sub.next();
      if (!result.done) {
        operativeReceived.push(result.value);
      }
    });

    // Principal receives responses/progress
    yield* spawn(function* () {
      const sub = yield* principal;
      for (let i = 0; i < 2; i++) {
        const result = yield* sub.next();
        if (!result.done) {
          principalReceived.push(result.value);
        }
      }
    });

    yield* sleep(0);

    // Principal sends request
    yield* principal.send(request);
    yield* sleep(0);

    expect(operativeReceived).toHaveLength(1);
    expect(operativeReceived[0]).toEqual(request);

    // Operative sends progress
    yield* operative.send(progress);
    yield* sleep(0);

    expect(principalReceived).toHaveLength(1);
    expect(principalReceived[0]).toEqual(progress);

    // Operative sends response
    yield* operative.send(response);
    yield* sleep(0);

    expect(principalReceived).toHaveLength(2);
    expect(principalReceived[1]).toEqual(response);
  });
});
