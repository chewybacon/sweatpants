import { describe, it, expect } from "@effectionx/vitest";
import { spawn, sleep, each } from "effection";
import { z } from "zod";
import { SweatpantsApi, elicit, notify, sample } from "../api.ts";
import { MemoryPair } from "../../transport/middleware/memory.ts";
import { TransportApi } from "../../transport/api.ts";
import type { TransportRequest } from "../../types/transport.ts";

describe("Built-in API", () => {
  describe("elicit", () => {
    it("should send elicit request through transport", function* () {
      const [MemoryPrincipal, MemoryOperative] = MemoryPair();

      // Decorate principal in main scope
      yield* TransportApi.decorate(yield* MemoryPrincipal());

      // Get operative middleware and respond to requests
      const operativeMiddleware = yield* MemoryOperative();
      const operativeStream = yield* operativeMiddleware.stream!([], function* () {
        throw new Error("No next");
      });

      yield* spawn(function* () {
        for (const req of yield* each(operativeStream)) {
          const request = req as TransportRequest;
          expect(request.kind).toBe("elicit");
          expect(request.type).toBe("confirmation");
          yield* operativeMiddleware.send!([{
            type: "response",
            id: request.id,
            kind: "elicit",
            response: { status: "accepted", content: true },
          }], function* () { /* no next */ });
          yield* each.next();
        }
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
      const [MemoryPrincipal, MemoryOperative] = MemoryPair();

      yield* TransportApi.decorate(yield* MemoryPrincipal());

      const operativeMiddleware = yield* MemoryOperative();
      const operativeStream = yield* operativeMiddleware.stream!([], function* () {
        throw new Error("No next");
      });

      yield* spawn(function* () {
        for (const req of yield* each(operativeStream)) {
          const request = req as TransportRequest;
          yield* operativeMiddleware.send!([{
            type: "response",
            id: request.id,
            kind: "elicit",
            response: { status: "declined" },
          }], function* () { /* no next */ });
          yield* each.next();
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
      const [MemoryPrincipal, MemoryOperative] = MemoryPair();

      yield* TransportApi.decorate(yield* MemoryPrincipal());

      const operativeMiddleware = yield* MemoryOperative();
      const operativeStream = yield* operativeMiddleware.stream!([], function* () {
        throw new Error("No next");
      });

      yield* spawn(function* () {
        for (const req of yield* each(operativeStream)) {
          const request = req as TransportRequest;
          yield* operativeMiddleware.send!([{
            type: "response",
            id: request.id,
            kind: "elicit",
            response: { status: "cancelled" },
          }], function* () { /* no next */ });
          yield* each.next();
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
      const [MemoryPrincipal, MemoryOperative] = MemoryPair();

      let receivedPayload: unknown;

      yield* TransportApi.decorate(yield* MemoryPrincipal());

      const operativeMiddleware = yield* MemoryOperative();
      const operativeStream = yield* operativeMiddleware.stream!([], function* () {
        throw new Error("No next");
      });

      yield* spawn(function* () {
        for (const req of yield* each(operativeStream)) {
          const request = req as TransportRequest;
          receivedPayload = request.payload;
          yield* operativeMiddleware.send!([{
            type: "response",
            id: request.id,
            kind: "elicit",
            response: { status: "accepted", content: { name: "John" } },
          }], function* () { /* no next */ });
          yield* each.next();
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
      const [MemoryPrincipal, MemoryOperative] = MemoryPair();

      let receivedRequest: TransportRequest | undefined;

      yield* TransportApi.decorate(yield* MemoryPrincipal());

      const operativeMiddleware = yield* MemoryOperative();
      const operativeStream = yield* operativeMiddleware.stream!([], function* () {
        throw new Error("No next");
      });

      yield* spawn(function* () {
        for (const req of yield* each(operativeStream)) {
          receivedRequest = req as TransportRequest;
          yield* operativeMiddleware.send!([{
            type: "response",
            id: receivedRequest.id,
            kind: "notify",
            response: { ok: true },
          }], function* () { /* no next */ });
          yield* each.next();
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
      const [MemoryPrincipal, MemoryOperative] = MemoryPair();

      yield* TransportApi.decorate(yield* MemoryPrincipal());

      const operativeMiddleware = yield* MemoryOperative();
      const operativeStream = yield* operativeMiddleware.stream!([], function* () {
        throw new Error("No next");
      });

      yield* spawn(function* () {
        for (const req of yield* each(operativeStream)) {
          const request = req as TransportRequest;
          yield* operativeMiddleware.send!([{
            type: "response",
            id: request.id,
            kind: "notify",
            response: { ok: false, error: { code: "NETWORK_ERROR", message: "Network error" } },
          }], function* () { /* no next */ });
          yield* each.next();
        }
      });

      yield* sleep(0);

      const result = yield* notify({ message: "Test" });

      expect(result.ok).toBe(false);
    });
  });

  describe("sample", () => {
    it("should send sample request through transport", function* () {
      const [MemoryPrincipal, MemoryOperative] = MemoryPair();

      yield* TransportApi.decorate(yield* MemoryPrincipal());

      const operativeMiddleware = yield* MemoryOperative();
      const operativeStream = yield* operativeMiddleware.stream!([], function* () {
        throw new Error("No next");
      });

      yield* spawn(function* () {
        for (const req of yield* each(operativeStream)) {
          const request = req as TransportRequest;
          expect(request.kind).toBe("sample");
          expect(request.type).toBe("llm");
          yield* operativeMiddleware.send!([{
            type: "response",
            id: request.id,
            kind: "sample",
            response: {
              status: "accepted",
              content: {
                text: "Quantum computing uses qubits...",
                usage: { promptTokens: 10, completionTokens: 50, totalTokens: 60 },
                model: "gpt-4",
                finishReason: "stop",
              },
            },
          }], function* () { /* no next */ });
          yield* each.next();
        }
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
      const [MemoryPrincipal, MemoryOperative] = MemoryPair();

      let receivedPayload: unknown;

      yield* TransportApi.decorate(yield* MemoryPrincipal());

      const operativeMiddleware = yield* MemoryOperative();
      const operativeStream = yield* operativeMiddleware.stream!([], function* () {
        throw new Error("No next");
      });

      yield* spawn(function* () {
        for (const req of yield* each(operativeStream)) {
          const request = req as TransportRequest;
          receivedPayload = request.payload;
          yield* operativeMiddleware.send!([{
            type: "response",
            id: request.id,
            kind: "sample",
            response: {
              status: "accepted",
              content: { text: "Response", finishReason: "stop" },
            },
          }], function* () { /* no next */ });
          yield* each.next();
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

    it("should throw on cancelled sample", function* () {
      const [MemoryPrincipal, MemoryOperative] = MemoryPair();

      yield* TransportApi.decorate(yield* MemoryPrincipal());

      const operativeMiddleware = yield* MemoryOperative();
      const operativeStream = yield* operativeMiddleware.stream!([], function* () {
        throw new Error("No next");
      });

      yield* spawn(function* () {
        for (const req of yield* each(operativeStream)) {
          const request = req as TransportRequest;
          yield* operativeMiddleware.send!([{
            type: "response",
            id: request.id,
            kind: "sample",
            response: { status: "cancelled" },
          }], function* () { /* no next */ });
          yield* each.next();
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
      expect(error?.message).toContain("cancelled");
    });
  });

  describe("decorate", () => {
    it("should allow middleware to intercept elicit", function* () {
      const [MemoryPrincipal, MemoryOperative] = MemoryPair();

      const callOrder: string[] = [];

      yield* TransportApi.decorate(yield* MemoryPrincipal());

      const operativeMiddleware = yield* MemoryOperative();
      const operativeStream = yield* operativeMiddleware.stream!([], function* () {
        throw new Error("No next");
      });

      yield* spawn(function* () {
        for (const req of yield* each(operativeStream)) {
          const request = req as TransportRequest;
          callOrder.push("transport");
          yield* operativeMiddleware.send!([{
            type: "response",
            id: request.id,
            kind: "elicit",
            response: { status: "accepted", content: { confirmed: true } },
          }], function* () { /* no next */ });
          yield* each.next();
        }
      });

      yield* sleep(0);

      yield* SweatpantsApi.decorate({
        *elicit([options], next) {
          callOrder.push("middleware-before");
          const result = yield* next(options);
          callOrder.push("middleware-after");
          return result;
        },
      });

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
      const [MemoryPrincipal, MemoryOperative] = MemoryPair();

      let receivedPayload: unknown;

      yield* TransportApi.decorate(yield* MemoryPrincipal());

      const operativeMiddleware = yield* MemoryOperative();
      const operativeStream = yield* operativeMiddleware.stream!([], function* () {
        throw new Error("No next");
      });

      yield* spawn(function* () {
        for (const req of yield* each(operativeStream)) {
          const request = req as TransportRequest;
          receivedPayload = request.payload;
          yield* operativeMiddleware.send!([{
            type: "response",
            id: request.id,
            kind: "sample",
            response: { status: "accepted", content: { text: "OK" } },
          }], function* () { /* no next */ });
          yield* each.next();
        }
      });

      yield* sleep(0);

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

      yield* sample({ prompt: "Test" });

      expect((receivedPayload as { maxTokens: number }).maxTokens).toBe(100);
      expect((receivedPayload as { model: string }).model).toBe("gpt-4-turbo");
    });

    it("should allow middleware to intercept notify", function* () {
      const [MemoryPrincipal, MemoryOperative] = MemoryPair();

      const notifications: string[] = [];

      yield* TransportApi.decorate(yield* MemoryPrincipal());

      const operativeMiddleware = yield* MemoryOperative();
      const operativeStream = yield* operativeMiddleware.stream!([], function* () {
        throw new Error("No next");
      });

      yield* spawn(function* () {
        for (const req of yield* each(operativeStream)) {
          const request = req as TransportRequest;
          yield* operativeMiddleware.send!([{
            type: "response",
            id: request.id,
            kind: "notify",
            response: { ok: true },
          }], function* () { /* no next */ });
          yield* each.next();
        }
      });

      yield* sleep(0);

      yield* SweatpantsApi.decorate({
        *notify([options], next) {
          notifications.push(`[LOG] ${options.message}`);
          return yield* next(options);
        },
      });

      yield* notify({ message: "Processing started" });
      yield* notify({ message: "Processing complete" });

      expect(notifications).toEqual([
        "[LOG] Processing started",
        "[LOG] Processing complete",
      ]);
    });
  });
});
