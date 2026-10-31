import { isDeepStrictEqual } from "node:util";
import { expect, expectTypeOf, it, onTestFinished } from "vitest";
import { z } from "zod";
import type { Operation, Work } from "@standard-durability/core";
import {
  prepareChatInference,
  type ChatInference,
  type ChatHistoryMessage,
  type ModelSelection,
} from "@sweatpan.ts/chat";
import { defineEffect, type CapabilityRequest } from "@sweatpan.ts/core";
import type { OwnedChild, ResolutionGrant } from "@sweatpan.ts/durable";
import { createScopedGuest } from "@sweatpan.ts/execution";
import {
  createEffectCapabilities,
  createHosting,
  installEffectAnswers,
  installGuestRetention,
} from "@sweatpan.ts/hosting";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type {
  ModelInfo,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
} from "@sweatpan.ts/providers";
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

// Canonical v1 vocabulary. These are tracer validation schemas, not a provider wire decoder.
const contentSource = z.discriminatedUnion("type", [
  z.object({ type: z.literal("data"), value: z.string(), mimeType: z.string() }),
  z.object({ type: z.literal("url"), value: z.string(), mimeType: z.string().optional() }),
]);
const contentPart = z.union([
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.enum(["image", "audio", "video", "document"]),
    source: contentSource,
    metadata: z.record(z.string(), z.json()).nullable(),
  }),
]);
const content = z.union([z.string(), z.array(contentPart)]);
const toolCall = z.object({
  id: z.string(),
  name: z.string(),
  input: z.json(),
  thoughtSignature: z.string().nullable(),
});
const assistant = z.object({
  role: z.literal("assistant"),
  content: z.array(
    z.union([
      contentPart,
      z.object({ type: z.literal("tool-call"), toolCall }),
      z.object({
        type: z.literal("reasoning"),
        text: z.string(),
        format: z.string().nullable(),
        signature: z.string().nullable(),
        redacted: z.boolean(),
      }),
    ]),
  ),
});
const message = z.union([
  z.object({ role: z.literal("user"), content }),
  assistant,
  z.object({ role: z.enum(["system", "developer"]), content: z.string() }),
  z.object({
    role: z.literal("tool"),
    toolCallId: z.string(),
    name: z.string(),
    content,
    isError: z.boolean(),
  }),
]);
const requestDataSchema = z.object({
  context: z.object({
    messages: z.array(message),
    tools: z.array(
      z.object({
        name: z.string(),
        description: z.string().nullable(),
        parameters: z.record(z.string(), z.json()),
      }),
    ),
  }),
  options: z
    .object({
      toolChoice: z.enum(["auto", "none", "required"]).optional(),
      maxTokens: z.number().optional(),
      temperature: z.number().optional(),
      topP: z.number().optional(),
      topK: z.number().optional(),
      thinking: z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]).optional(),
      responseFormat: z
        .object({
          type: z.literal("json_schema"),
          name: z.string().optional(),
          schema: z.record(z.string(), z.json()),
        })
        .optional(),
    })
    .optional(),
});
const requestSchema: StandardSchemaV1<ModelRequest> = requestDataSchema;
const cost = z.object({
  input: z.number().nullable(),
  output: z.number().nullable(),
  cacheRead: z.number().nullable(),
  cacheWrite: z.number().nullable(),
  total: z.number().nullable(),
});
const responseSchema: StandardSchemaV1<ModelResponse> = z.object({
  message: assistant,
  source: z
    .object({
      api: z.string(),
      provider: z.string(),
      model: z.string(),
      responseModel: z.string().nullable(),
    })
    .nullable(),
  usage: z
    .object({
      input: z.number().nullable(),
      output: z.number().nullable(),
      total: z.number().nullable(),
      cacheRead: z.number().nullable(),
      cacheWrite: z.number().nullable(),
      reasoning: z.number().nullable().optional(),
      cacheWrite1h: z.number().nullable().optional(),
      cost: cost.nullable(),
    })
    .nullable(),
  stopReason: z.string().nullable(),
  responseId: z.string().nullable(),
  errorMessage: z.string().nullable(),
  reasoning: z
    .object({
      requested: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).nullable(),
      provider: z.string().nullable(),
    })
    .optional(),
});
type Request = ModelRequest;
type Response = ModelResponse;
type Event = ModelStreamEvent;
type Output = Event | { type: "elicit"; grant: ResolutionGrant };
type OutputFrame = { value: Output; after: number };
function textEvent(delta: string, text = delta): Event {
  return {
    type: "text-delta",
    contentIndex: 0,
    delta,
    partial: { role: "assistant", content: [{ type: "text", text }] },
  };
}
function response(text: string, call = false): Response {
  return {
    message: {
      role: "assistant",
      content: [
        { type: "text", text },
        {
          type: "reasoning",
          text: "",
          format: "opaque",
          signature: "retained-signature",
          redacted: true,
        },
        ...(call
          ? [
              {
                type: "tool-call" as const,
                toolCall: {
                  id: "call-1",
                  name: "confirm",
                  input: "Proceed?",
                  thoughtSignature: null,
                },
              },
            ]
          : []),
      ],
    },
    source: {
      api: "scripted",
      provider: "test",
      model: call ? "planner" : "responder",
      responseModel: null,
    },
    usage: {
      input: 10,
      output: 5,
      total: 15,
      cacheRead: null,
      cacheWrite: null,
      reasoning: 3,
      cacheWrite1h: null,
      cost: null,
    },
    reasoning: { requested: "high", provider: "deep" },
    stopReason: call ? "toolUse" : "stop",
    responseId: call ? "response-1" : "response-2",
    errorMessage: null,
  };
}
const sample = defineEffect({
  key: "chat.model",
  context: requestSchema,
  response: responseSchema,
});
const selectedRequestSchema: StandardSchemaV1<ChatInference> = z.object({
  model: z.object({ id: z.string(), provider: z.string(), api: z.string() }),
  request: requestDataSchema,
});
const selectedSample = defineEffect({
  key: "chat.selected-model",
  context: selectedRequestSchema,
  response: responseSchema,
});
const planner: ModelInfo = {
  id: "planner",
  provider: "test",
  api: "scripted",
  name: "Planner",
  input: ["text"],
  output: ["text"],
  contextWindow: 8192,
  maxOutputTokens: 1024,
  reasoningLevels: ["off", "high"],
};
const responder: ModelInfo = { ...planner, id: "responder", name: "Responder" };
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
    const selections: ModelSelection[] = [];
    let plannerAvailable = true;
    const events: Event[] = [];
    const peer = createProtocolRig();
    let released = 0;
    let intercepted = 0;
    type Provider = ModelProvider<Y, ChatInference>;
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
      const root = effects.grant({ sample: selectedSample, confirm });
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
              *stream(inference) {
                const request = inference.request;
                const target = inference.model;
                expect(target.provider).toBe("test");
                expect(target.api).toBe("scripted");
                if (target.id === planner.id && !plannerAvailable) {
                  throw new Error("Original model is unavailable");
                }
                expect(target.id).toBe(
                  request.context.messages.length === 1 ? planner.id : responder.id,
                );
                selections.push(structuredClone(target));
                requests.push(structuredClone(request));
                yield* runtime.composition.ensure(function* () {
                  released++;
                });
                const source = runtime.createSignal<Event, Response>();
                const subscription = yield* source;
                if (request.context.messages.length === 1) {
                  source.send(textEvent("Let me"));
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
                        source.send(textEvent(" ask", "Let me ask"));
                        source.send(textEvent(".", "Let me ask."));
                        source.close(response("Let me ask.", true));
                      }
                      return yield* subscription.next();
                    },
                  };
                } else {
                  expect(request.context.messages[1]).toEqual({
                    role: "assistant",
                    content: response("Let me ask.", true).message.content.filter(
                      (part) => part.type !== "reasoning",
                    ),
                  });
                  expect(request.context.tools).toEqual([
                    {
                      name: "confirm",
                      description: "Ask for approval",
                      parameters: { type: "string" },
                    },
                  ]);
                  expect(request.context.messages.at(-1)).toEqual({
                    role: "tool",
                    toolCallId: "call-1",
                    name: "confirm",
                    content: "true",
                    isError: false,
                  });
                  source.send(textEvent("Confirmed."));
                  source.close(response("Confirmed."));
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
            yield* effects.install(selectedSample, function* (request) {
              return yield* runtime.composition.scoped(function* () {
                const subscription = yield* provider.operations.stream(request);
                while (true) {
                  const next = yield* subscription.next();
                  if (next.done) {
                    if (next.value.errorMessage) {
                      throw new Error(next.value.errorMessage);
                    }
                    return { ok: true as const, value: next.value };
                  }
                  if (next.value.type === "error") {
                    throw new Error("Provider error event");
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
                    const messages: ChatHistoryMessage[] = [
                      { role: "user", content: "Ask before proceeding." },
                    ];
                    const tools = [
                      {
                        name: "confirm",
                        description: "Ask for approval",
                        parameters: { type: "string" },
                      },
                    ];
                    const first = yield* root.capabilities.sample(
                      prepareChatInference({ model: planner, history: messages, tools }),
                    );
                    if (!first.ok || first.value.errorMessage) {
                      throw new Error("Model failed");
                    }
                    const part = first.value.message.content.find(
                      (part) => part.type === "tool-call",
                    );
                    if (!part || part.type !== "tool-call" || part.toolCall.name !== "confirm") {
                      throw new Error("Expected tool call");
                    }
                    const call = part.toolCall;
                    messages.push({
                      ...first.value.message,
                      model: { id: planner.id, provider: planner.provider, api: planner.api },
                    });
                    const result = yield* root.capabilities.confirm(z.string().parse(call.input));
                    if (!result.ok) {
                      throw new Error("Tool failed");
                    }
                    messages.push({
                      role: "tool",
                      toolCallId: call.id,
                      name: call.name,
                      content: JSON.stringify(result.value),
                      isError: false,
                    });
                    const final = yield* root.capabilities.sample(
                      prepareChatInference({
                        model: responder,
                        history: messages,
                        tools,
                        foreignReasoning: "omit",
                      }),
                    );
                    if (!final.ok) {
                      throw new Error("Model failed");
                    }
                    return final.value.message.content
                      .filter((part) => part.type === "text")
                      .map((part) => part.text)
                      .join("");
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
          previous.type === "text-delta" &&
          following.type === "text-delta" &&
          previous.contentIndex === following.contentIndex
            ? { ...following, delta: previous.delta + following.delta }
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
        value: { value: textEvent("Let me"), after: 1 },
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
    expect((await app.snapshot()).history[0]?.request).toMatchObject({
      input: {
        model: { id: "planner", provider: "test", api: "scripted" },
        request: { context: { messages: [{ role: "user", content: "Ask before proceeding." }] } },
      },
    });
    expect((await app.snapshot()).history[0]?.outcome).toEqual({
      ok: true,
      value: { ok: true, value: response("Let me ask.", true) },
    });
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
      { value: textEvent(" ask.", "Let me ask."), after: 3 },
      { value: { type: "elicit", grant: expect.any(Object) }, after: 4 },
    ]);
    // Earlier queued frames retain their own cursors after later reads.
    expect(structuredClone(retained[0])).toEqual({
      value: textEvent(" ask.", "Let me ask."),
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
      textEvent("Let me"),
      textEvent(" ask", "Let me ask"),
      textEvent(".", "Let me ask."),
    ]);
    plannerAvailable = false; // Recovery must not resolve or invoke the accepted model again.
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
    expect((await app.snapshot()).history.at(-1)?.request).toMatchObject({
      input: {
        model: { id: "responder", provider: "test", api: "scripted" },
        request: {
          context: {
            messages: [
              { role: "user" },
              { role: "assistant" },
              { role: "tool", toolCallId: "call-1" },
            ],
          },
        },
      },
    });
    expect(requests).toHaveLength(2);
    expect(selections.map((selection) => selection.id)).toEqual(["planner", "responder"]);
    expect({ released, intercepted }).toEqual({ released: 2, intercepted: 2 });
    expect(events).toEqual([
      textEvent("Let me"),
      textEvent(" ask", "Let me ask"),
      textEvent(".", "Let me ask."),
      textEvent("Confirmed."),
    ]);
    store.reopen();
    await expect(assemble().run()).resolves.toEqual(completed);
    expect(requests).toHaveLength(2);
    expect(selections.map((selection) => selection.id)).toEqual(["planner", "responder"]);
  });
});

forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  for (const mode of ["failure", "cancel", "error-event"] as const) {
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
        const provider = runtime.composition.createApi<ModelProvider<Y>>("failing-model", {
          *stream() {
            yield* runtime.composition.ensure(function* () {
              // An asynchronous barrier proves cleanup is joined, not merely initiated.
              yield* runtime.fromPromise(() => Promise.resolve());
              released = true;
            });
            const source = runtime.createSignal<Event, Response>();
            const subscription = yield* source;
            source.send(textEvent("Unfinished"));
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
                if (mode === "error-event") {
                  return {
                    done: false as const,
                    value: {
                      type: "error" as const,
                      reason: "error" as const,
                      error: response("Unfinished").message,
                    },
                  };
                }
                throw new Error("Unexpected provider completion");
              },
            };
          },
        });
        yield* effects.install(sample, function* (request) {
          return yield* runtime.composition.scoped(function* () {
            const subscription = yield* provider.operations.stream(request);
            while (true) {
              const next = yield* subscription.next();
              if (next.done) {
                if (next.value.errorMessage) {
                  throw new Error(next.value.errorMessage);
                }
                return { ok: true as const, value: next.value };
              }
              if (next.value.type === "error") {
                throw new Error("Provider error event");
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
                  context: { messages: [], tools: [] },
                });
                if (!result.ok) {
                  throw new Error("Model failure");
                }
                return result.value.message.content
                  .filter((part) => part.type === "text")
                  .map((part) => part.text)
                  .join("");
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
      expect(events).toEqual([textEvent("Unfinished")]);
      if (mode === "failure") {
        peer.fail("model", new Error("Provider disconnected"));
        await expect(task.result).rejects.toThrow("Provider disconnected");
      } else if (mode === "error-event") {
        peer.reply("model", { status: 200, body: "error-event" });
        await expect(task.result).rejects.toThrow("Provider error event");
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
          value: textEvent("Unfinished"),
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
