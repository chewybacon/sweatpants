import { isDeepStrictEqual } from "node:util";
import { expect, expectTypeOf, it, onTestFinished } from "vitest";
import { z } from "zod";
import type { Operation, Work } from "@standard-durability/core";
import { defineEffect, type CapabilityRequest } from "@sweatpan.ts/core";
import type { OwnedChild, ResolutionGrant } from "@sweatpan.ts/durable";
import { createScopedGuest } from "@sweatpan.ts/execution";
import {
  createEffectCapabilities,
  createHosting,
  installEffectAnswers,
  installGuestRetention,
} from "@sweatpan.ts/hosting";
import type { ModelProvider } from "@sweatpan.ts/providers";
import { createBufferedSignal, type BufferedSignal, type Runtime } from "@sweatpan.ts/runtime";
import { createToolAcquisition, defineTool } from "@sweatpan.ts/tools";
import {
  createHostedRecovery,
  createSqliteJournalRig,
  createProtocolRig,
  createLatch,
  readJournal,
} from "@sweatpan.ts/testing";
import { forEachRuntime } from "../runtime/assembly.ts";

// Provisional chat vocabulary: promote only after real provider adapters establish it.
const message = z.discriminatedUnion("role", [
  z.object({ role: z.literal("user"), text: z.string() }),
  z.object({
    role: z.literal("assistant"),
    text: z.string(),
    call: z.object({ id: z.string(), name: z.literal("confirm"), input: z.string() }).optional(),
  }),
  z.object({ role: z.literal("tool"), callId: z.string(), result: z.boolean() }),
]);
const requestSchema = z.object({ model: z.string(), messages: z.array(message) });
const responseSchema = z.object({
  text: z.string(),
  call: z.object({ id: z.string(), name: z.literal("confirm"), input: z.string() }).optional(),
});
type Request = z.infer<typeof requestSchema>;
type Response = z.infer<typeof responseSchema>;
type Event = { type: "text"; text: string };
type Output = Event | { type: "elicit"; grant: ResolutionGrant };
type OutputFrame = { value: Output; after: number };
const sample = defineEffect({
  key: "chat.model",
  context: requestSchema,
  response: responseSchema,
});
const approval = defineEffect({
  key: "confirm.approval",
  context: z.string(),
  response: z.boolean(),
});
const confirm = defineTool("confirm")
  .parameters(z.string())
  .elicits({ approval })
  .execute(function* (question, ctx) {
    const answer = yield* ctx.elicit("approval", question);
    if (!answer.ok) {
      throw new Error("Approval failed");
    }
    return answer.value;
  });

forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  it(`${runtime.name}: host drains a model independently of disconnected readers, parks and resumes with accepted history`, async () => {
    const requests: Request[] = [];
    const events: Event[] = [];
    const peer = createProtocolRig();
    let released = 0;
    let intercepted = 0;
    type Provider = ModelProvider<Request, Event, Response, Y>;
    const provider = runtime.composition.createApi<Provider>("chat-model", {
      *stream() {
        throw new Error("Model provider not installed");
      },
    });
    const store = createSqliteJournalRig<string, CapabilityRequest, unknown, string, unknown, Y>({
      program: "chat-tracer",
      equals: isDeepStrictEqual,
    });
    onTestFinished(() => store.close());
    function start<T>(work: Work<T, Y>) {
      const task = runtime.start(work);
      void task.result.catch(() => undefined);
      onTestFinished(() => task.cancel());
      return task.result;
    }
    type Child = OwnedChild<boolean, CapabilityRequest, unknown, string, unknown, Y>;
    function assemble() {
      const journal = store.open();
      const effects = createEffectCapabilities(runtime, "chat-effects");
      const root = effects.grant({ sample, confirm });
      const acquisition = createToolAcquisition(runtime, effects, confirm, "confirm-acquisition");
      let waiting: { child: Child; grant: ResolutionGrant } | undefined;
      function childHost(child: Child) {
        const recovery = createHostedRecovery<boolean, CapabilityRequest, Y, unknown, string>(
          runtime,
          {
            name: "confirm-recovery",
            program: confirm.id,
            matches: isDeepStrictEqual,
            acquire() {
              return acquisition.operations.acquire(z.string().parse(child.link.input));
            },
          },
        );
        const host = createHosting(runtime.composition, {
          name: "confirm-host",
          journal: child.journal,
          recovery: recovery.operations,
          attempts: child.journal.attempts,
          interactions: child.journal.interactions,
          handle: acquisition.handle,
        });
        return { host, recovery };
      }
      function* runChild(child: Child): Operation<boolean, Y> {
        const { host, recovery } = childHost(child);
        yield* installGuestRetention(runtime.composition, host, recovery, child.journal);
        yield* host.around(acquisition.admission);
        yield* host.around({
          *deliveryMode() {
            return "wait" as const;
          },
        });
        const result = yield* host.operations.run();
        if (result.state === "waiting") {
          waiting = { child, grant: result.grant };
        }
        return result.state === "completed";
      }
      return {
        snapshot() {
          return start(() => readJournal(journal));
        },
        run(
          output: BufferedSignal<Output, string, Y> = createBufferedSignal<Output, string, Y>(
            runtime,
          ),
        ) {
          // The Host owns this execution. Client subscriptions run in separate scopes.
          return start(function* () {
            yield* provider.install({
              *stream(request) {
                requests.push(structuredClone(request));
                yield* runtime.composition.ensure(function* () {
                  released++;
                });
                const source = runtime.createSignal<Event, Response>();
                const subscription = yield* source;
                if (request.messages.length === 1) {
                  source.send({ type: "text", text: "Let me" });
                  let first = true;
                  let finished = false;
                  return {
                    *next() {
                      if (first) {
                        first = false;
                        return yield* subscription.next();
                      }
                      if (!finished) {
                        // The engine's advancement is still pending after live output is readable.
                        yield* runtime.fromPromise((signal) =>
                          peer.send({ id: "first-model", token: "finish" }, signal),
                        );
                        finished = true;
                        source.send({ type: "text", text: " ask" });
                        source.send({ type: "text", text: "." });
                        source.close({
                          text: "Let me ask.",
                          call: { id: "call-1", name: "confirm", input: "Proceed?" },
                        });
                      }
                      return yield* subscription.next();
                    },
                  };
                } else {
                  expect(request.messages.at(-1)).toEqual({
                    role: "tool",
                    callId: "call-1",
                    result: true,
                  });
                  source.send({ type: "text", text: "Confirmed." });
                  source.close({ text: "Confirmed." });
                }
                return subscription;
              },
            });
            yield* provider.around({
              *stream([request], next) {
                intercepted++;
                return yield* next(request);
              },
            });
            yield* effects.install(sample, function* (request) {
              return yield* runtime.composition.scoped(function* () {
                const subscription = yield* provider.operations.stream(request);
                while (true) {
                  const next = yield* subscription.next();
                  if (next.done) {
                    return { ok: true as const, value: next.value };
                  }
                  events.push(next.value);
                  output.send(next.value);
                }
              });
            });
            const recovery = createHostedRecovery<string, CapabilityRequest, Y, unknown, string>(
              runtime,
              {
                name: "chat-recovery",
                program: "chat-tracer",
                matches: isDeepStrictEqual,
                *acquire() {
                  return createScopedGuest(function* () {
                    const messages: Request["messages"] = [
                      { role: "user", text: "Ask before proceeding." },
                    ];
                    const first = yield* root.capabilities.sample({ model: "scripted", messages });
                    if (!first.ok || !first.value.call) {
                      throw new Error("Expected tool call");
                    }
                    const call = first.value.call;
                    messages.push({ role: "assistant", ...first.value });
                    const result = yield* root.capabilities.confirm(call.input);
                    if (!result.ok) {
                      throw new Error("Tool failed");
                    }
                    messages.push({ role: "tool", callId: call.id, result: result.value });
                    const final = yield* root.capabilities.sample({ model: "scripted", messages });
                    if (!final.ok) {
                      throw new Error("Model failed");
                    }
                    return final.value.text;
                  });
                },
              },
            );
            const host = createHosting(runtime.composition, {
              name: "chat-host",
              journal,
              recovery: recovery.operations,
              attempts: journal.attempts,
              handle: root.handle,
            });
            yield* host.around(root.admission);
            yield* host.around({
              *child([pending], next) {
                if (pending.request.effect !== confirm.id) {
                  return yield* next(pending);
                }
                const child = yield* journal.ensureChild<
                  boolean,
                  CapabilityRequest,
                  unknown,
                  string
                >(pending.id, {
                  program: confirm.id,
                  input: z.string().parse(pending.request.input),
                  outcome(value) {
                    return { ok: true, value: { ok: true, value } };
                  },
                });
                return { id: child.link.childId, run: () => runChild(child) };
              },
            });
            return yield* host.operations.run();
          }).then(
            (result) => {
              // Publish settled presentation only after the activation's physical cleanup joins.
              if (waiting) {
                output.send({ type: "elicit", grant: waiting.grant });
              }
              output.close(result.state);
              return result;
            },
            (error: unknown) => {
              output.fail(error);
              throw error;
            },
          );
        },
        answer(value: unknown) {
          return start(function* () {
            if (!waiting) {
              throw new Error("Not waiting");
            }
            const ingress = yield* installEffectAnswers(
              childHost(waiting.child).host,
              effects.grant(confirm.elicits),
              waiting.child.journal.interactions,
            );
            return yield* ingress.answer(waiting.grant, { ok: true, value });
          });
        },
      };
    }
    let app = assemble();
    const output = createBufferedSignal<Output, string, Y>(runtime);
    // Ordinary scoped API: source selection is context, compaction is reader policy.
    const Source =
      runtime.composition.createContext<BufferedSignal<Output, string, Y>>("chat-output");
    const reads = runtime.composition.createApi("chat-output-reads", {
      *subscribe({ after }: { after: number }) {
        const source = yield* Source.expect();
        const reader = yield* source.from(after, (previous, following) =>
          previous.type === "text" && following.type === "text"
            ? { type: "text", text: previous.text + following.text }
            : undefined,
        );
        return {
          *next(): Operation<IteratorResult<OutputFrame, string>, Y> {
            const item = yield* reader.next();
            if (item.done) {
              return item;
            }
            // Capture the source cursor with this frame before another read can advance it.
            return { done: false, value: { value: item.value, after: reader.offset } };
          },
        };
      },
    });
    const subscriptions: number[] = [];
    function* installOutput() {
      yield* Source.set(output);
      yield* reads.around({
        *subscribe([options], next) {
          subscriptions.push(options.after);
          return yield* next(options);
        },
      });
    }
    let after = 0;
    let settled = false;
    const producing = app.run(output).finally(() => {
      settled = true;
    });
    await Promise.race([peer.waitForRequests(1), producing]);
    // A slow reader sees the first token while the producer still waits for model completion.
    const readerReady = createLatch<void>();
    const client = runtime.start(function* () {
      yield* installOutput();
      const reader = yield* reads.operations.subscribe({ after });
      const first = yield* reader.next();
      expect(first).toEqual({
        done: false,
        value: { value: { type: "text", text: "Let me" }, after: 1 },
      });
      if (first.done) {
        throw new Error("Expected first output frame");
      }
      expectTypeOf(first.value.after).toEqualTypeOf<number>();
      after = first.value.after;
      readerReady.resolve();
      return yield* reader.next();
    });
    void client.result.catch(() => undefined);
    onTestFinished(() => client.cancel());
    await Promise.race([readerReady.promise, client.result, producing]);
    expect(settled).toBe(false);
    expect(released).toBe(0);
    expect((await app.snapshot()).history).toEqual([]);
    await client.cancel();
    expect(peer.aborted).toEqual([]); // Disconnect is not model cancellation.
    peer.reply("first-model", { status: 200, body: "done" });
    const parked = await producing;
    expect(parked.state).toBe("child");
    // No reader was present for the remaining model output or the parked presentation.
    const retained = await start(function* () {
      yield* installOutput();
      const reader = yield* reads.operations.subscribe({ after });
      const remaining: OutputFrame[] = [];
      while (true) {
        const next = yield* reader.next();
        if (next.done) {
          expect(next.value).toBe("child");
          return remaining;
        }
        remaining.push(next.value);
      }
    });
    expect(retained).toEqual([
      { value: { type: "text", text: " ask." }, after: 3 },
      { value: { type: "elicit", grant: expect.any(Object) }, after: 4 },
    ]);
    // Earlier queued frames retain their own cursors after later reads.
    expect(structuredClone(retained[0])).toEqual({
      value: { type: "text", text: " ask." },
      after: 3,
    });
    expect(subscriptions).toEqual([0, 1]);
    // Source and middleware installation belonged to each client scope, not the API facade.
    await expect(start(() => reads.operations.subscribe({ after: 0 }))).rejects.toThrow(
      "chat-output",
    );
    expect(subscriptions).toEqual([0, 1]);
    expect(peer.requests).toHaveLength(1);
    expect(requests).toHaveLength(1);
    expect(released).toBe(1);
    expect(events).toEqual([
      { type: "text", text: "Let me" },
      { type: "text", text: " ask" },
      { type: "text", text: "." },
    ]);
    store.reopen();
    app = assemble();
    await expect(app.run()).resolves.toEqual(parked);
    expect(requests).toHaveLength(1);
    await expect(app.answer("yes")).rejects.toThrow("Effect schema rejected value");
    expect((await app.answer(true)).duplicate).toBe(false);
    expect((await app.answer(true)).duplicate).toBe(true);
    store.reopen();
    app = assemble();
    const completed = { state: "completed", value: "Confirmed." };
    await expect(app.run()).resolves.toEqual(completed);
    expect(requests).toHaveLength(2);
    expect({ released, intercepted }).toEqual({ released: 2, intercepted: 2 });
    expect(events).toEqual([
      { type: "text", text: "Let me" },
      { type: "text", text: " ask" },
      { type: "text", text: "." },
      { type: "text", text: "Confirmed." },
    ]);
    store.reopen();
    await expect(assemble().run()).resolves.toEqual(completed);
    expect(requests).toHaveLength(2);
  });
});

forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  for (const mode of ["failure", "cancel"] as const) {
    it(`${runtime.name}: ${mode} after partial model output releases the provider without accepting a response`, async () => {
      const peer = createProtocolRig();
      const events: Event[] = [];
      const output = createBufferedSignal<Event, string, Y>(runtime);
      let released = false;
      const store = createSqliteJournalRig<string, CapabilityRequest, unknown, string, unknown, Y>({
        program: "model-failure",
        equals: isDeepStrictEqual,
      });
      onTestFinished(() => store.close());
      const journal = store.open();
      const task = runtime.start(function* () {
        const effects = createEffectCapabilities(runtime, "failure-effects");
        const grant = effects.grant({ sample });
        const provider = runtime.composition.createApi<ModelProvider<Request, Event, Response, Y>>(
          "failing-model",
          {
            *stream() {
              yield* runtime.composition.ensure(function* () {
                // An asynchronous barrier proves cleanup is joined, not merely initiated.
                yield* runtime.fromPromise(() => Promise.resolve());
                released = true;
              });
              const source = runtime.createSignal<Event, Response>();
              const subscription = yield* source;
              source.send({ type: "text", text: "Unfinished" });
              let first = true;
              return {
                *next() {
                  if (first) {
                    first = false;
                    return yield* subscription.next();
                  }
                  yield* runtime.fromPromise((signal) =>
                    peer.send({ id: "model", token: "inference" }, signal),
                  );
                  throw new Error("Unexpected provider completion");
                },
              };
            },
          },
        );
        yield* effects.install(sample, function* (request) {
          return yield* runtime.composition.scoped(function* () {
            const subscription = yield* provider.operations.stream(request);
            while (true) {
              const next = yield* subscription.next();
              if (next.done) {
                return { ok: true as const, value: next.value };
              }
              events.push(next.value);
              output.send(next.value);
            }
          });
        });
        const recovery = createHostedRecovery<string, CapabilityRequest, Y, unknown, string>(
          runtime,
          {
            name: "failure-recovery",
            program: "model-failure",
            matches: isDeepStrictEqual,
            *acquire() {
              return createScopedGuest(function* () {
                const result = yield* grant.capabilities.sample({
                  model: "scripted",
                  messages: [],
                });
                if (!result.ok) {
                  throw new Error("Model failure");
                }
                return result.value.text;
              });
            },
          },
        );
        const host = createHosting(runtime.composition, {
          name: "failure-host",
          journal,
          recovery: recovery.operations,
          attempts: journal.attempts,
          handle: grant.handle,
        });
        yield* host.around(grant.admission);
        return yield* host.operations.run();
      });
      const delivered = task.result.then(
        () => output.close("completed"),
        (error: unknown) => output.fail(error),
      );
      onTestFinished(() => task.cancel());
      await Promise.race([peer.waitForRequests(1), task.result]);
      expect(events).toEqual([{ type: "text", text: "Unfinished" }]);
      if (mode === "failure") {
        peer.fail("model", new Error("Provider disconnected"));
        await expect(task.result).rejects.toThrow("Provider disconnected");
      } else {
        await task.cancel();
        expect(peer.aborted).toEqual(["model"]);
      }
      expect(released).toBe(true);
      await delivered;
      const lateReader = runtime.start(function* () {
        const reader = yield* output;
        expect(yield* reader.next()).toEqual({
          done: false,
          value: { type: "text", text: "Unfinished" },
        });
        return yield* reader.next();
      });
      onTestFinished(() => lateReader.cancel());
      await expect(lateReader.result).rejects.toBeDefined();
      const inspect = runtime.start(() => readJournal(journal));
      onTestFinished(() => inspect.cancel());
      const state = await inspect.result;
      expect(state.history).toEqual([]);
      expect(state.status).toBe("running");
    });
  }
});
