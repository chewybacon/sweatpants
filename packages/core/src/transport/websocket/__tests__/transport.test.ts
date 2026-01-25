import { createServer } from "node:http";
import { describe, it, expect } from "@effectionx/vitest";
import { spawn, sleep, resource, withResolvers, type Operation } from "effection";
import { WebSocketServer, type WebSocket as WsWebSocket } from "ws";
import { createWebSocketPrincipal } from "../principal.ts";
import { createCorrelation, type CorrelatedTransport } from "../../correlation.ts";
import type {
  PrincipalTransport,
  TransportRequest,
  ElicitResponse,
} from "../../../types/transport.ts";
import type { WebSocketWireMessage } from "../principal.ts";

// ============================================================================
// Test Utilities
// ============================================================================

interface WebSocketTestPair {
  principal: PrincipalTransport;
  correlated: CorrelatedTransport;
  operative: {
    send: (msg: WebSocketWireMessage) => Operation<void>;
  };
}

function useWebSocketTestServer(): Operation<WebSocketTestPair> {
  return resource(function* (provide) {
    const httpServer = createServer();
    const wss = new WebSocketServer({ server: httpServer });

    // Listen on random port
    const listening = withResolvers<void>();
    httpServer.listen(0, listening.resolve);
    yield* listening.operation;

    const address = httpServer.address();
    const port = typeof address === "object" && address ? address.port : 0;

    // Set up connection listener before client connects
    const connectionReady = withResolvers<WsWebSocket>();
    wss.on("connection", connectionReady.resolve);

    // Create principal transport (this initiates connection)
    const principal = yield* createWebSocketPrincipal(`ws://localhost:${port}`);
    const correlated = yield* createCorrelation(principal);

    // Now await the server-side socket
    const rawSocket = yield* connectionReady.operation;

    try {
      yield* provide({
        principal,
        correlated,
        operative: {
          send: (msg: WebSocketWireMessage): Operation<void> => ({
            *[Symbol.iterator]() {
              const { operation, resolve, reject } = withResolvers<void>();
              rawSocket.send(JSON.stringify(msg), (err) => {
                if (err) {
                  reject(err);
                } else {
                  resolve();
                }
              });
              return yield* operation;
            },
          }),
        },
      });
    } finally {
      rawSocket.close();
      wss.close();
      const closed = withResolvers<void>();
      httpServer.close(() => closed.resolve());
      yield* closed.operation;
    }
  });
}

// ============================================================================
// Tests
// ============================================================================

