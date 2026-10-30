import { it, expect, onTestFinished } from "vitest";
import { createLocalTransport } from "@sweatpan.ts/connection";
import {
  createTransportRig,
  createDuplexExchangeRig,
  acquireConnections,
} from "@sweatpan.ts/testing";
import type { Runtime } from "@sweatpan.ts/runtime";
import type { Work } from "@standard-durability/core";
import { forEachRuntime } from "./assembly.ts";

forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  for (const transportKind of ["local", "message-channel"] as const) {
    function start<T>(work: Work<T, Y>) {
      const task = runtime.start(work);
      void task.result.catch(() => undefined);
      onTestFinished(() => task.cancel());
      return task;
    }
    function transport() {
      const rig = createTransportRig(transportKind);
      onTestFinished(() => rig.close());
      return rig;
    }
    it(`${runtime.name} ${transportKind}: connection dispatch composes with scoped APIs and reverse exchanges`, async () => {
      const rig = transport();
      const labels = runtime.composition.createContext<string>("peer-label");
      const calls: string[] = [];
      const result = await start(function* () {
        const [left, right] = yield* acquireConnections(runtime, rig);
        const api = runtime.composition.createApi("peer-handler", {
          *handle(request: string) {
            const label = yield* labels.expect();
            if (request === "invoke") {
              return `${label}:${yield* right.exchange("question")}`;
            }
            return `${label}:${request}`;
          },
        });
        yield* api.around({
          *handle(args, next) {
            calls.push(`${yield* labels.expect()}:${args[0]}`);
            return yield* next(...args);
          },
        });
        return yield* runtime.all([
          function* () {
            return String(yield* left.exchange("invoke"));
          },
          function* () {
            yield* labels.set("host");
            const request = yield* right.receive();
            if (typeof request.value !== "string") {
              throw new Error("Expected string request");
            }
            const reply = yield* api.operations.handle(request.value);
            yield* request.respond(reply);
            return "host done";
          },
          function* () {
            yield* labels.set("caller");
            const request = yield* left.receive();
            if (typeof request.value !== "string") {
              throw new Error("Expected string request");
            }
            const reply = yield* api.operations.handle(request.value);
            yield* request.respond(reply);
            return "caller done";
          },
        ]);
      }).result;
      expect(result).toEqual(["host:caller:question", "host done", "caller done"]);
      expect(calls).toEqual(["host:invoke", "caller:question"]);
    });

    it(`${runtime.name} ${transportKind}: delivery errors are replies and a request can only be answered once`, async () => {
      const rig = transport();
      await start(function* () {
        const [left, right] = yield* acquireConnections(runtime, rig);
        yield* runtime.all([
          function* () {
            const diagnostic = yield* runtime.composition.catchError(
              () => left.exchange("first"),
              function* (error) {
                return String(error);
              },
            );
            expect(diagnostic).toContain("delivery failed");
            expect(yield* left.exchange("second")).toEqual({
              ok: false,
              error: { code: "declined" },
            });
          },
          function* () {
            const first = yield* right.receive();
            yield* first.reject("delivery failed");
            const duplicate = yield* runtime.composition.catchError(
              () => first.respond("duplicate"),
              function* (error) {
                return String(error);
              },
            );
            expect(duplicate).toContain("already answered");
            const second = yield* right.receive();
            yield* second.respond({ ok: false, error: { code: "declined" } });
          },
        ]);
      }).result;
    });

    it(`${runtime.name} ${transportKind}: retained transport failure rejects pending exchanges in both directions`, async () => {
      const rig = transport();
      await start(function* () {
        const [left, right] = yield* acquireConnections(runtime, rig);
        yield* runtime.all([
          function* () {
            const result = yield* runtime.composition.catchError(
              () => left.exchange("left"),
              function* (error) {
                return error;
              },
            );
            expect(result).toEqual(new Error("disconnected"));
          },
          function* () {
            const result = yield* runtime.composition.catchError(
              () => right.exchange("right"),
              function* (error) {
                return error;
              },
            );
            expect(result).toEqual(new Error("disconnected"));
          },
          function* () {
            yield* left.receive();
            yield* right.receive();
            rig.fail(new Error("disconnected"));
          },
        ]);
        expect(left.failure.aborted).toBe(true);
        expect(right.failure.aborted).toBe(true);
      }).result;
    });
  }

  it(`${runtime.name}: nested reverse handlers can overlap requests in both directions`, async () => {
    const rig = createDuplexExchangeRig<string, string, string, string, Y>(runtime, {
      async left(request): Promise<string> {
        expect(request).toBe("question");
        const answer = await rig.left.exchange("nested");
        return `answer:${answer}`;
      },
      async right(request): Promise<string> {
        if (request === "invoke") {
          return rig.right.exchange("question");
        }
        expect(rig.left.pending).toBe(2);
        expect(rig.right.pending).toBe(1);
        return "nested result";
      },
    });
    onTestFinished(() => rig.close());
    expect(await rig.left.exchange("invoke")).toBe("answer:nested result");
  });
});

it("local transport buffers before start and delivers detached bytes asynchronously", async () => {
  const [left, right] = createLocalTransport();
  onTestFinished(() => {
    left.close();
    right.close();
  });
  const bytes = new Uint8Array([1, 2]);
  // Sending before peer acquisition must not lose the message.
  // eslint-disable-next-line unicorn/require-post-message-target-origin -- Local byte port, not Window.
  left.postMessage(bytes);
  bytes[0] = 9;
  left.close();
  let delivered = false;
  const received = new Promise<unknown>((resolve) => {
    right.addEventListener("message", (event) => {
      delivered = true;
      resolve(event);
    });
  });
  await Promise.resolve();
  expect(delivered).toBe(false);
  right.start();
  expect(delivered).toBe(false);
  expect(await received).toEqual({ data: new Uint8Array([1, 2]) });
  // eslint-disable-next-line unicorn/require-post-message-target-origin -- Local byte port, not Window.
  expect(() => left.postMessage(bytes)).toThrow("Local transport closed");
});
