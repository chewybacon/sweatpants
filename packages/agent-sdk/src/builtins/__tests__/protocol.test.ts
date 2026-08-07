import { describe, it, expect } from "@effectionx/vitest";
import { spawn, sleep, resource } from "effection";
import { z } from "zod";
import { elicit, notify, sample } from "../api.ts";
import {
  SweatpantsProtocol,
  type BuiltinElicitResult,
  type BuiltinNotifyResult,
  type BuiltinSampleResult,
} from "../protocol.ts";
import { createTransportPair } from "../../transport/pair.ts";
import { createCorrelation } from "../../transport/correlation.ts";
import { TransportContext } from "../../context/transport.ts";
import { createImplementation } from "../../protocol/create.ts";
import { serveProtocol } from "../../protocol/serve.ts";
import type { Stream } from "effection";

describe("SweatpantsProtocol", () => {
  describe("with serveProtocol", () => {
    it("should handle elicit requests via protocol", function* () {
      const [principal, operative] = yield* createTransportPair();
      const correlated = yield* createCorrelation(principal);
      yield* TransportContext.set(correlated);

      // Create protocol implementation
      const inspector = createImplementation(SweatpantsProtocol, function* () {
        return {
          elicit(payload): Stream<never, BuiltinElicitResult> {
            return resource(function* (provide) {
              yield* provide({
                *next() {
                  // Simulate user accepting with a value
                  return {
                    done: true,
                    value: {
                      action: "accept" as const,
                      content: `confirmed: ${payload.message}`,
                    } as const,
                  };
                },
              });
            });
          },
          notify(_payload): Stream<never, BuiltinNotifyResult> {
            return resource(function* (provide) {
              yield* provide({
                *next() {
                  return { done: true, value: { ok: true } };
                },
              });
            });
          },
          sample(payload): Stream<never, BuiltinSampleResult> {
            return resource(function* (provide) {
              yield* provide({
                *next() {
                  const prompt =
                    typeof payload.prompt === "string"
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

      // Attach and serve the protocol
      const handle = yield* inspector.attach();
      yield* spawn(function* () {
        yield* serveProtocol(handle, operative);
      });

      yield* sleep(0);

      // Test elicit
      const elicitResult = yield* elicit({
        type: "confirmation",
        message: "Are you sure?",
        schema: z.string(),
      });

      expect(elicitResult.action).toBe("accept");
      if (elicitResult.action === "accept") {
        expect(elicitResult.content).toBe("confirmed: Are you sure?");
      }
    });

    it("should handle notify requests via protocol", function* () {
      const [principal, operative] = yield* createTransportPair();
      const correlated = yield* createCorrelation(principal);
      yield* TransportContext.set(correlated);

      const notifications: string[] = [];

      const inspector = createImplementation(SweatpantsProtocol, function* () {
        return {
          elicit(): Stream<never, BuiltinElicitResult> {
            return resource(function* (provide) {
              yield* provide({
                *next() {
                  return { done: true, value: { action: "decline" as const } };
                },
              });
            });
          },
          notify(payload): Stream<never, BuiltinNotifyResult> {
            return resource(function* (provide) {
              notifications.push(payload.message);
              yield* provide({
                *next() {
                  return { done: true, value: { ok: true } };
                },
              });
            });
          },
          sample(): Stream<never, BuiltinSampleResult> {
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
      yield* TransportContext.set(correlated);

      const inspector = createImplementation(SweatpantsProtocol, function* () {
        return {
          elicit(): Stream<never, BuiltinElicitResult> {
            return resource(function* (provide) {
              yield* provide({
                *next() {
                  return { done: true, value: { action: "decline" as const } };
                },
              });
            });
          },
          notify(): Stream<never, BuiltinNotifyResult> {
            return resource(function* (provide) {
              yield* provide({
                *next() {
                  return { done: true, value: { ok: true } };
                },
              });
            });
          },
          sample(_payload): Stream<never, BuiltinSampleResult> {
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
      yield* TransportContext.set(correlated);

      const inspector = createImplementation(SweatpantsProtocol, function* () {
        return {
          elicit(): Stream<never, BuiltinElicitResult> {
            return resource(function* (provide) {
              yield* provide({
                *next() {
                  return { done: true, value: { action: "decline" as const } };
                },
              });
            });
          },
          notify(): Stream<never, BuiltinNotifyResult> {
            return resource(function* (provide) {
              yield* provide({
                *next() {
                  return { done: true, value: { ok: true } };
                },
              });
            });
          },
          sample(): Stream<never, BuiltinSampleResult> {
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

      const result = yield* elicit({
        type: "confirmation",
        message: "Confirm?",
        schema: z.boolean(),
      });

      expect(result.action).toBe("decline");
    });
  });
});