describe("WebSocket Transport", () => {
  describe("PrincipalTransport (with correlation)", () => {
    it("should send messages via WebSocket", function* () {
      const { correlated, operative } = yield* useWebSocketTestServer();

      const message: TransportRequest = {
        id: "msg-1",
        kind: "elicit",
        type: "location",
        payload: { accuracy: "high" },
      };

      // Start consuming the stream (this triggers the send)
      yield* spawn(function* () {
        const subscription = yield* correlated.request(message);
        const result = yield* subscription.next();
        expect(result.done).toBe(true);
      });

      yield* sleep(10);

      // Complete the request so the test can finish
      yield* operative.send({
        type: "response",
        id: "msg-1",
        response: { status: "accepted", content: {} },
      });
    });

    it("should receive progress events via stream", function* () {
      const { correlated, operative } = yield* useWebSocketTestServer();

      const message: TransportRequest = {
        id: "msg-1",
        kind: "elicit",
        type: "location",
        payload: { accuracy: "high" },
      };

      let result: IteratorResult<unknown, ElicitResponse>;

      yield* spawn(function* () {
        const subscription = yield* correlated.request<unknown, ElicitResponse>(message);

        // First progress
        result = yield* subscription.next();
        expect(result.done).toBe(false);
        expect(result.value).toEqual({ status: "requesting-permission" });

        // Second progress
        result = yield* subscription.next();
        expect(result.done).toBe(false);
        expect(result.value).toEqual({ status: "acquiring" });

        // Final response
        result = yield* subscription.next();
        expect(result.done).toBe(true);
        expect(result.value).toEqual({
          status: "accepted",
          content: { lat: 40.7128, lng: -74.006 },
        });
      });

      yield* sleep(10);

      // Operative sends progress updates
      yield* operative.send({
        type: "progress",
        id: "msg-1",
        data: { status: "requesting-permission" },
      });

      yield* sleep(10);

      yield* operative.send({
        type: "progress",
        id: "msg-1",
        data: { status: "acquiring" },
      });

      yield* sleep(10);

      // Operative sends final response
      yield* operative.send({
        type: "response",
        id: "msg-1",
        response: {
          status: "accepted",
          content: { lat: 40.7128, lng: -74.006 },
        },
      });
    });

    it("should close stream with final response", function* () {
      const { correlated, operative } = yield* useWebSocketTestServer();

      const message: TransportRequest = {
        id: "msg-1",
        kind: "elicit",
        type: "location",
        payload: { accuracy: "high" },
      };

      yield* spawn(function* () {
        const subscription = yield* correlated.request<unknown, ElicitResponse>(message);

        // Final response (no progress)
        const result = yield* subscription.next();
        expect(result.done).toBe(true);
        expect(result.value).toEqual({
          status: "accepted",
          content: { lat: 40.7128, lng: -74.006 },
        });
      });

      yield* sleep(10);

      yield* operative.send({
        type: "response",
        id: "msg-1",
        response: {
          status: "accepted",
          content: { lat: 40.7128, lng: -74.006 },
        },
      });
    });

    it("should handle multiple concurrent requests", function* () {
      const { correlated, operative } = yield* useWebSocketTestServer();

      const responses: Record<string, ElicitResponse | undefined> = {};

      yield* spawn(function* () {
        const subscription = yield* correlated.request<unknown, ElicitResponse>({
          id: "msg-1",
          kind: "elicit",
          type: "location",
          payload: { accuracy: "high" },
        });
        const result = yield* subscription.next();
        expect(result.done).toBe(true);
        if (result.done) {
          responses["msg-1"] = result.value;
        }
      });

      yield* spawn(function* () {
        const subscription = yield* correlated.request<unknown, ElicitResponse>({
          id: "msg-2",
          kind: "elicit",
          type: "clipboard-read",
          payload: {},
        });
        const result = yield* subscription.next();
        expect(result.done).toBe(true);
        if (result.done) {
          responses["msg-2"] = result.value;
        }
      });

      yield* sleep(10);

      // Respond out of order
      yield* operative.send({
        type: "response",
        id: "msg-2",
        response: { status: "accepted", content: { text: "Hello clipboard" } },
      });

      yield* operative.send({
        type: "response",
        id: "msg-1",
        response: { status: "denied" },
      });

      yield* sleep(10);

      expect(responses["msg-1"]).toEqual({ status: "denied" });
      expect(responses["msg-2"]).toEqual({
        status: "accepted",
        content: { text: "Hello clipboard" },
      });
    });

    it("should handle declined response", function* () {
      const { correlated, operative } = yield* useWebSocketTestServer();

      yield* spawn(function* () {
        const subscription = yield* correlated.request<unknown, ElicitResponse>({
          id: "msg-1",
          kind: "elicit",
          type: "confirmation",
          payload: { message: "Book this flight?" },
        });
        const result = yield* subscription.next();
        expect(result.done).toBe(true);
        expect(result.value).toEqual({ status: "declined" });
      });

      yield* sleep(10);

      yield* operative.send({
        type: "response",
        id: "msg-1",
        response: { status: "declined" },
      });
    });

    it("should handle 'other' response when user goes off-script", function* () {
      const { correlated, operative } = yield* useWebSocketTestServer();

      yield* spawn(function* () {
        const subscription = yield* correlated.request<unknown, ElicitResponse>({
          id: "msg-1",
          kind: "elicit",
          type: "flight-selection",
          payload: { flights: [] },
        });
        const result = yield* subscription.next();
        expect(result.done).toBe(true);
        expect(result.value).toEqual({
          status: "other",
          content: "Actually, what's the weather like in Tokyo?",
        });
      });

      yield* sleep(10);

      yield* operative.send({
        type: "response",
        id: "msg-1",
        response: {
          status: "other",
          content: "Actually, what's the weather like in Tokyo?",
        },
      });
    });

    it("should handle cancelled response", function* () {
      const { correlated, operative } = yield* useWebSocketTestServer();

      yield* spawn(function* () {
        const subscription = yield* correlated.request<unknown, ElicitResponse>({
          id: "msg-1",
          kind: "elicit",
          type: "form",
          payload: { fields: [] },
        });
        const result = yield* subscription.next();
        expect(result.done).toBe(true);
        expect(result.value).toEqual({ status: "cancelled" });
      });

      yield* sleep(10);

      yield* operative.send({
        type: "response",
        id: "msg-1",
        response: { status: "cancelled" },
      });
    });
  });

  describe("Raw Transport (without correlation)", () => {
    it("should send and receive raw messages", function* () {
      const { principal } = yield* useWebSocketTestServer();

      const request: TransportRequest = {
        id: "req-1",
        kind: "elicit",
        type: "test",
        payload: {},
      };

      yield* principal.send(request);
      // The message was sent successfully if no error is thrown
    });
  });
});
