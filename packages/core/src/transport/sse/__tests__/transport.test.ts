import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { describe, it, expect } from "@effectionx/vitest";
import { spawn, sleep, resource, withResolvers, type Operation } from "effection";
import { createSSEPrincipal } from "../principal.ts";
import { createCorrelation, type CorrelatedTransport } from "../../correlation.ts";
import type {
  PrincipalTransport,
  TransportRequest,
  ElicitResponse,
  ProgressMessage,
  ResponseMessage,
} from "../../../types/transport.ts";

// ============================================================================
// Test Utilities
// ============================================================================

interface SSETestServer {
  principal: PrincipalTransport;
  correlated: CorrelatedTransport;
  operative: {
    send: (msg: ProgressMessage | ResponseMessage) => Operation<void>;
    received: TransportRequest[];
  };
}

function useSSETestServer(): Operation<SSETestServer> {
  return resource(function* (provide) {
    const postedRequests: TransportRequest[] = [];
    const sseResponses: ServerResponse[] = [];

    const httpServer = createServer(
      (req: IncomingMessage, res: ServerResponse) => {
        if (req.url === "/sse" && req.method === "GET") {
          // SSE endpoint
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });
          sseResponses.push(res);
        } else if (req.url === "/post" && req.method === "POST") {
          // POST endpoint for requests
          let body = "";
          req.on("data", (chunk) => {
            body += chunk;
          });
          req.on("end", () => {
            try {
              const request = JSON.parse(body);
              postedRequests.push(request);
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ ok: true }));
            } catch {
              res.writeHead(400);
              res.end("Invalid JSON");
            }
          });
        } else {
          res.writeHead(404);
          res.end("Not found");
        }
      }
    );

    // Listen on random port
    const listening = withResolvers<void>();
    httpServer.listen(0, () => listening.resolve());
    yield* listening.operation;

    const address = httpServer.address();
    const port = typeof address === "object" && address ? address.port : 0;

    // Create principal transport
    const principal = yield* createSSEPrincipal({
      sseUrl: `http://localhost:${port}/sse`,
      postUrl: `http://localhost:${port}/post`,
    });
    const correlated = yield* createCorrelation(principal);

    // Wait for SSE connection
    yield* sleep(10);

    try {
      yield* provide({
        principal,
        correlated,
        operative: {
          send: (msg: ProgressMessage | ResponseMessage): Operation<void> => ({
            *[Symbol.iterator]() {
              const res = sseResponses[0];
              if (!res) {
                throw new Error("No SSE connection established");
              }
              const { operation, resolve, reject } = withResolvers<void>();
              res.write(`data: ${JSON.stringify(msg)}\n\n`, "utf-8", (err) => {
                if (err) {
                  reject(err);
                } else {
                  resolve();
                }
              });
              return yield* operation;
            },
          }),
          received: postedRequests,
        },
      });
    } finally {
      for (const res of sseResponses) {
        res.end();
      }
      const closed = withResolvers<void>();
      httpServer.close(() => closed.resolve());
      yield* closed.operation;
    }
  });
}

// ============================================================================
// Tests
// ============================================================================

describe("SSE+POST Transport", () => {
  describe("PrincipalTransport (with correlation)", () => {
    it("should send messages via POST", function* () {
      const { correlated, operative } = yield* useSSETestServer();

      const message: TransportRequest = {
        id: "msg-1",
        kind: "elicit",
        type: "location",
        payload: { accuracy: "high" },
      };

      yield* spawn(function* () {
        const subscription = yield* correlated.request(message);
        const result = yield* subscription.next();
        expect(result.done).toBe(true);
      });

      yield* sleep(20);

      expect(operative.received).toHaveLength(1);
      expect(operative.received[0]).toEqual(message);

      // Complete the request
      yield* operative.send({
        type: "response",
        id: "msg-1",
        response: { status: "accepted", content: {} },
      });
    });

    it("should receive progress events via stream", function* () {
      const { correlated, operative } = yield* useSSETestServer();

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

      yield* sleep(20);

      // Operative sends progress updates
      yield* operative.send({
        type: "progress",
        id: "msg-1",
        data: { status: "requesting-permission" },
      });

      yield* sleep(20);

      yield* operative.send({
        type: "progress",
        id: "msg-1",
        data: { status: "acquiring" },
      });

      yield* sleep(20);

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
      const { correlated, operative } = yield* useSSETestServer();

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

      yield* sleep(20);

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
      const { correlated, operative } = yield* useSSETestServer();

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

      yield* sleep(20);

      expect(operative.received).toHaveLength(2);

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

      yield* sleep(20);

      expect(responses["msg-1"]).toEqual({ status: "denied" });
      expect(responses["msg-2"]).toEqual({
        status: "accepted",
        content: { text: "Hello clipboard" },
      });
    });

    it("should handle declined response", function* () {
      const { correlated, operative } = yield* useSSETestServer();

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

      yield* sleep(20);

      yield* operative.send({
        type: "response",
        id: "msg-1",
        response: { status: "declined" },
      });
    });

    it("should handle 'other' response when user goes off-script", function* () {
      const { correlated, operative } = yield* useSSETestServer();

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

      yield* sleep(20);

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
      const { correlated, operative } = yield* useSSETestServer();

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

      yield* sleep(20);

      yield* operative.send({
        type: "response",
        id: "msg-1",
        response: { status: "cancelled" },
      });
    });
  });
});
