import { expect, it, onTestFinished } from "vitest";
import type { Runtime } from "@sweatpan.ts/runtime";
import { createProtocolRig } from "@sweatpan.ts/testing";
import { forEachRuntime } from "./assembly.ts";

forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  for (const cancel of [false, true]) {
    it(`${runtime.name}: error recovery crosses scoped APIs and preserves interruption (${cancel})`, async () => {
      const peer = createProtocolRig();
      const failure = new Error("Provider failed");
      let released = false;
      let recovered = false;
      const api = runtime.composition.createApi("fallible-call", {
        *read() {
          yield* runtime.fromPromise((signal) => peer.send({ id: "read", token: "ready" }, signal));
          throw failure;
        },
      });
      const task = runtime.start(() =>
        runtime.composition.catchError(
          () =>
            runtime.composition.scoped(function* () {
              yield* runtime.composition.ensure(function* () {
                released = true;
              });
              return yield* api.operations.read();
            }),
          function* (error) {
            expect(released).toBe(true);
            expect(error).toBe(failure);
            recovered = true;
            return "recovered";
          },
        ),
      );
      void task.result.catch(() => undefined);
      onTestFinished(() => task.cancel());
      await Promise.race([peer.waitForRequests(1), task.result]);
      if (cancel) {
        await task.cancel();
        expect(recovered).toBe(false);
      } else {
        peer.reply("read", { status: 200, body: "finish" });
        await expect(task.result).resolves.toBe("recovered");
        expect(recovered).toBe(true);
      }
      expect(released).toBe(true);
    });
  }
});
