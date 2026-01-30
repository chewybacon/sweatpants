import { describe, it, expect } from "@effectionx/vitest";
import { spawn, sleep } from "effection";
import { z } from "zod";
import { SweatpantsApi, elicit, notify, sample } from "../api.ts";
import { createTransportPair } from "../../transport/pair.ts";
import { createCorrelation } from "../../transport/correlation.ts";
import { TransportContext } from "../../context/transport.ts";
import type {
  TransportRequest,
  OperativeTransport,
  ResponseMessage,
} from "../../types/transport.ts";

describe("Built-in API", () => {
  describe("elicit", () => {
    it("should send elicit request through transport", function* () {
      const [principal, operative] = yield* createTransportPair();
      const correlated = yield* createCorrelation(principal);
      yield* TransportContext.set(correlated);

      // Set up operative handler
      yield* spawn(function* () {
        yield* handleOperativeRequests(operative, (request) => {
          expect(request.kind).toBe("elicit");
          expect(request.type).toBe("confirmation");
          return true; // User confirmed
        });
      });

      yield* sleep(0);

      const result = yield* elicit({
        type: "confirmation",
        message: "Are you sure?",
        schema: z.boolean(),
      });

      expect(result.status).toBe("accepted");
      if (result.status === "accepted") {
        expect(result.value).toBe(true);
      }
    });

    it("should handle declined elicit response", function* () {
      const [principal, operative] = yield* createTransportPair();
      const correlated = yield* createCorrelation(principal);
      yield* TransportContext.set(correlated);

      yield* spawn(function* () {
        const sub = yield* operative;
        const result = yield* sub.next();
        if (!result.done) {
          const request = result.value as TransportRequest;
          const response: ResponseMessage = {
            type: "response",
            id: request.id,
            response: { status: "declined" },
          };
          yield* operative.send(response);
        }
      });

      yield* sleep(0);

      const result = yield* elicit({
        type: "confirmation",
        message: "Confirm?",
        schema: z.boolean(),
      });

      expect(result.status).toBe("declined");
    });

    it("should handle cancelled elicit response", function* () {
      const [principal, operative] = yield* createTransportPair();
      const correlated = yield* createCorrelation(principal);
      yield* TransportContext.set(correlated);

      yield* spawn(function* () {
        const sub = yield* operative;
        const result = yield* sub.next();
        if (!result.done) {
          const request = result.value as TransportRequest;
          const response: ResponseMessage = {
            type: "response",
            id: request.id,
            response: { status: "cancelled" },
          };
          yield* operative.send(response);
        }
      });

      yield* sleep(0);

      const result = yield* elicit({
        type: "form",
        message: "Fill out this form",
        schema: z.object({ name: z.string() }),
      });

      expect(result.status).toBe("cancelled");
    });

    it("should pass payload correctly", function* () {
      const [principal, operative] = yield* createTransportPair();
      const correlated = yield* createCorrelation(principal);
      yield* TransportContext.set(correlated);

      let receivedPayload: unknown;

      yield* spawn(function* () {
        const sub = yield* operative;
        const result = yield* sub.next();
        if (!result.done) {
          const request = result.value as TransportRequest;
          receivedPayload = request.payload;
          const response: ResponseMessage = {
            type: "response",
            id: request.id,
            response: { status: "accepted", content: { name: "John" } },
          };
          yield* operative.send(response);
        }
      });

      yield* sleep(0);

      yield* elicit({
        type: "form",
        message: "Enter your name",
        schema: z.object({ name: z.string() }),
        meta: { theme: "dark" },
      });

      expect(receivedPayload).toMatchObject({
        message: "Enter your name",
        meta: { theme: "dark" },
      });
    });
  });

  describe("notify", () => {
    it("should send notification through transport", function* () {
      const [principal, operative] = yield* createTransportPair();
      const correlated = yield* createCorrelation(principal);
      yield* TransportContext.set(correlated);

      let receivedRequest: TransportRequest | undefined;

      yield* spawn(function* () {
        const sub = yield* operative;
        const result = yield* sub.next();
        if (!result.done) {
          receivedRequest = result.value as TransportRequest;
          const response: ResponseMessage = {
            type: "response",
            id: receivedRequest.id,
            response: { ok: true },
          };
          yield* operative.send(response);
        }
      });

      yield* sleep(0);

      const result = yield* notify({
        message: "Processing...",
        progress: 0.5,
        level: "info",
      });

      expect(result.ok).toBe(true);
      expect(receivedRequest?.kind).toBe("notify");
      expect(receivedRequest?.payload).toMatchObject({
        message: "Processing...",
        progress: 0.5,
        level: "info",
      });
    });

    it("should handle failed notification", function* () {
      const [principal, operative] = yield* createTransportPair();
      const correlated = yield* createCorrelation(principal);
      yield* TransportContext.set(correlated);

      yield* spawn(function* () {
        const sub = yield* operative;
        const result = yield* sub.next();
        if (!result.done) {
          const request = result.value as TransportRequest;
          const response: ResponseMessage = {
            type: "response",
            id: request.id,
            response: { ok: false, error: new Error("Network error") },
          };
          yield* operative.send(response);
        }
      });

      yield* sleep(0);

      const result = yield* notify({ message: "Test" });

      expect(result.ok).toBe(false);
    });
  });

  describe("sample", () => {
    it("should send sample request through transport", function* () {
      const [principal, operative] = yield* createTransportPair();
      const correlated = yield* createCorrelation(principal);
      yield* TransportContext.set(correlated);

      yield* spawn(function* () {
        yield* handleOperativeRequests(operative, (request) => {
          expect(request.kind).toBe("elicit");
          expect(request.type).toBe("sample");
          return {
            text: "Quantum computing uses qubits...",
            usage: { promptTokens: 10, completionTokens: 50, totalTokens: 60 },
            model: "gpt-4",
            finishReason: "stop",
          };
        });
      });

      yield* sleep(0);

      const result = yield* sample({
        prompt: "Explain quantum computing",
        maxTokens: 150,
        temperature: 0.7,
      });

      expect(result.text).toBe("Quantum computing uses qubits...");
      expect(result.usage?.totalTokens).toBe(60);
      expect(result.model).toBe("gpt-4");
    });

    it("should handle sample with message array", function* () {
      const [principal, operative] = yield* createTransportPair();
      const correlated = yield* createCorrelation(principal);
      yield* TransportContext.set(correlated);

      let receivedPayload: unknown;

      yield* spawn(function* () {
        const sub = yield* operative;
        const result = yield* sub.next();
        if (!result.done) {
          const request = result.value as TransportRequest;
          receivedPayload = request.payload;
          const response: ResponseMessage = {
            type: "response",
            id: request.id,
            response: {
              status: "accepted",
              content: { text: "Response", finishReason: "stop" },
            },
          };
          yield* operative.send(response);
        }
      });

      yield* sleep(0);

      yield* sample({
        prompt: [
          { role: "system", content: "You are a helpful assistant" },
          { role: "user", content: "Hello" },
        ],
      });

      expect((receivedPayload as { prompt: unknown }).prompt).toEqual([
        { role: "system", content: "You are a helpful assistant" },
        { role: "user", content: "Hello" },
      ]);
    });

    it("should throw on declined sample", function* () {
      const [principal, operative] = yield* createTransportPair();
      const correlated = yield* createCorrelation(principal);
      yield* TransportContext.set(correlated);

      yield* spawn(function* () {
        const sub = yield* operative;
        const result = yield* sub.next();
        if (!result.done) {
          const request = result.value as TransportRequest;
          const response: ResponseMessage = {
            type: "response",
            id: request.id,
            response: { status: "declined" },
          };
          yield* operative.send(response);
        }
      });

      yield* sleep(0);

      let error: Error | undefined;
      try {
        yield* sample({ prompt: "Test" });
      } catch (e) {
        error = e as Error;
      }

      expect(error).toBeDefined();
      expect(error?.message).toContain("declined");
    });
  });

  describe("decorate", () => {
    it("should allow middleware to intercept elicit", function* () {
      const [principal, operative] = yield* createTransportPair();
      const correlated = yield* createCorrelation(principal);
      yield* TransportContext.set(correlated);

      const callOrder: string[] = [];

      yield* SweatpantsApi.decorate({
        *elicit([options], next) {
          callOrder.push("middleware-before");
          const result = yield* next(options);
          callOrder.push("middleware-after");
          return result;
        },
      });

      yield* spawn(function* () {
        yield* handleOperativeRequests(operative, () => {
          callOrder.push("transport");
          return { confirmed: true };
        });
      });

      yield* sleep(0);

      yield* elicit({
        type: "confirmation",
        message: "Confirm?",
        schema: z.object({ confirmed: z.boolean() }),
      });

      expect(callOrder).toEqual([
        "middleware-before",
        "transport",
        "middleware-after",
      ]);
    });

    it("should allow middleware to modify sample options", function* () {
      const [principal, operative] = yield* createTransportPair();
      const correlated = yield* createCorrelation(principal);
      yield* TransportContext.set(correlated);

      let receivedPayload: unknown;

      yield* SweatpantsApi.decorate({
        *sample([options], next) {
          // Add default maxTokens if not specified
          return yield* next({
            ...options,
            maxTokens: options.maxTokens ?? 100,
            model: "gpt-4-turbo",
          });
        },
      });

      yield* spawn(function* () {
        const sub = yield* operative;
        const result = yield* sub.next();
        if (!result.done) {
          const request = result.value as TransportRequest;
          receivedPayload = request.payload;
          const response: ResponseMessage = {
            type: "response",
            id: request.id,
            response: { status: "accepted", content: { text: "OK" } },
          };
          yield* operative.send(response);
        }
      });

      yield* sleep(0);

      yield* sample({ prompt: "Test" });

      expect((receivedPayload as { maxTokens: number }).maxTokens).toBe(100);
      expect((receivedPayload as { model: string }).model).toBe("gpt-4-turbo");
    });

    it("should allow middleware to intercept notify", function* () {
      const [principal, operative] = yield* createTransportPair();
      const correlated = yield* createCorrelation(principal);
      yield* TransportContext.set(correlated);

      const notifications: string[] = [];

      yield* SweatpantsApi.decorate({
        *notify([options], next) {
          notifications.push(`[LOG] ${options.message}`);
          return yield* next(options);
        },
      });

      yield* spawn(function* () {
        yield* handleOperativeRequests(operative, () => ({ ok: true }), "notify");
      });

      yield* sleep(0);

      yield* notify({ message: "Processing started" });
      yield* notify({ message: "Processing complete" });

      expect(notifications).toEqual([
        "[LOG] Processing started",
        "[LOG] Processing complete",
      ]);
    });
  });
});

/**
 * Helper function to handle operative requests.
 */
function* handleOperativeRequests(
  operative: OperativeTransport,
  handler: (request: TransportRequest) => unknown,
  expectedKind?: "elicit" | "notify",
) {
  const sub = yield* operative;

  for (;;) {
    const result = yield* sub.next();
    if (result.done) break;

    const request = result.value as TransportRequest;

    if (expectedKind && request.kind !== expectedKind) {
      continue;
    }

    try {
      const content = handler(request);
      let response: ResponseMessage;
      if (request.kind === "notify") {
        response = {
          type: "response",
          id: request.id,
          response: { ok: true } as const,
        };
      } else {
        response = {
          type: "response",
          id: request.id,
          response: { status: "accepted" as const, content },
        };
      }
      yield* operative.send(response);
    } catch (e) {
      let response: ResponseMessage;
      if (request.kind === "notify") {
        response = {
          type: "response",
          id: request.id,
          response: { ok: false as const, error: e as Error },
        };
      } else {
        response = {
          type: "response",
          id: request.id,
          response: { status: "other" as const, content: (e as Error).message },
        };
      }
      yield* operative.send(response);
    }
  }
}
