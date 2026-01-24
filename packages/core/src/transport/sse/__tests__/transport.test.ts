/**
 * Tests for SSE+POST Transport
 *
 * These tests validate the transport layer in isolation using mock
 * SSE and POST handlers. The tests verify:
 *
 * 1. Backend can send messages via onSend callback
 * 2. Frontend can send progress that arrives on backend stream
 * 3. Frontend can respond and backend stream closes with response
 * 4. Multiple concurrent requests work correctly
 * 5. All response types are handled correctly
 */

import { describe, it, expect } from "vitest";
import {
  run,
  spawn,
  sleep,
  type Operation,
  type Stream,
  type Subscription,
} from "effection";
import {
  createSSEBackendTransport,
  type SSEBackendTransport,
} from "../backend.ts";
import type {
  TransportRequest,
  ElicitResponse,
} from "../../../types/transport.ts";

/**
 * Helper to consume a stream, collecting progress and returning the final value.
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

describe("SSE+POST Transport", () => {
  describe("BackendTransport", () => {
    it("should send messages via onSend callback", async () => {
      await run(function* () {
        const sentMessages: TransportRequest[] = [];

        const transport: SSEBackendTransport = yield* createSSEBackendTransport(
          {
            *onSend(message) {
              sentMessages.push(message);
            },
          }
        );

        const message: TransportRequest = {
          id: "msg-1",
          kind: "elicit",
          type: "location",
          payload: { accuracy: "high" },
        };

        // Spawn a task to consume the stream
        yield* spawn(function* () {
          yield* consumeStream(transport.send(message));
        });

        // Yield to let the spawned task start and subscribe
        yield* sleep(0);

        // The message should be sent when the stream starts
        expect(sentMessages).toHaveLength(1);
        expect(sentMessages[0]).toEqual(message);

        // Send the response to complete the stream
        yield* transport.receiveResponse("msg-1", {
          status: "accepted",
          content: { lat: 40.7128, lng: -74.006 },
        });
      });
    });

    it("should receive progress events via stream", async () => {
      await run(function* () {
        const transport: SSEBackendTransport = yield* createSSEBackendTransport(
          {
            *onSend() {
              // No-op for this test
            },
          }
        );

        const message: TransportRequest = {
          id: "msg-1",
          kind: "elicit",
          type: "location",
          payload: { accuracy: "high" },
        };

        const progressReceived: unknown[] = [];
        let streamComplete = false;

        // Spawn a task to consume the stream
        yield* spawn(function* () {
          yield* consumeStream(transport.send(message), (progress) => {
            progressReceived.push(progress);
          });
          streamComplete = true;
        });

        // Yield to let the spawned task start and subscribe
        yield* sleep(0);

        // Send progress events
        yield* transport.receiveProgress("msg-1", {
          status: "requesting-permission",
        });
        
        // Yield to let the consumer process the progress
        yield* sleep(0);
        
        yield* transport.receiveProgress("msg-1", { status: "acquiring" });
        
        // Yield to let the consumer process the progress
        yield* sleep(0);

        // Send final response to close the stream
        yield* transport.receiveResponse("msg-1", {
          status: "accepted",
          content: { lat: 40.7128, lng: -74.006 },
        });

        // Yield to let the stream complete
        yield* sleep(0);

        expect(streamComplete).toBe(true);
        expect(progressReceived).toHaveLength(2);
        expect(progressReceived[0]).toEqual({ status: "requesting-permission" });
        expect(progressReceived[1]).toEqual({ status: "acquiring" });
      });
    });

    it("should close stream with final response", async () => {
      await run(function* () {
        const transport: SSEBackendTransport = yield* createSSEBackendTransport(
          {
            *onSend() {
              // No-op
            },
          }
        );

        const message: TransportRequest = {
          id: "msg-1",
          kind: "elicit",
          type: "location",
          payload: { accuracy: "high" },
        };

        let finalResponse: ElicitResponse | undefined;

        // Spawn a task to consume the stream and capture the final response
        yield* spawn(function* () {
          finalResponse = yield* consumeStream(
            transport.send<unknown, unknown, ElicitResponse>(message)
          );
        });

        // Yield to let the spawned task start and subscribe
        yield* sleep(0);

        // Send final response
        yield* transport.receiveResponse("msg-1", {
          status: "accepted",
          content: { lat: 40.7128, lng: -74.006 },
        });

        // Yield to let the spawned task process the response
        yield* sleep(0);

        expect(finalResponse).toEqual({
          status: "accepted",
          content: { lat: 40.7128, lng: -74.006 },
        });
      });
    });

    it("should handle multiple concurrent requests", async () => {
      await run(function* () {
        const sentMessages: TransportRequest[] = [];

        const transport: SSEBackendTransport = yield* createSSEBackendTransport(
          {
            *onSend(message) {
              sentMessages.push(message);
            },
          }
        );

        const responses: Record<string, ElicitResponse> = {};

        // Start two concurrent requests
        yield* spawn(function* () {
          responses["msg-1"] = yield* consumeStream(
            transport.send<unknown, unknown, ElicitResponse>({
              id: "msg-1",
              kind: "elicit",
              type: "location",
              payload: { accuracy: "high" },
            })
          );
        });

        yield* spawn(function* () {
          responses["msg-2"] = yield* consumeStream(
            transport.send<unknown, unknown, ElicitResponse>({
              id: "msg-2",
              kind: "elicit",
              type: "clipboard-read",
              payload: {},
            })
          );
        });

        // Yield to let spawned tasks start
        yield* sleep(0);

        // Both messages should be sent
        expect(sentMessages).toHaveLength(2);

        // Respond to both in reverse order
        yield* transport.receiveResponse("msg-2", {
          status: "accepted",
          content: { text: "Hello clipboard" },
        });

        yield* transport.receiveResponse("msg-1", {
          status: "denied",
        });

        // Yield to let spawned tasks process responses
        yield* sleep(0);

        expect(responses["msg-1"]).toEqual({ status: "denied" });
        expect(responses["msg-2"]).toEqual({
          status: "accepted",
          content: { text: "Hello clipboard" },
        });
      });
    });

    it("should handle declined response", async () => {
      await run(function* () {
        const transport: SSEBackendTransport = yield* createSSEBackendTransport(
          {
            *onSend() {},
          }
        );

        let response: ElicitResponse | undefined;

        yield* spawn(function* () {
          response = yield* consumeStream(
            transport.send<unknown, unknown, ElicitResponse>({
              id: "msg-1",
              kind: "elicit",
              type: "confirmation",
              payload: { message: "Book this flight?" },
            })
          );
        });

        yield* sleep(0);

        yield* transport.receiveResponse("msg-1", { status: "declined" });

        yield* sleep(0);

        expect(response).toEqual({ status: "declined" });
      });
    });

    it("should handle 'other' response when user goes off-script", async () => {
      await run(function* () {
        const transport: SSEBackendTransport = yield* createSSEBackendTransport(
          {
            *onSend() {},
          }
        );

        let response: ElicitResponse | undefined;

        yield* spawn(function* () {
          response = yield* consumeStream(
            transport.send<unknown, unknown, ElicitResponse>({
              id: "msg-1",
              kind: "elicit",
              type: "flight-selection",
              payload: { flights: [] },
            })
          );
        });

        yield* sleep(0);

        yield* transport.receiveResponse("msg-1", {
          status: "other",
          content: "Actually, what's the weather like in Tokyo?",
        });

        yield* sleep(0);

        expect(response).toEqual({
          status: "other",
          content: "Actually, what's the weather like in Tokyo?",
        });
      });
    });

    it("should handle cancelled response", async () => {
      await run(function* () {
        const transport: SSEBackendTransport = yield* createSSEBackendTransport(
          {
            *onSend() {},
          }
        );

        let response: ElicitResponse | undefined;

        yield* spawn(function* () {
          response = yield* consumeStream(
            transport.send<unknown, unknown, ElicitResponse>({
              id: "msg-1",
              kind: "elicit",
              type: "form",
              payload: { fields: [] },
            })
          );
        });

        yield* sleep(0);

        yield* transport.receiveResponse("msg-1", { status: "cancelled" });

        yield* sleep(0);

        expect(response).toEqual({ status: "cancelled" });
      });
    });
  });
});
