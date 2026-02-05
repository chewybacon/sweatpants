import { describe, it, expect } from "@effectionx/vitest";
import { spawn, sleep, resource, type Operation, type Stream as EffStream } from "effection";
import { z } from "zod";
import { elicit, notify, sample } from "../api.ts";
import { SweatpantsProtocol } from "../protocol.ts";
import { createTransportPair } from "../../transport/pair.ts";
import { createCorrelation, type CorrelatedTransport } from "../../transport/correlation.ts";
import { createImplementation } from "../../protocol/create.ts";
import { serveProtocol } from "../../protocol/serve.ts";
import { TransportApi, generateRequestId, type TransportMiddleware } from "../../transport/api.ts";
import type { Stream } from "effection";
import type { z as zod } from "zod";
import type { PrincipalTransport, PrincipalIncoming, RequestKind, ResponseByKind, PrincipalOutgoing, OperativeOutgoing } from "../../types/transport.ts";

/**
 * Create middleware that wraps a CorrelatedTransport for use with TransportApi.
 * This bridges the old createTransportPair()/createCorrelation() pattern with the new TransportApi.decorate() API.
 */
function createCorrelatedMiddleware(
  transport: PrincipalTransport,
  correlated: CorrelatedTransport
): Operation<TransportMiddleware> {
  return (function* () {
    return {
      *send([message]: [PrincipalOutgoing | OperativeOutgoing], _next: (args_0: PrincipalOutgoing | OperativeOutgoing) => Operation<void>) {
        // Principal side only sends PrincipalOutgoing (requests)
        yield* transport.send(message as Parameters<PrincipalTransport["send"]>[0]);
      },
      *request([req]: [{ kind: RequestKind; type: string; payload: unknown }], _next: (args_0: { kind: RequestKind; type: string; payload: unknown }) => Operation<ResponseByKind[RequestKind]>) {
        const id = generateRequestId();
        const fullReq = { ...req, id };
        const stream: EffStream<unknown, ResponseByKind[RequestKind]> = correlated.request(fullReq);
        const sub = yield* stream;
        let result = yield* sub.next();
        while (!result.done) {
          result = yield* sub.next();
        }
        return result.value;
      },
      *stream(_args: [], _next: () => Operation<EffStream<PrincipalIncoming, void>>) {
        return transport as unknown as EffStream<PrincipalIncoming, void>;
      },
    } as TransportMiddleware;
  })();
}

