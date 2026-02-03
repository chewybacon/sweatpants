import { describe, it, expect } from "@effectionx/vitest";
import { spawn, sleep, each } from "effection";
import { MemoryPair } from "../middleware/memory.ts";
import { initTransport, TransportError } from "../api.ts";
import type {
  TransportRequest,
  ResponseMessage,
  ProgressMessage,
} from "../../types/transport.ts";

describe("TransportApi with MemoryPair", () => {
  describe("initTransport", () => {
    it("should return principal interface with send, request, and stream", function* () {
      const [MemoryPrincipal] = MemoryPair();

      const principal = yield* initTransport(MemoryPrincipal());

      expect(principal.send).toBeDefined();
      expect(principal.request).toBeDefined();
      expect(principal.stream).toBeDefined();
    });

    it("should return operative interface with send and stream (no request)", function* () {
      const [, MemoryOperative] = MemoryPair();

      const operative = yield* initTransport(MemoryOperative());

      expect(operative.send).toBeDefined();
      expect(operative.stream).toBeDefined();
      expect("request" in operative).toBe(false);
    });
  });

  describe("send/stream", () => {
    it("should send requests from principal to operative", function* () {
      const [MemoryPrincipal, MemoryOperative] = MemoryPair();

      const typedRequest: TransportRequest = {
        id: "req-1",
        kind: "elicit",
        type: "location",
        payload: { accuracy: "high" },
      };

      const receivedRequests: TransportRequest[] = [];

      // Set up operative
      const operative = yield* initTransport(MemoryOperative());

      yield* spawn(function* () {
        for (const req of yield* each(yield* operative.stream())) {
          receivedRequests.push(req as TransportRequest);
          yield* each.next();
        }
      });

      yield* sleep(0);

      // Set up principal and send
      const principal = yield* initTransport(MemoryPrincipal());
      yield* principal.send(typedRequest);

      yield* sleep(0);

      expect(receivedRequests).toHaveLength(1);
      expect(receivedRequests[0]).toEqual(typedRequest);
    });

    it("should send responses from operative to principal", function* () {
      const [MemoryPrincipal, MemoryOperative] = MemoryPair();

      const response: ResponseMessage<"elicit"> = {
        type: "response",
        id: "req-1",
        kind: "elicit",
        response: { status: "accepted", content: { lat: 40.7128, lng: -74.006 } },
      };

      const receivedMessages: ResponseMessage<"elicit">[] = [];

      // Set up principal
      const principal = yield* initTransport(MemoryPrincipal());

      yield* spawn(function* () {
        for (const msg of yield* each(yield* principal.stream())) {
          receivedMessages.push(msg as ResponseMessage<"elicit">);
          yield* each.next();
        }
      });

      yield* sleep(0);

      // Set up operative and send response
      const operative = yield* initTransport(MemoryOperative());
      yield* operative.send(response);

      yield* sleep(0);

      expect(receivedMessages).toHaveLength(1);
      expect(receivedMessages[0]).toEqual(response);
    });

    it("should send progress from operative to principal", function* () {
      const [MemoryPrincipal, MemoryOperative] = MemoryPair();

      const progress: ProgressMessage = {
        type: "progress",
        id: "req-1",
        data: { status: "loading", percent: 50 },
      };

      const receivedMessages: ProgressMessage[] = [];

      const principal = yield* initTransport(MemoryPrincipal());

      yield* spawn(function* () {
        for (const msg of yield* each(yield* principal.stream())) {
          receivedMessages.push(msg as ProgressMessage);
          yield* each.next();
        }
      });

      yield* sleep(0);

      const operative = yield* initTransport(MemoryOperative());
      yield* operative.send(progress);

      yield* sleep(0);

      expect(receivedMessages).toHaveLength(1);
      expect(receivedMessages[0]).toEqual(progress);
    });
  });

  describe("request/response correlation", () => {
    it("should correlate request with response via request()", function* () {
      const [MemoryPrincipal, MemoryOperative] = MemoryPair();

      // Set up operative to respond
      const operative = yield* initTransport(MemoryOperative());

      yield* spawn(function* () {
        for (const req of yield* each(yield* operative.stream())) {
          const typedReq = req as TransportRequest<"elicit">;
          yield* operative.send({
            type: "response",
            id: typedReq.id,
            kind: "elicit",
            response: { status: "accepted", content: "user response" },
          });
          yield* each.next();
        }
      });

      yield* sleep(0);

      // Principal makes a request
      const principal = yield* initTransport(MemoryPrincipal());
      yield* sleep(0); // Let principal's router start

      const receivedResponse = yield* principal.request({
        kind: "elicit",
        type: "confirmation",
        payload: { message: "Confirm?" },
      });

      expect(receivedResponse).toEqual({
        status: "accepted",
        content: "user response",
      });
    });

    it("should correlate multiple concurrent requests", function* () {
      const [MemoryPrincipal, MemoryOperative] = MemoryPair();

      // Set up operative to respond to each request with unique response
      const operative = yield* initTransport(MemoryOperative());

      yield* spawn(function* () {
        for (const req of yield* each(yield* operative.stream())) {
          const typedReq = req as TransportRequest<"elicit">;
          yield* operative.send({
            type: "response",
            id: typedReq.id,
            kind: "elicit",
            response: {
              status: "accepted",
              content: `response for ${typedReq.payload}`,
            },
          });
          yield* each.next();
        }
      });

      yield* sleep(0);

      const principal = yield* initTransport(MemoryPrincipal());
      yield* sleep(0); // Let principal's router start

      // Launch two concurrent requests
      const task1 = yield* spawn(function* () {
        return yield* principal.request({
          kind: "elicit",
          type: "input",
          payload: "request-1",
        });
      });

      const task2 = yield* spawn(function* () {
        return yield* principal.request({
          kind: "elicit",
          type: "input",
          payload: "request-2",
        });
      });

      const responses = [yield* task1, yield* task2];

      expect(responses).toHaveLength(2);
      expect(responses).toContainEqual({
        status: "accepted",
        content: "response for request-1",
      });
      expect(responses).toContainEqual({
        status: "accepted",
        content: "response for request-2",
      });
    });

    it("should handle sample request kind", function* () {
      const [MemoryPrincipal, MemoryOperative] = MemoryPair();

      const operative = yield* initTransport(MemoryOperative());

      yield* spawn(function* () {
        for (const req of yield* each(yield* operative.stream())) {
          const typedReq = req as TransportRequest<"sample">;
          yield* operative.send({
            type: "response",
            id: typedReq.id,
            kind: "sample",
            response: { status: "accepted", content: "Generated text from LLM" },
          });
          yield* each.next();
        }
      });

      yield* sleep(0);

      const principal = yield* initTransport(MemoryPrincipal());
      yield* sleep(0); // Let principal's router start

      const receivedResponse = yield* principal.request({
        kind: "sample",
        type: "llm",
        payload: { prompt: "Hello" },
      });

      expect(receivedResponse).toEqual({
        status: "accepted",
        content: "Generated text from LLM",
      });
    });

    it("should handle notify request kind", function* () {
      const [MemoryPrincipal, MemoryOperative] = MemoryPair();

      const operative = yield* initTransport(MemoryOperative());

      yield* spawn(function* () {
        for (const req of yield* each(yield* operative.stream())) {
          const typedReq = req as TransportRequest<"notify">;
          yield* operative.send({
            type: "response",
            id: typedReq.id,
            kind: "notify",
            response: { ok: true },
          });
          yield* each.next();
        }
      });

      yield* sleep(0);

      const principal = yield* initTransport(MemoryPrincipal());
      yield* sleep(0); // Let principal's router start

      const receivedResponse = yield* principal.request({
        kind: "notify",
        type: "toast",
        payload: { message: "Hello!" },
      });

      expect(receivedResponse).toEqual({
        ok: true,
      });
    });
  });

  describe("bidirectional communication", () => {
    it("should handle full request/progress/response flow", function* () {
      const [MemoryPrincipal, MemoryOperative] = MemoryPair();

      const progressReceived: ProgressMessage[] = [];

      const operative = yield* initTransport(MemoryOperative());

      // Operative handles requests with progress updates
      yield* spawn(function* () {
        for (const req of yield* each(yield* operative.stream())) {
          const typedReq = req as TransportRequest<"elicit">;

          // Send progress
          yield* operative.send({
            type: "progress",
            id: typedReq.id,
            data: { status: "processing" },
          });

          yield* sleep(5);

          // Send final response
          yield* operative.send({
            type: "response",
            id: typedReq.id,
            kind: "elicit",
            response: { status: "accepted", content: "done" },
          });

          yield* each.next();
        }
      });

      yield* sleep(0);

      const principal = yield* initTransport(MemoryPrincipal());

      // Listen for progress in background
      yield* spawn(function* () {
        for (const msg of yield* each(yield* principal.stream())) {
          if ((msg as { type: string }).type === "progress") {
            progressReceived.push(msg as ProgressMessage);
          }
          yield* each.next();
        }
      });

      yield* sleep(0);

      // Make request (will wait for response)
      const finalResponse = yield* principal.request({
        kind: "elicit",
        type: "task",
        payload: {},
      });

      expect(progressReceived).toHaveLength(1);
      expect(progressReceived[0]!.data).toEqual({ status: "processing" });
      expect(finalResponse).toEqual({ status: "accepted", content: "done" });
    });
  });

  describe("ID generation", () => {
    it("should generate unique IDs for requests", function* () {
      const [MemoryPrincipal, MemoryOperative] = MemoryPair();

      const receivedIds: string[] = [];

      const operative = yield* initTransport(MemoryOperative());

      yield* spawn(function* () {
        for (const req of yield* each(yield* operative.stream())) {
          const typedReq = req as TransportRequest;
          receivedIds.push(typedReq.id);
          yield* operative.send({
            type: "response",
            id: typedReq.id,
            kind: typedReq.kind,
            response: { status: "accepted", content: null },
          });
          yield* each.next();
        }
      });

      yield* sleep(0);

      const principal = yield* initTransport(MemoryPrincipal());
      yield* sleep(0); // Let principal's router start

      yield* principal.request({
        kind: "elicit",
        type: "test",
        payload: {},
      });

      yield* principal.request({
        kind: "elicit",
        type: "test",
        payload: {},
      });

      expect(receivedIds).toHaveLength(2);
      expect(receivedIds[0]).toMatch(/^req_\d+_[a-z0-9]+$/);
      expect(receivedIds[1]).toMatch(/^req_\d+_[a-z0-9]+$/);
      expect(receivedIds[0]).not.toBe(receivedIds[1]);
    });
  });
});

describe("TransportError", () => {
  it("should have correct name and code", function* () {
    const error = new TransportError("test message", "NOT_CONFIGURED");

    expect(error.name).toBe("TransportError");
    expect(error.code).toBe("NOT_CONFIGURED");
    expect(error.message).toBe("test message");
  });
});
