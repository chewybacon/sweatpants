import { expect, it, onTestFinished } from "vitest";
import { createHostedActivation } from "@sweatpan.ts/hosting";
import type { Runtime } from "@sweatpan.ts/runtime";
import { createLatch, createProtocolRig } from "@sweatpan.ts/testing";
import { forEachRuntime } from "../runtime/assembly.ts";

forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  it(`${runtime.name}: readers are independent and settled presentation waits for producer cleanup`, async () => {
    const peer = createProtocolRig();
    const cleaning = createLatch<void>();
    const release = createLatch<void>();
    let cleaned = false;
    let presented = false;
    let finished = false;
    const activation = createHostedActivation(runtime, {
      *run(emit: (frame: string) => void) {
        yield* runtime.composition.ensure(function* () {
          cleaning.resolve();
          yield* runtime.fromPromise(() => release.promise);
          cleaned = true;
        });
        emit("partial");
        yield* runtime.fromPromise((signal) => peer.send({ id: "work", token: "host" }, signal));
        return "parked";
      },
      present(result) {
        expect(cleaned).toBe(true);
        presented = true;
        return [result];
      },
    });
    onTestFinished(async () => {
      release.resolve();
      await activation.cancel();
    });
    void activation.result.then(
      () => {
        finished = true;
      },
      () => {
        finished = true;
      },
    );
    await Promise.race([peer.waitForRequests(1), activation.result]);
    const reading = createLatch<void>();
    const disconnected = runtime.start(function* () {
      const reader = yield* activation.from(0);
      expect(yield* reader.next()).toEqual({ done: false, value: "partial" });
      reading.resolve();
      return yield* reader.next();
    });
    void disconnected.result.catch(() => undefined);
    onTestFinished(() => disconnected.cancel());
    await reading.promise;
    await disconnected.cancel();
    expect(peer.aborted).toEqual([]);
    const remaining = runtime.start(function* () {
      const reader = yield* activation.from(1);
      expect(yield* reader.next()).toEqual({ done: false, value: "parked" });
      expect(reader.offset).toBe(2);
      return yield* reader.next();
    });
    onTestFinished(() => remaining.cancel());
    peer.reply("work", { status: 200, body: "done" });
    await cleaning.promise;
    expect(finished).toBe(false);
    expect(presented).toBe(false);
    release.resolve();
    await expect(activation.result).resolves.toBe("parked");
    await expect(remaining.result).resolves.toEqual({ done: true, value: "parked" });
    await Promise.all([activation.cancel(), activation.cancel()]);
    expect(peer.aborted).toEqual([]);
  });

  for (const failure of ["cleanup", "presentation"] as const) {
    it(`${runtime.name}: ${failure} failure retains provisional frames without a successful stream terminal`, async () => {
      let runs = 0;
      let cleaned = false;
      let presentations = 0;
      const activation = createHostedActivation(runtime, {
        *run(emit: (frame: string) => void) {
          runs++;
          yield* runtime.composition.ensure(function* () {
            yield* runtime.fromPromise(() => Promise.resolve());
            cleaned = true;
            if (failure === "cleanup") {
              throw new Error("Cleanup failed");
            }
          });
          emit("partial");
          return "accepted";
        },
        present() {
          presentations++;
          expect(cleaned).toBe(true);
          throw new Error("Presentation failed");
        },
      });
      onTestFinished(() => activation.cancel());
      await expect(activation.result).rejects.toThrow(
        failure === "cleanup" ? "Cleanup failed" : "Presentation failed",
      );
      const reader = runtime.start(function* () {
        const stream = yield* activation.from(0);
        expect(yield* stream.next()).toEqual({ done: false, value: "partial" });
        return yield* stream.next();
      });
      onTestFinished(() => reader.cancel());
      await expect(reader.result).rejects.toBeDefined();
      expect(runs).toBe(1);
      expect(presentations).toBe(failure === "cleanup" ? 0 : 1);
      await activation.cancel();
    });
  }
});
