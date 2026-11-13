import { expect, expectTypeOf, it, onTestFinished } from "vitest";
import {
  createReadableStream,
  createSession,
  type Attempt,
  type Runtime,
  type Session,
} from "@sweatpan.ts/runtime";
import { createAgUiRun, type AgUiRunEvent } from "@sweatpan.ts/protocols-ag-ui";
import { createLatch } from "@sweatpan.ts/testing";
import { forEachRuntime } from "./assembly.ts";

type Input = { id: string };
type View = { state: string };
type End = { pending: readonly string[] };

async function readEvents<Event, Result, Y>(
  runtime: Runtime<Y>,
  attempt: Attempt<Event, Result, Y>,
  offset = 0,
) {
  return await runtime.start(function* () {
    const source = yield* attempt.events(offset);
    const events: Event[] = [];
    while (true) {
      const item = yield* source.next();
      if (item.done) {
        return events;
      }
      events.push(item.value);
    }
  }).result;
}

forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  type PublicAttempt = Attempt<AgUiRunEvent<View>, End, Y>;
  type PublicSession = Session<Input, AgUiRunEvent<View>, End, Y>;

  it(`${runtime.name}: the acquisition scope owns eager production independently of send, reader and result-waiter scopes`, async () => {
    const ready = createLatch<{ session: PublicSession; attempt: PublicAttempt }>();
    const entered = createLatch<void>();
    const finish = createLatch<void>();
    const cleaning = createLatch<void>();
    const releaseCleanup = createLatch<void>();
    const releaseOwner = createLatch<void>();
    let created = 0;
    let executions = 0;
    let cleaned = false;
    const owner = runtime.start(function* () {
      const session = yield* createSession(runtime, (input: Input) => {
        created++;
        return createAgUiRun<End, View, Y>(runtime, {
          threadId: "session",
          errorMessage: "Public failure",
          *execute(publish) {
            executions++;
            yield* runtime.composition.ensure(function* () {
              cleaning.resolve();
              yield* runtime.fromPromise(() => releaseCleanup.promise);
              cleaned = true;
            });
            publish.text("Waiting");
            entered.resolve();
            yield* runtime.fromPromise(() => finish.promise);
            publish.custom("view", { state: "waiting" });
            return { pending: [input.id] };
          },
        });
      });
      expectTypeOf(session).toEqualTypeOf<PublicSession>();
      expect(created).toBe(0);
      // Leaving the send scope must not stop work owned by the acquisition scope.
      const attempt = yield* runtime.composition.scoped(() => session.send({ id: "approval" }));
      ready.resolve({ session, attempt });
      yield* runtime.fromPromise(() => releaseOwner.promise);
    });
    void owner.result.catch(() => undefined);
    onTestFinished(async () => {
      finish.resolve();
      releaseCleanup.resolve();
      releaseOwner.resolve();
      await owner.cancel();
    });
    const { session, attempt } = await ready.promise;
    await entered.promise; // No reader has subscribed yet.
    expect(executions).toBe(1);
    const first = createReadableStream(runtime, attempt.events()).getReader();
    const second = createReadableStream(runtime, attempt.events()).getReader();
    onTestFinished(async () => {
      await first.cancel();
      await second.cancel();
    });
    expect(await first.read()).toEqual(await second.read());
    await first.cancel();
    await second.cancel();
    const waiter = runtime.start(() => attempt.result());
    void waiter.result.catch(() => undefined);
    await waiter.cancel();
    expect(cleaned).toBe(false);
    const result = runtime.start(() => attempt.result());
    let returned = false;
    void result.result.then(() => {
      returned = true;
    });
    finish.resolve();
    await cleaning.promise;
    expect(returned).toBe(false);
    releaseCleanup.resolve();
    const end = await result.result;
    expectTypeOf(end).toEqualTypeOf<End>();
    expect(end).toEqual({ pending: ["approval"] });
    expect(await runtime.start(() => attempt.result()).result).toEqual(end);
    const replay = await readEvents(runtime, attempt, 1);
    expect(replay.map((event) => event.type)).toEqual([
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "CUSTOM",
      "TEXT_MESSAGE_END",
      "RUN_FINISHED",
    ]);
    expect(created).toBe(1);
    expect(executions).toBe(1);
    expect(cleaned).toBe(true);
    releaseOwner.resolve();
    await owner.result;
    await expect(runtime.start(() => session.send({ id: "late" })).result).rejects.toThrow(
      "Session scope exited",
    );
    expect(created).toBe(1);
  });

  for (const exit of ["return", "cancel"] as const) {
    it(`${runtime.name}: session owner ${exit} stops every attempt and joins all cleanup`, async () => {
      const entered = [createLatch<void>(), createLatch<void>()];
      const cleaning = [createLatch<void>(), createLatch<void>()];
      const releaseCleanup = createLatch<void>();
      const releaseOwner = createLatch<void>();
      const ready = createLatch<PublicAttempt[]>();
      const cleaned: string[] = [];
      const owner = runtime.start(function* () {
        const session = yield* createSession(runtime, (input: Input) => {
          const index = Number(input.id);
          return createAgUiRun<End, View, Y>(runtime, {
            threadId: "shutdown",
            errorMessage: "Public stop",
            *execute() {
              yield* runtime.composition.ensure(function* () {
                cleaning[index]!.resolve();
                yield* runtime.fromPromise(() => releaseCleanup.promise);
                cleaned.push(input.id);
              });
              entered[index]!.resolve();
              return yield* runtime.fromPromise<never>(
                (signal) =>
                  new Promise((_, reject) => {
                    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
                    if (signal.aborted) {
                      reject(signal.reason);
                    }
                  }),
              );
            },
          });
        });
        const first = yield* session.send({ id: "0" });
        const second = yield* session.send({ id: "1" });
        ready.resolve([first, second]);
        yield* runtime.fromPromise(() => releaseOwner.promise);
      });
      void owner.result.catch(() => undefined);
      onTestFinished(async () => {
        releaseCleanup.resolve();
        releaseOwner.resolve();
        await owner.cancel();
      });
      const attempts = await ready.promise;
      await Promise.all(entered.map((latch) => latch.promise));
      let stopped = false;
      let stopping: Promise<unknown>;
      if (exit === "cancel") {
        stopping = owner.cancel();
      } else {
        releaseOwner.resolve();
        stopping = owner.result;
      }
      void stopping.then(() => {
        stopped = true;
      });
      // Both cancellations must start before either cleanup is allowed to finish.
      await Promise.all(cleaning.map((latch) => latch.promise));
      expect(stopped).toBe(false);
      expect(cleaned).toEqual([]);
      releaseCleanup.resolve();
      await stopping;
      expect(cleaned.sort()).toEqual(["0", "1"]);
      for (const attempt of attempts) {
        expect((await readEvents(runtime, attempt)).map((event) => event.type)).toEqual([
          "RUN_STARTED",
          "RUN_ERROR",
        ]);
      }
    });
  }

  for (const failure of ["execution", "cleanup"] as const) {
    it(`${runtime.name}: ${failure} failure remains in the host result while readers receive public errors`, async () => {
      const original = new Error("Private provider details");
      const ready = createLatch<PublicAttempt>();
      const releaseOwner = createLatch<void>();
      let dispatched = false;
      const owner = runtime.start(function* () {
        const session = yield* createSession(runtime, (_input: Input) =>
          createAgUiRun<End, View, Y>(runtime, {
            threadId: "failure",
            errorMessage: "Public failure",
            *execute() {
              dispatched = true;
              if (failure === "cleanup") {
                yield* runtime.composition.ensure(function* () {
                  throw original;
                });
                return { pending: [] };
              }
              throw original;
            },
          }),
        );
        ready.resolve(yield* session.send({ id: "answer" }));
        yield* runtime.fromPromise(() => releaseOwner.promise);
      });
      void owner.result.catch(() => undefined);
      onTestFinished(async () => {
        releaseOwner.resolve();
        await owner.cancel();
      });
      const attempt = await ready.promise;
      await expect(runtime.start(() => attempt.result()).result).rejects.toThrow(
        "Private provider details",
      );
      expect(dispatched).toBe(true);
      const events = await readEvents(runtime, attempt);
      expect(events.map((event) => event.type)).toEqual(["RUN_STARTED", "RUN_ERROR"]);
      expect(events.at(-1)).toEqual({ type: "RUN_ERROR", message: "Public failure" });
      expect(JSON.stringify(events)).not.toContain("Private provider");
      releaseOwner.resolve();
      await owner.result;
    });
  }
});