describe("SweatpantsProtocol", () => {
  describe("with serveProtocol", () => {
    it("should handle elicit requests via protocol", function* () {
      const [principal, operative] = yield* createTransportPair();
      const correlated = yield* createCorrelation(principal);

      // Create protocol implementation
      const inspector = createImplementation(SweatpantsProtocol, function* () {
        return {
          elicit(payload): Stream<never, zod.infer<typeof SweatpantsProtocol.methods.elicit.output>> {
            return resource(function* (provide) {
              yield* provide({
                *next() {
                  // Simulate user accepting with a value
                  return {
                    done: true,
                    value: { status: "accepted" as const, value: `confirmed: ${payload.message}` },
                  };
                },
              });
            });
          },
          notify(_payload): Stream<never, zod.infer<typeof SweatpantsProtocol.methods.notify.output>> {
            return resource(function* (provide) {
              yield* provide({
                *next() {
                  return { done: true, value: { ok: true } };
                },
              });
            });
          },
          sample(payload): Stream<never, zod.infer<typeof SweatpantsProtocol.methods.sample.output>> {
            return resource(function* (provide) {
              yield* provide({
                *next() {
                  const prompt = typeof payload.prompt === "string" 
                    ? payload.prompt 
                    : payload.prompt.map((m: { content: string }) => m.content).join(" ");
                  return {
                    done: true,
                    value: { text: `Response to: ${prompt}` },
                  };
                },
              });
            });
          },
        };
      });

      // Attach and serve the protocol on operative side
      const handle = yield* inspector.attach();
      yield* spawn(function* () {
        yield* serveProtocol(handle, operative);
      });

      yield* sleep(0);

      // Initialize transport on principal side using the correlated middleware
      yield* TransportApi.decorate(yield* createCorrelatedMiddleware(principal, correlated));

      yield* sleep(0);

      // Test elicit
      const elicitResult = yield* elicit({
        type: "confirmation",
        message: "Are you sure?",
        schema: z.string(),
      });

      expect(elicitResult.status).toBe("accepted");
      if (elicitResult.status === "accepted") {
        expect(elicitResult.value).toBe("confirmed: Are you sure?");
      }
    });

    it("should handle notify requests via protocol", function* () {
      const [principal, operative] = yield* createTransportPair();
      const correlated = yield* createCorrelation(principal);

      const notifications: string[] = [];

      const inspector = createImplementation(SweatpantsProtocol, function* () {
        return {
          elicit(): Stream<never, zod.infer<typeof SweatpantsProtocol.methods.elicit.output>> {
            return resource(function* (provide) {
              yield* provide({
                *next() {
                  return { done: true, value: { status: "declined" as const } };
                },
              });
            });
          },
          notify(payload): Stream<never, zod.infer<typeof SweatpantsProtocol.methods.notify.output>> {
            return resource(function* (provide) {
              notifications.push(payload.message);
              yield* provide({
                *next() {
                  return { done: true, value: { ok: true } };
                },
              });
            });
          },
          sample(): Stream<never, zod.infer<typeof SweatpantsProtocol.methods.sample.output>> {
            return resource(function* (provide) {
              yield* provide({
                *next() {
                  return { done: true, value: { text: "" } };
                },
              });
            });
          },
        };
      });

      const handle = yield* inspector.attach();
      yield* spawn(function* () {
        yield* serveProtocol(handle, operative);
      });

      yield* sleep(0);

      yield* TransportApi.decorate(yield* createCorrelatedMiddleware(principal, correlated));

      yield* sleep(0);

      const result = yield* notify({
        message: "Processing...",
        progress: 0.5,
      });

      expect(result.ok).toBe(true);
      expect(notifications).toEqual(["Processing..."]);
    });

    it("should handle sample requests via protocol", function* () {
      const [principal, operative] = yield* createTransportPair();
      const correlated = yield* createCorrelation(principal);

      const inspector = createImplementation(SweatpantsProtocol, function* () {
        return {
          elicit(): Stream<never, zod.infer<typeof SweatpantsProtocol.methods.elicit.output>> {
            return resource(function* (provide) {
              yield* provide({
                *next() {
                  return { done: true, value: { status: "declined" as const } };
                },
              });
            });
          },
          notify(): Stream<never, zod.infer<typeof SweatpantsProtocol.methods.notify.output>> {
            return resource(function* (provide) {
              yield* provide({
                *next() {
                  return { done: true, value: { ok: true } };
                },
              });
            });
          },
          sample(_payload): Stream<never, zod.infer<typeof SweatpantsProtocol.methods.sample.output>> {
            return resource(function* (provide) {
              yield* provide({
                *next() {
                  return {
                    done: true,
                    value: {
                      text: "This is the AI response",
                      model: "test-model",
                      finishReason: "stop" as const,
                    },
                  };
                },
              });
            });
          },
        };
      });

      const handle = yield* inspector.attach();
      yield* spawn(function* () {
        yield* serveProtocol(handle, operative);
      });

      yield* sleep(0);

      yield* TransportApi.decorate(yield* createCorrelatedMiddleware(principal, correlated));

      yield* sleep(0);

      const result = yield* sample({
        prompt: "Tell me a joke",
        maxTokens: 100,
      });

      expect(result.text).toBe("This is the AI response");
      expect(result.model).toBe("test-model");
      expect(result.finishReason).toBe("stop");
    });

    it("should handle declined elicit via protocol", function* () {
      const [principal, operative] = yield* createTransportPair();
      const correlated = yield* createCorrelation(principal);

      const inspector = createImplementation(SweatpantsProtocol, function* () {
        return {
          elicit(): Stream<never, zod.infer<typeof SweatpantsProtocol.methods.elicit.output>> {
            return resource(function* (provide) {
              yield* provide({
                *next() {
                  return { done: true, value: { status: "declined" as const } };
                },
              });
            });
          },
          notify(): Stream<never, zod.infer<typeof SweatpantsProtocol.methods.notify.output>> {
            return resource(function* (provide) {
              yield* provide({ *next() { return { done: true, value: { ok: true } }; } });
            });
          },
          sample(): Stream<never, zod.infer<typeof SweatpantsProtocol.methods.sample.output>> {
            return resource(function* (provide) {
              yield* provide({ *next() { return { done: true, value: { text: "" } }; } });
            });
          },
        };
      });

      const handle = yield* inspector.attach();
      yield* spawn(function* () {
        yield* serveProtocol(handle, operative);
      });

      yield* sleep(0);

      yield* TransportApi.decorate(yield* createCorrelatedMiddleware(principal, correlated));

      yield* sleep(0);

      const result = yield* elicit({
        type: "confirmation",
        message: "Confirm?",
        schema: z.boolean(),
      });

      expect(result.status).toBe("declined");
    });
  });
});
