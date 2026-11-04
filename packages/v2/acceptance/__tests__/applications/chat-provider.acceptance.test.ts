import { createFileConversation } from "../../examples/file-conversation.ts";
import { createFileChat, fileChatProgram } from "../../examples/file-chat.ts";
import {
  createChatExecution,
  createChatToolBinding,
  ChatAnswerValidationError,
} from "@sweatpan.ts/chat-host";
import {
  childHostingResult,
  type ChildHostingResult,
  type JournalTreeObservation,
} from "@sweatpan.ts/hosting";
import {
  installToolRouting,
  projectToolContract,
  resolveToolExecution,
  createToolInteractionStream,
  type ToolInteraction,
  type ToolInteractionContract,
} from "@sweatpan.ts/tools";
import { isDeepStrictEqual } from "node:util";
import { expect, expectTypeOf, it, onTestFinished } from "vitest";
import { z } from "zod";
import type { Operation, Work } from "@standard-durability/core";
import {
  createChatContext,
  type ChatLoopRequest,
  type ChatLoopEvent,
  type ChatSamplingError,
  createChatModel,
  createChatSampling,
  limitChatRounds,
  type ChatInference,
  runChat,
  type ModelSelection,
} from "@sweatpan.ts/chat";
import { defineEffect, type EffectDefinition, type CapabilityRequest } from "@sweatpan.ts/core";
import type {
  OwnedChild,
  PendingRequest,
  ResolutionGrant,
  RootCancellation,
} from "@sweatpan.ts/durable";
import { createScopedGuest } from "@sweatpan.ts/execution";
import {
  createEffectCapabilities,
  createHosting,
  createHostedActivation,
  type HostedActivation,
  type HostedResult,
  installGuestRetention,
} from "@sweatpan.ts/hosting";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import {
  createContextCounter,
  createModelProvider,
  measureContextBudget,
} from "@sweatpan.ts/providers";
import { createResponseSubscriptions } from "@sweatpan.ts/chat-client";
import type {
  ChatToolDefinition,
  ModelInfo,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
} from "@sweatpan.ts/providers";
import type { Runtime } from "@sweatpan.ts/runtime";
import { createToolAcquisition, defineTool, type ToolDefinition } from "@sweatpan.ts/tools";
import {
  createHostedRecovery,
  createSqliteJournalRig,
  createSqliteDatabaseRig,
  createProtocolRig,
  createLatch,
  readJournal,
} from "@sweatpan.ts/testing";
import { forEachRuntime } from "../runtime/assembly.ts";
// Assertion helpers deliberately require a successful phase before reading its payload.
function reportOf<T>(edge: {
  drive:
    | {
        status: "reported";
        report: T;
      }
    | {
        status: "unconfirmed";
        error: string;
      };
}): T {
  if (edge.drive.status !== "reported") {
    throw new Error(`Drive unconfirmed: ${edge.drive.error}`);
  }
  return edge.drive.report;
}
function frontierOf<T>(edge: {
  discovery:
    | {
        status: "observed";
        frontier: T;
      }
    | {
        status: "unavailable";
        error: string;
      };
}): T {
  if (edge.discovery.status !== "observed") {
    throw new Error(`Discovery unavailable: ${edge.discovery.error}`);
  }
  return edge.discovery.frontier;
}
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
const responseDataSchema = z.object({
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
const responseSchema: StandardSchemaV1<ModelResponse> = responseDataSchema;
type Request = ModelRequest;
type Response = ModelResponse;
type Event = ModelStreamEvent;
type Output =
  | Event
  | {
      type: "elicit";
      grant: ResolutionGrant;
    };
type OutputFrame = {
  value: Output;
  after: number;
};
function textEvent(delta: string, text = delta): Event {
  return {
    type: "text-delta",
    contentIndex: 0,
    delta,
    partial: { role: "assistant", content: [{ type: "text", text }] },
  };
}
type ToolInputCase = "valid" | "empty" | "blank";
function response(text: string, call = false, inputCase: ToolInputCase = "valid"): Response {
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
                  input: {
                    question:
                      inputCase === "empty" ? "" : inputCase === "blank" ? "   " : "  Proceed?  ",
                  },
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
const selectionSchema = z.object({ id: z.string(), provider: z.string(), api: z.string() });
const inferenceSchema = z.object({ model: selectionSchema, request: requestDataSchema });
const preparationSchema: StandardSchemaV1<ChatLoopRequest> = z.object({
  round: z.number().int().nonnegative(),
  history: z.array(
    z.union([
      message.options[0],
      assistant.extend({ model: selectionSchema }),
      message.options[2],
      message.options[3],
    ]),
  ),
  tools: requestDataSchema.shape.context.shape.tools,
});
const selectedSample = defineEffect({
  key: "chat.selected-model",
  context: preparationSchema,
  response: z.object({
    model: selectionSchema,
    prepared: inferenceSchema,
    count: z.object({ tokens: z.number(), kind: z.enum(["estimated", "measured"]) }),
    response: responseDataSchema,
  }),
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
// Application-owned Zod adapter, not a universal Standard Schema conversion.
// Input projection describes what the model sends, before Host normalization.
function modelToolDefinition(
  contract: {
    readonly id: string;
    readonly context: z.ZodType;
  },
  description: string,
): ChatToolDefinition {
  return {
    name: contract.id,
    description,
    parameters: z
      .record(z.string(), z.json())
      .parse(z.toJSONSchema(contract.context, { io: "input", target: "draft-7" })),
  };
}
forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  it.each<ToolInputCase>(["valid", "empty", "blank"])(
    `${runtime.name}: authored model tool discovery, validation and recovery (%s)`,
    async (inputCase) => {
      let normalizations = 0;
      let acquisitions = 0;
      const wireInput = z.object({ question: z.string().min(1) });
      const confirm = defineTool("confirm")
        .parameters(
          wireInput
            .transform(({ question }) => {
              normalizations++;
              return question.trim();
            })
            .pipe(z.string().min(1)),
        )
        .elicits({ approval })
        .execute(function* (question, ctx) {
          expectTypeOf(question).toEqualTypeOf<string>();
          expect(question).toBe("Proceed?");
          const answer = yield* ctx.elicit("approval", question);
          if (!answer.ok) {
            throw new Error("Approval failed");
          }
          return answer.value;
        });
      const contract = projectToolContract(confirm);
      const requests: Request[] = [];
      const selections: ModelSelection[] = [];
      let plannerAvailable = true;
      const events: Event[] = [];
      const peer = createProtocolRig();
      let released = 0;
      let intercepted = 0;
      let preparationPolicy = 0;
      const preparations: number[] = [];
      const modelSelections: string[] = [];
      const provider = createModelProvider<Y, ChatInference>(runtime.composition, "chat-model", {
        *stream() {
          throw new Error("Model provider not installed");
        },
      });
      const store = createSqliteJournalRig<string, CapabilityRequest, unknown, string, unknown, Y>({
        program: "authored-tool-chat-v1",
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
      function assemble(
        discovery: {
          readonly id: string;
          readonly context: z.ZodType;
        } = contract,
      ) {
        // Build discovery before acquiring a Guest or dispatching a provider.
        const definition = modelToolDefinition(discovery, "Ask for approval");
        const journal = store.open();
        const effects = createEffectCapabilities(runtime, "chat-effects");
        const root = effects.grant({ sample: selectedSample, confirm });
        const acquisition = createToolAcquisition(runtime, effects, confirm, "confirm-acquisition");
        let waiting:
          | {
              child: Child;
              grant: ResolutionGrant;
            }
          | undefined;
        function childHost(child: Child) {
          const recovery = createHostedRecovery<boolean, CapabilityRequest, Y, unknown, string>(
            runtime,
            {
              name: "confirm-recovery",
              program: confirm.id,
              matches: isDeepStrictEqual,
              acquire() {
                acquisitions++;
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
        function* runChild(child: Child): Operation<ChildHostingResult, Y> {
          const { host, recovery } = childHost(child);
          yield* installGuestRetention(runtime.composition, host, recovery, child.journal);
          yield* host.around({
            operations: acquisition.admission,
          });
          yield* host.around({
            operations: {
              deliveryMode: () =>
                function* () {
                  return "wait" as const;
                },
            },
          });
          const result = yield* host.operations.run();
          if (result.state === "waiting") {
            waiting = { child, grant: result.grant };
          }
          return childHostingResult(result);
        }
        return {
          snapshot() {
            return start(() => readJournal(journal));
          },
          run() {
            const activation = createHostedActivation<
              Output,
              HostedResult<string, CapabilityRequest>,
              Y
            >(runtime, {
              *run(emit) {
                yield* provider.install({
                  operations: {
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
                              source.close(response("Let me ask.", true, inputCase));
                            }
                            return yield* subscription.next();
                          },
                        };
                      } else {
                        expect(request.context.messages[1]).toEqual({
                          role: "assistant",
                          content: response("Let me ask.", true, inputCase).message.content.filter(
                            (part) => part.type !== "reasoning",
                          ),
                        });
                        expect(request.context.tools).toEqual([
                          {
                            name: "confirm",
                            description: "Ask for approval",
                            parameters: {
                              $schema: "http://json-schema.org/draft-07/schema#",
                              type: "object",
                              properties: { question: { type: "string", minLength: 1 } },
                              required: ["question"],
                            },
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
                  },
                });
                yield* provider.around({
                  operations: {
                    stream: (next) =>
                      function* (request) {
                        intercepted++;
                        return yield* next(request);
                      },
                  },
                });
                const context = createChatContext(runtime.composition, "chat-preparation");
                const counter = createContextCounter(runtime.composition, "chat-count", {
                  *count(_model, request) {
                    return {
                      tokens: Math.ceil(JSON.stringify(request).length / 4),
                      kind: "estimated" as const,
                    };
                  },
                });
                yield* context.around({
                  operations: {
                    prepare: (next) =>
                      function* (input) {
                        preparations.push(preparationPolicy);
                        return yield* next({
                          ...input,
                          options: { ...input.options, temperature: preparationPolicy },
                        });
                      },
                  },
                });
                const models = createChatModel(runtime.composition, "chat-selection", {
                  *select(input) {
                    const selected = input.round === 0 && plannerAvailable ? planner : responder;
                    modelSelections.push(selected.id);
                    return selected;
                  },
                });
                const sampling = createChatSampling(runtime.composition, "chat-sampling", {
                  model: models.operations,
                  *sample(model, input) {
                    const prepared = yield* context.operations.prepare({
                      ...input,
                      model,
                      foreignReasoning: "omit",
                    });
                    const count = yield* counter.operations.count(model, prepared.request);
                    if (model.maxOutputTokens === null) {
                      throw new Error("Model output budget unavailable");
                    }
                    if (!measureContextBudget(model, count, model.maxOutputTokens).fits) {
                      throw new Error("Context budget exceeded");
                    }
                    return yield* runtime.composition.scoped(function* () {
                      const subscription = yield* provider.operations.stream(prepared);
                      while (true) {
                        const next = yield* subscription.next();
                        if (next.done) {
                          if (next.value.errorMessage) {
                            throw new Error(next.value.errorMessage);
                          }
                          return {
                            model: prepared.model,
                            prepared: inferenceSchema.parse(prepared),
                            count,
                            response: responseDataSchema.parse(next.value),
                          };
                        }
                        if (next.value.type === "error") {
                          throw new Error("Provider error event");
                        }
                        events.push(next.value);
                        emit(next.value);
                      }
                    });
                  },
                });
                yield* sampling.around({
                  operations: limitChatRounds(4),
                });
                yield* effects.install(selectedSample, sampling.operations.sample);
                const recovery = createHostedRecovery<
                  string,
                  CapabilityRequest,
                  Y,
                  unknown,
                  string
                >(runtime, {
                  name: "chat-recovery",
                  program: "authored-tool-chat-v1",
                  matches: isDeepStrictEqual,
                  *acquire() {
                    return createScopedGuest(function* (scope) {
                      const completed = yield* runChat(scope, {
                        history: [{ role: "user", content: "Ask before proceeding." }],
                        tools: [
                          {
                            definition,
                            *call(call) {
                              const result = yield* root.capabilities.confirm(
                                // Decode wire input only. The authored transformation belongs
                                // to Host admission, whose normalized value is persisted.
                                wireInput.parse(call.input),
                              );
                              if (!result.ok) {
                                throw new Error("Tool failed");
                              }
                              expectTypeOf(result.value).toEqualTypeOf<boolean>();
                              return { content: JSON.stringify(result.value), isError: false };
                            },
                          },
                        ],
                        *sample(request) {
                          const result = yield* root.capabilities.sample(request);
                          return result.ok
                            ? result
                            : {
                                ok: false,
                                error: z.custom<ChatSamplingError>().parse(result.error),
                              };
                        },
                      });
                      return completed.response.message.content
                        .filter((part) => part.type === "text")
                        .map((part) => part.text)
                        .join("");
                    });
                  },
                });
                const host = createHosting(runtime.composition, {
                  name: "chat-host",
                  journal,
                  recovery: recovery.operations,
                  attempts: journal.attempts,
                  handle: root.handle,
                });
                yield* host.around({
                  operations: root.admission,
                });
                yield* installToolRouting(runtime, host, journal, { tool: confirm, run: runChild });
                return yield* host.operations.run();
              },
              present() {
                return waiting ? [{ type: "elicit", grant: waiting.grant }] : [];
              },
            });
            onTestFinished(() => activation.cancel());
            return activation;
          },
          answer(value: unknown) {
            return start(function* () {
              if (!waiting) {
                throw new Error("Not waiting");
              }
              const interactions = waiting.child.journal.interactions;
              const request = yield* interactions.request(waiting.grant);
              const outcome = yield* effects.grant(confirm.elicits).respond(request, {
                ok: true,
                value,
              });
              return yield* interactions.answer(waiting.grant, { ok: true, value: outcome });
            });
          },
        };
      }
      // A non-JSON input must not silently become an unconstrained model schema.
      const unsupported = defineTool("date-input")
        .parameters(z.object({ at: z.date() }))
        .execute(function* () {
          return true;
        });
      expect(() => assemble(projectToolContract(unsupported))).toThrow(/Date/);
      expect(requests).toEqual([]);
      expect(acquisitions).toBe(0);
      expect(normalizations).toBe(0);
      let app = assemble();
      const output = app.run();
      // Ordinary scoped API: source selection is context, compaction is reader policy.
      const Source =
        runtime.composition.createContext<
          HostedActivation<Output, HostedResult<string, CapabilityRequest>, Y>
        >("chat-output");
      const reads = createResponseSubscriptions(runtime.composition, "chat-output-reads", {
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
                return { done: true, value: item.value.state };
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
          operations: {
            subscribe: (next) =>
              function* (options) {
                subscriptions.push(options.after);
                return yield* next(options);
              },
          },
        });
      }
      let after = 0;
      let settled = false;
      const producing = output.result.finally(() => {
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
      if (inputCase !== "valid") {
        await expect(producing).rejects.toThrow(
          inputCase === "blank" ? "Invalid tool input" : /Too small/,
        );
        expect(acquisitions).toBe(0);
        expect(normalizations).toBe(inputCase === "blank" ? 1 : 0);
        const snapshot = await app.snapshot();
        // The model response is accepted, but no invalid tool execution is admitted.
        expect(snapshot.history).toHaveLength(1);
        expect(snapshot.history[0]?.outcome).toMatchObject({ ok: true });
        expect(requests).toHaveLength(1);
        expect(released).toBe(1);
        return;
      }
      const parked = await producing;
      expect(normalizations).toBe(1);
      expect(acquisitions).toBe(1);
      expect(parked.state).toBe("child");
      expect((await app.snapshot()).history[0]?.request).toMatchObject({
        input: {
          round: 0,
          history: [{ role: "user", content: "Ask before proceeding." }],
        },
      });
      const accepted = (await app.snapshot()).history[0];
      expect(accepted?.outcome).toMatchObject({
        ok: true,
        value: {
          ok: true,
          value: {
            model: { id: "planner", provider: "test", api: "scripted" },
            response: response("Let me ask.", true, inputCase),
            prepared: { request: { options: { temperature: 0 } } },
            count: { kind: "estimated" },
          },
        },
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
      preparationPolicy = 1;
      plannerAvailable = false; // Recovery must not resolve or invoke the accepted model again.
      store.reopen();
      app = assemble();
      await expect(app.run().result).resolves.toEqual(parked);
      expect(requests).toHaveLength(1);
      await expect(app.answer("yes")).rejects.toThrow("Effect schema rejected value");
      expect((await app.answer(true)).duplicate).toBe(false);
      expect((await app.answer(true)).duplicate).toBe(true);
      store.reopen();
      app = assemble();
      const completed = { state: "completed", value: "Confirmed." };
      await expect(app.run().result).resolves.toEqual(completed);
      expect((await app.snapshot()).history.at(-1)?.request).toMatchObject({
        input: {
          round: 1,
          history: [
            { role: "user" },
            { role: "assistant" },
            { role: "tool", toolCallId: "call-1" },
          ],
        },
      });
      expect((await app.snapshot()).history[0]).toEqual(accepted);
      expect(preparations).toEqual([0, 1]);
      expect(modelSelections).toEqual(["planner", "responder"]);
      expect(requests.map((request) => request.options?.temperature)).toEqual([0, 1]);
      expect(selections.map((selection) => selection.id)).toEqual(["planner", "responder"]);
      expect({ released, intercepted }).toEqual({ released: 2, intercepted: 2 });
      expect(events).toEqual([
        textEvent("Let me"),
        textEvent(" ask", "Let me ask"),
        textEvent(".", "Let me ask."),
        textEvent("Confirmed."),
      ]);
      store.reopen();
      await expect(assemble().run().result).resolves.toEqual(completed);
      expect(requests).toHaveLength(2);
      expect(normalizations).toBe(1); // Reopen consumes the persisted normalized child input.
      expect(selections.map((selection) => selection.id)).toEqual(["planner", "responder"]);
    },
  );
});
forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  for (const mode of ["failure", "cancel", "error-event"] as const) {
    it(`${runtime.name}: ${mode} after partial model output releases the provider without accepting a response`, async () => {
      const peer = createProtocolRig();
      const events: Event[] = [];
      let released = false;
      const store = createSqliteJournalRig<string, CapabilityRequest, unknown, string, unknown, Y>({
        program: "model-failure",
        equals: isDeepStrictEqual,
      });
      onTestFinished(() => store.close());
      const journal = store.open();
      const task = createHostedActivation<Event, HostedResult<string, CapabilityRequest>, Y>(
        runtime,
        {
          *run(emit) {
            const effects = createEffectCapabilities(runtime, "failure-effects");
            const grant = effects.grant({ sample });
            const provider = createModelProvider<Y>(runtime.composition, "failing-model", {
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
                  emit(next.value);
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
            yield* host.around({
              operations: grant.admission,
            });
            return yield* host.operations.run();
          },
        },
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
      const lateReader = runtime.start(function* () {
        const reader = yield* task.from(0);
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
// The explicit Guest batch boundary routes to application-owned concurrent tools.
forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  it(`${runtime.name}: discovery preserves cancellation during an answerable cleanup across reopen`, async () => {
    let parsed = 0;
    let acquisitions = 0;
    const context = z.string().transform((value) => {
      parsed++;
      return value;
    });
    const review = defineEffect({ key: "cleanup.review", context, response: z.boolean() });
    const tool = defineTool("cleanup-discovery")
      .parameters(z.string())
      .elicits({ review, reviewAlias: review })
      .execute(function* (input, ctx) {
        yield* ctx.scope.ensure(function* () {
          yield* ctx.elicit("review", input);
        });
        return "done";
      });
    const contract = projectToolContract(tool);
    const catalog = new Map([[tool.id, contract]]);
    const store = createSqliteJournalRig<string, CapabilityRequest, unknown, string, unknown, Y>({
      program: tool.id,
      equals: isDeepStrictEqual,
    });
    onTestFinished(() => store.close());
    let journal = store.open();
    function start<T>(work: Work<T, Y>) {
      const task = runtime.start(work);
      void task.result.catch(() => undefined);
      onTestFinished(() => task.cancel());
      return task.result;
    }
    function run() {
      return start(function* () {
        const effects = createEffectCapabilities(runtime, "cleanup-discovery");
        const acquisition = createToolAcquisition(runtime, effects, tool, "cleanup.acquire");
        const recovery = createHostedRecovery<string, CapabilityRequest, Y, unknown, string>(
          runtime,
          {
            name: "cleanup.recovery",
            program: tool.id,
            matches: isDeepStrictEqual,
            *acquire() {
              acquisitions++;
              return yield* acquisition.operations.acquire("Confirm cleanup?");
            },
          },
        );
        const host = createHosting(runtime.composition, {
          name: "cleanup.host",
          journal,
          recovery: recovery.operations,
          attempts: journal.attempts,
          interactions: journal.interactions,
          handle: acquisition.handle,
        });
        yield* host.around({
          operations: acquisition.admission,
        });
        yield* installGuestRetention(runtime.composition, host, recovery, journal);
        yield* host.around({
          operations: {
            deliveryMode: () =>
              function* () {
                return "wait";
              },
          },
        });
        return yield* host.operations.run();
      });
    }
    function discover() {
      return start(function* () {
        const stream = yield* createToolInteractionStream(runtime.composition, journal, catalog);
        const found: ToolInteraction[] = [];
        while (true) {
          const next = yield* stream.next();
          if (next.done) {
            return found;
          }
          found.push(next.value);
        }
      });
    }
    await start(() => journal.admit(tool.id, "Confirm cleanup?"));
    const waiting = await run();
    if (waiting.state !== "waiting") {
      throw new Error("Expected cleanup wait");
    }
    const first = await discover();
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      execution: journal.id,
      program: tool.id,
      parent: undefined,
      input: "Confirm cleanup?",
      grant: waiting.grant,
      scope: { phase: "cleanup" },
      cancellation: undefined,
      cancellationRequested: undefined,
    });
    // Projection creates distinct declaration views for aliases, but retains schema identity.
    expect(contract.elicits.reviewAlias).not.toBe(contract.elicits.review);
    expect(contract.elicits.reviewAlias.context).toBe(contract.elicits.review.context);
    expect(first[0]!.declaration).toBe(contract.elicits.review);
    const discoveryBefore = await start(() => readJournal(journal));
    const discoveryIntent = await start(() => store.activations.read());
    for (const field of ["context", "response"] as const) {
      const conflicting: ToolInteractionContract = {
        id: tool.id,
        elicits: {
          review: contract.elicits.review,
          conflicting: { ...contract.elicits.review, [field]: z.string() },
        },
      };
      await start(function* () {
        const stream = yield* createToolInteractionStream(
          runtime.composition,
          journal,
          new Map([[tool.id, conflicting]]),
        );
        for (let attempt = 0; attempt < 2; attempt++) {
          yield* runtime.composition.catchError(
            function* () {
              yield* stream.next();
              throw new Error("Expected conflicting schemas to fail");
            },
            function* (error) {
              expect(String(error)).toContain("Ambiguous interaction declaration");
            },
          );
        }
      });
    }
    const escaped = await start(function* () {
      const source = createToolInteractionStream(runtime.composition, journal, catalog);
      const stream = yield* source;
      expect((yield* stream.next()).done).toBe(false);
      yield* runtime.composition.catchError(
        function* () {
          yield* source;
          throw new Error("Expected single acquisition");
        },
        function* (error) {
          expect(String(error)).toContain("already acquired");
        },
      );
      return stream;
    });
    await expect(start(() => escaped.next())).rejects.toThrow("scope exited");
    expect(await start(() => readJournal(journal))).toEqual(discoveryBefore);
    expect(await start(() => store.activations.read())).toEqual(discoveryIntent);
    await start(() => journal.cancellation.request(waiting.grant.requestId, "stop requested"));
    journal = store.reopen();
    const before = await start(() => readJournal(journal));
    const intent = await start(() => store.activations.read());
    const count = acquisitions;
    const parseCount = parsed;
    const cancelled = await discover();
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]).toMatchObject({
      grant: waiting.grant,
      scope: { phase: "cleanup" },
      cancellation: { reason: "stop requested" },
    });
    expect(cancelled[0]!.declaration).toBe(contract.elicits.review);
    expect(cancelled[0]!.declaration.context).toBe(context);
    expect(cancelled[0]!.revision).toBe(before.revision);
    expect(acquisitions).toBe(count);
    expect(parsed).toBe(parseCount); // discovery preserves raw input; parsing is application policy
    expect(await start(() => readJournal(journal))).toEqual(before);
    expect(await start(() => store.activations.read())).toEqual(intent);
    await start(function* () {
      const request = yield* journal.interactions.request(waiting.grant);
      const effects = createEffectCapabilities(runtime, "cleanup.answer");
      const answer = yield* effects.grant(tool.elicits).respond(request, { ok: true, value: true });
      yield* journal.interactions.answer(waiting.grant, { ok: true, value: answer });
    });
    expect(await discover()).toEqual([]); // accepted, even though execution has not advanced yet
    expect(await run()).toMatchObject({ state: "cancelled", reason: "stop requested" });
    journal = store.reopen();
    expect(await discover()).toEqual([]);
  });
  it.each([
    "confirm",
    "compensate",
    "together",
    "partial",
    "drive-failure",
    "client-recovery",
    "client-correction",
    "owner-cancel",
  ] as const)(
    `${runtime.name}: model tool batch exposes authored body/cleanup contracts across reopen (%s first)`,
    async (first) => {
      const peer = createProtocolRig();
      const input = z.object({ label: z.string() });
      const repairSchema = z.object({ action: z.literal("released"), evidence: z.string().min(1) });
      const repair = defineEffect({
        key: "batch.repair",
        context: z.string(),
        response: repairSchema,
      });
      const inspect = defineEffect({
        key: "batch.inspect",
        context: z.string(),
        response: z.string(),
      });
      const release = defineEffect({
        key: "batch.release",
        context: z.string(),
        response: z.string(),
      });
      let normalizations = 0;
      const confirm = defineTool("confirm")
        .parameters(
          input.transform(({ label }) => {
            normalizations++;
            return label.trim();
          }),
        )
        .capabilities({ inspect })
        .elicits({ approval })
        .execute(function* (label, ctx) {
          const inspected = yield* ctx.capabilities.inspect(label);
          if (!inspected.ok) {
            throw new Error("Inspection failed");
          }
          const answer = yield* ctx.elicit("approval", inspected.value);
          if (!answer.ok || !answer.value) {
            throw new Error("Approval required");
          }
          return "approved";
        });
      const compensate = defineTool("compensate")
        .parameters(input)
        .capabilities({ release })
        .elicits({ repair })
        .execute(function* ({ label }, ctx) {
          yield* ctx.scope.ensure(function* () {
            const result = yield* ctx.capabilities.release(label);
            if (!result.ok) {
              throw new Error("Release failed");
            }
            if (result.value === "denied") {
              const resolution = yield* ctx.elicit("repair", label);
              if (!resolution.ok) {
                throw new Error("Repair required");
              }
            }
          });
          // Application decline initiates cleanup without cancelling sibling tools.
          return "compensated";
        });
      type Tool = typeof confirm | typeof compensate;
      const catalog: ReadonlyMap<string, Tool> = new Map<string, Tool>([
        [confirm.id, confirm],
        [compensate.id, compensate],
      ]);
      const contracts = [projectToolContract(confirm), projectToolContract(compensate)] as const;
      let discoveryCatalog: ReadonlyMap<string, ToolInteractionContract> = new Map(
        contracts.map((contract) => [contract.id, contract]),
      );
      const definitions = contracts.map((contract) => modelToolDefinition(contract, contract.id));
      const descriptors = z.array(z.object({ id: z.string(), name: z.string(), input: input }));
      const batch = defineEffect({
        key: "chat.parallel-tools",
        context: descriptors,
        response: z.array(z.string()),
      });
      const progress = defineEffect({
        key: "chat.batch-progress",
        context: z.custom<ChatLoopEvent>(),
        response: z.null(),
      });
      const recordedEvents: ChatLoopEvent[] = [];
      const sampling = defineEffect({
        key: "chat.batch-model",
        context: preparationSchema,
        response: z.object({ model: selectionSchema, response: responseDataSchema }),
      });
      const store = createSqliteJournalRig<string, CapabilityRequest, unknown, string, unknown, Y>({
        program: "chat-frontier-batch-v3",
        equals: isDeepStrictEqual,
      });
      onTestFinished(() => store.close());
      function start<T>(work: Work<T, Y>) {
        const task = runtime.start(work);
        void task.result.catch(() => undefined);
        onTestFinished(() => task.cancel());
        return task;
      }
      let journal = store.open();
      let acquired = 0;
      let activeDeliveries = 0;
      const modelRequests: ChatLoopRequest[] = [];
      let bindings = 0;
      function toolExecutions(owner: typeof journal, programs = catalog) {
        return {
          owner,
          programs,
          *bind(execution: string, program: string) {
            bindings++;
            return yield* owner.openChildInteractions<CapabilityRequest, unknown, string>(
              execution,
              program,
            );
          },
        };
      }
      function execution(
        maxIterations = 16,
        available = discoveryCatalog,
        allPrograms = true,
        program = "chat-frontier-batch-v3",
      ) {
        const recovery = <R>(
          options: Parameters<
            typeof createHostedRecovery<R, CapabilityRequest, Y, unknown, string>
          >[1],
        ) =>
          createHostedRecovery<R, CapabilityRequest, Y, unknown, string>(runtime, {
            ...options,
            *acquire() {
              if (options.program !== "chat-frontier-batch-v3") {
                acquired++;
              }
              return yield* options.acquire();
            },
          });
        function binding<
          S extends StandardSchemaV1,
          D extends Record<string, EffectDefinition>,
          L extends Record<string, EffectDefinition>,
        >(tool: ToolDefinition<S, D, L, string>) {
          return createChatToolBinding(runtime, tool, {
            definition: definitions.find((definition) => definition.name === tool.id)!,
            recovery,
            matches: isDeepStrictEqual,
            *configure({ host, effects }) {
              for (const effect of [inspect, release]) {
                yield* effects.install(effect, function* (label) {
                  activeDeliveries++;
                  yield* runtime.composition.ensure(function* () {
                    activeDeliveries--;
                  });
                  const reply = yield* runtime.fromPromise((signal) =>
                    peer.send({ id: effect.id, token: label }, signal),
                  );
                  return { ok: true, value: z.string().parse(reply.body) };
                });
              }
              let iterations = 0;
              yield* host.around({
                operations: {
                  continuation: () =>
                    function* () {
                      return iterations++ < maxIterations
                        ? { action: "continue" }
                        : { action: "yield", reason: "edge budget" };
                    },
                },
              });
            },
          });
        }
        return createChatExecution(runtime, {
          name: "batch-chat",
          program,
          journal,
          effects: { sampling, batch, progress },
          tools: [binding(confirm), binding(compensate)].filter(
            (tool) => allPrograms || available.has(tool.program),
          ),
          recovery,
          matches: isDeepStrictEqual,
          batch: {
            effect: batch.id,
            calls: (raw) => descriptors.parse(raw),
            outcome: (values) => ({ ok: true, value: { ok: true, value: values } }),
          },
          *acquire(root, definitions) {
            return createScopedGuest(function* (scope) {
              const done = yield* runChat(scope, {
                history: [{ role: "user", content: "Approve one task and repair the other." }],
                tools: definitions.map((definition) => ({ definition })),
                *executeTools(calls) {
                  const validated = descriptors.parse(calls);
                  const outcome = yield* root.capabilities.batch(validated);
                  if (!outcome.ok) {
                    throw new Error("Batch failed");
                  }
                  // Deliberately return reverse order; chat correlates by call ID.
                  return validated
                    .map((call, index) => ({
                      toolCallId: call.id,
                      content: JSON.stringify(outcome.value[index]),
                      isError: false,
                    }))
                    .reverse();
                },
                *event(event) {
                  const recorded = yield* root.capabilities.progress(event);
                  if (!recorded.ok) {
                    throw new Error("Progress failed");
                  }
                },
                *sample(request) {
                  const outcome = yield* root.capabilities.sampling(request);
                  if (!outcome.ok) {
                    throw new Error("Model failed");
                  }
                  return outcome;
                },
              });
              return done.response.message.content
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join("");
            });
          },
          *configure({ host, effects }) {
            yield* effects.install(progress, function* (event) {
              recordedEvents.push(structuredClone(event));
              return { ok: true, value: null };
            });
            yield* effects.install(sampling, function* (request) {
              modelRequests.push(structuredClone(request));
              const reply = yield* runtime.fromPromise((signal) =>
                peer.send({ id: `model-${request.round}`, token: JSON.stringify(request) }, signal),
              );
              return {
                ok: true,
                value: {
                  model: planner,
                  response: responseDataSchema.parse(JSON.parse(reply.body)),
                },
              };
            });
            let iterations = 0;
            yield* host.around({
              operations: {
                continuation: () =>
                  function* () {
                    return iterations++ < maxIterations
                      ? { action: "continue" }
                      : { action: "yield", reason: "edge budget" };
                  },
              },
            });
          },
        });
      }
      function* drive(maxIterations = 16) {
        return yield* execution(maxIterations).run();
      }
      function run() {
        return start(() => drive());
      }
      type Interaction = {
        execution: string;
        tool: string;
        effect: string;
        grant: ResolutionGrant;
        context: unknown;
        scope: PendingRequest<CapabilityRequest>["scope"];
        responseSchema: object;
        parent: JournalTreeObservation["parent"];
        revision: number;
        cancellation: RootCancellation<unknown> | undefined;
        cancellationRequested: RootCancellation<unknown> | undefined;
      };
      function* observe(role: "participant" | "operator" = "operator") {
        const root = yield* journal.read();
        const token = yield* store.activations.read();
        const items: Interaction[] = [];
        const stream = yield* execution(16, discoveryCatalog, false).interactions();
        while (true) {
          const next = yield* stream.next();
          if (next.done) {
            break;
          }
          const interaction = next.value;
          // Application visibility policy, not a property of tree discovery.
          if (interaction.declaration.id === repair.id && role !== "operator") {
            continue;
          }
          // This application uses Zod. Discovery neither parses context nor exports schemas.
          const context = (interaction.declaration.context as z.ZodType).parse(interaction.input);
          items.push({
            execution: interaction.execution,
            tool: interaction.program,
            effect: interaction.declaration.id,
            grant: interaction.grant,
            context,
            scope: interaction.scope,
            parent: interaction.parent,
            revision: interaction.revision,
            cancellation: interaction.cancellation,
            cancellationRequested: interaction.cancellationRequested,
            responseSchema: z.toJSONSchema(interaction.declaration.response as z.ZodType),
          });
        }
        expect(yield* store.activations.read()).toEqual(token);
        expect((yield* journal.read()).revision).toBe(root.revision);
        return items;
      }
      function frontier() {
        return start(observe).result;
      }
      function* accept(item: Interaction, value: unknown) {
        const binding = yield* resolveToolExecution(toolExecutions(journal), item.execution);
        if (binding.tool.id !== item.tool) {
          throw new Error("Unknown interaction owner");
        }
        const stored = yield* binding.interactions.request(item.grant);
        if (stored.effect !== item.effect) {
          throw new Error("Wrong interaction contract");
        }
        return yield* execution().answer(
          { execution: item.execution, grant: item.grant },
          { ok: true, value },
        );
      }
      function answer(item: Interaction, value: unknown) {
        return start(() => accept(item, value)).result;
      }
      function advance(
        answers: readonly {
          target: Interaction;
          value: unknown;
        }[],
        maxIterations = 16,
      ) {
        return start(function* () {
          if (!Number.isSafeInteger(maxIterations) || maxIterations < 0) {
            throw new Error("Invalid edge budget");
          }
          const acknowledgements = [];
          for (const [index, answer] of answers.entries()) {
            acknowledgements.push(
              yield* runtime.composition.catchError(
                function* () {
                  const result = yield* accept(answer.target, answer.value);
                  return {
                    index,
                    status: "accepted" as const,
                    receipt: result.entry.receipt,
                    duplicate: result.duplicate,
                  };
                },
                function* (error) {
                  if (error instanceof ChatAnswerValidationError) {
                    return { index, status: "rejected" as const, error: String(error) };
                  }
                  return { index, status: "unconfirmed" as const, error: String(error) };
                },
              ),
            );
          }
          const driving = yield* runtime.composition.catchError(
            function* () {
              return { status: "reported" as const, report: yield* drive(maxIterations) };
            },
            function* (error) {
              return { status: "unconfirmed" as const, error: String(error) };
            },
          );
          const discovery = yield* runtime.composition.catchError(
            function* () {
              return { status: "observed" as const, frontier: yield* observe() };
            },
            function* (error) {
              return { status: "unavailable" as const, error: String(error) };
            },
          );
          return { answers: acknowledgements, drive: driving, discovery };
        });
      }
      type EdgeResponse = Awaited<ReturnType<typeof advance>["result"]>;
      // Application-local client experiment: one owner/root and one in-flight exchange.
      // Retention is process-local; journal receipts, not this cache, establish acceptance.
      function createClient(
        initial: Interaction[],
        send: (
          answers: readonly {
            target: Interaction;
            value: unknown;
          }[],
          budget: number,
        ) => Promise<EdgeResponse>,
        reply: (interaction: Interaction) => unknown,
      ) {
        const saved = new Map<
          string,
          {
            target: Interaction;
            value: unknown;
            status: "queued" | "unconfirmed" | "rejected" | "accepted";
            error?: string;
          }
        >();
        let delivery: "idle" | "sending" | "received" | "unconfirmed" = "idle";
        let lastKnown = structuredClone(initial);
        let discoveryKnown = true;
        let driveResult: EdgeResponse["drive"] | undefined;
        function key(item: Interaction) {
          return JSON.stringify([item.execution, item.grant.requestId, item.grant.resolutionId]);
        }
        return {
          prepare(item: Interaction) {
            if (delivery === "sending") {
              throw new Error("Client exchange in progress");
            }
            if (!saved.has(key(item))) {
              saved.set(key(item), {
                target: structuredClone(item),
                value: structuredClone(reply(item)),
                status: "queued",
              });
            }
          },
          correct(item: Interaction, value: unknown) {
            if (delivery === "sending") {
              throw new Error("Client exchange in progress");
            }
            const answer = saved.get(key(item));
            if (!answer || answer.status !== "rejected") {
              throw new Error("Only a rejected answer can be corrected");
            }
            answer.value = structuredClone(value);
            answer.status = "queued";
            delete answer.error;
          },
          async flush(budget: number) {
            if (delivery === "sending") {
              throw new Error("Client exchange in progress");
            }
            const submitted = [...saved.values()].filter(
              (answer) => answer.status === "queued" || answer.status === "unconfirmed",
            );
            for (const answer of submitted) {
              answer.status = "unconfirmed";
              delete answer.error;
            }
            delivery = "sending";
            discoveryKnown = false;
            driveResult = undefined;
            try {
              const response = await send(
                submitted.map(({ target, value }) => ({ target, value })),
                budget,
              );
              // Validate all correlations before retiring any queued answer.
              if (
                response.answers.length !== submitted.length ||
                response.answers.some(
                  (answer, index) =>
                    answer.index !== index ||
                    (answer.status === "accepted" &&
                      answer.receipt !== submitted[index]!.target.grant.requestId),
                )
              ) {
                throw new Error("Uncorrelated answer acknowledgement");
              }
              for (const [index, answer] of response.answers.entries()) {
                submitted[index]!.status = answer.status;
                if (answer.status !== "accepted") {
                  submitted[index]!.error = answer.error;
                }
              }
              driveResult = response.drive;
              if (response.discovery.status === "observed") {
                lastKnown = structuredClone(response.discovery.frontier);
                discoveryKnown = true;
              }
              delivery = "received";
              return response;
            } catch (error) {
              delivery = "unconfirmed";
              throw error;
            }
          },
          view() {
            return {
              delivery,
              pendingAnswers: [...saved.values()].filter((answer) => answer.status !== "accepted")
                .length,
              answers: [...saved.values()].map(({ target, status, error }) => ({
                execution: target.execution,
                grant: structuredClone(target.grant),
                status,
                error,
              })),
              drive: driveResult,
              discovery: discoveryKnown
                ? { status: "observed" as const, frontier: structuredClone(lastKnown) }
                : { status: "unknown" as const, lastKnown: structuredClone(lastKnown) },
            };
          },
        };
      }
      onTestFinished(() => expect(normalizations).toBe(1));
      const firstRun = run();
      await Promise.race([peer.waitForRequests(1), firstRun.result]);
      const batchResponse: Response = {
        ...response("Two tasks.", true),
        message: {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCall: {
                id: "approval-call",
                name: confirm.id,
                input: { label: "  Approve publication?  " },
                thoughtSignature: null,
              },
            },
            {
              type: "tool-call",
              toolCall: {
                id: "cleanup-call",
                name: compensate.id,
                input: { label: "draft-7" },
                thoughtSignature: null,
              },
            },
          ],
        },
      };
      peer.reply("model-0", { status: 200, body: JSON.stringify(batchResponse) });
      await Promise.race([peer.waitForRequests(3), firstRun.result]);
      // In-flight provider attempts are status, not participant questions.
      expect(await frontier()).toEqual([]);
      if (first === "owner-cancel") {
        expect(activeDeliveries).toBe(2);
        await firstRun.cancel();
        await expect(firstRun.result).rejects.toThrow();
        expect(activeDeliveries).toBe(0);
        journal = store.reopen();
        const requestsBeforeRetry = peer.requests.length;
        expect(await run().result).toMatchObject({ state: "child", reason: "occupied" });
        expect(peer.requests).toHaveLength(requestsBeforeRetry);
        expect(await frontier()).toEqual([]);
        return;
      }
      peer.reply(inspect.id, { status: 200, body: "Approve publication?" });
      peer.reply(release.id, { status: 200, body: "denied" });
      expect(await firstRun.result).toMatchObject({ state: "child", reason: "waiting" });
      expect(recordedEvents.map((event) => event.type)).toEqual([
        "assistant",
        "tool-batch-started",
      ]);
      expect(recordedEvents[1]).toMatchObject({
        calls: [{ id: "approval-call" }, { id: "cleanup-call" }],
      });
      expect(modelRequests).toHaveLength(1);
      expect(modelRequests[0]!.tools).toEqual(definitions);
      const staleExecution = execution();
      journal = store.reopen();
      const count = acquired;
      const items = await frontier();
      expect(acquired).toBe(count);
      expect(items).toHaveLength(2);
      const approvalItem = items.find((item) => item.tool === "confirm")!;
      const repairItem = items.find((item) => item.tool === "compensate")!;
      expect(await start(() => observe("participant")).result).toEqual([approvalItem]);
      expect(approvalItem.parent?.execution).toBe(journal.id);
      expect(repairItem.parent?.execution).toBe(journal.id);
      await expect(start(() => staleExecution.run()).result).rejects.toThrow();
      await expect(
        start(() =>
          staleExecution.answer(
            { execution: approvalItem.execution, grant: approvalItem.grant },
            { ok: true, value: true },
          ),
        ).result,
      ).rejects.toThrow();
      const wrongProgram = execution(16, discoveryCatalog, true, "wrong-program");
      await expect(start(() => wrongProgram.run()).result).rejects.toThrow("program mismatch");
      await expect(
        start(() =>
          wrongProgram.answer(
            { execution: approvalItem.execution, grant: approvalItem.grant },
            { ok: true, value: true },
          ),
        ).result,
      ).rejects.toThrow("program mismatch");
      await expect(
        start(function* () {
          const questions = yield* wrongProgram.interactions();
          yield* questions.next();
        }).result,
      ).rejects.toThrow("program mismatch");
      const escaped = await start(function* () {
        return yield* execution().interactions();
      }).result;
      await expect(start(() => escaped.next()).result).rejects.toThrow();
      const beforeDiscovery = await start(() => readJournal(journal)).result;
      const discoveryIntent = await start(() => store.activations.read()).result;
      await expect(
        start(function* () {
          const stream = yield* createToolInteractionStream(
            runtime.composition,
            journal,
            new Map(),
          );
          yield* stream.next();
        }).result,
      ).rejects.toThrow("Unknown interaction program");
      await start(function* () {
        const partialCatalog: ReadonlyMap<string, ToolInteractionContract> = new Map<
          string,
          ToolInteractionContract
        >([
          [confirm.id, contracts[0]!],
          [compensate.id, { id: compensate.id, elicits: {} }],
        ]);
        const stream = yield* createToolInteractionStream(
          runtime.composition,
          journal,
          partialCatalog,
        );
        const first = yield* stream.next();
        if (first.done) {
          throw new Error("Expected approval discovery");
        }
        expect(first.value.declaration).toBe(contracts[0]!.elicits.approval);
        expect(first.value.input).toBe("Approve publication?");
        expect(first.value.grant).toEqual(approvalItem.grant);
        yield* runtime.composition.catchError(
          function* () {
            yield* stream.next();
            throw new Error("Expected missing repair declaration");
          },
          function* (error) {
            expect(String(error)).toContain("Undeclared interaction");
          },
        );
      }).result;
      expect(await start(() => readJournal(journal)).result).toEqual(beforeDiscovery);
      expect(await start(() => store.activations.read()).result).toEqual(discoveryIntent);
      expect(acquired).toBe(count);
      // Resolution owns no Guest and must not change durable state, even when rejected.
      function* bindingState() {
        const root = yield* journal.read();
        const children = [];
        for (const item of items) {
          const reader = yield* journal.openChild(item.execution);
          const state = yield* reader.read();
          children.push({ execution: reader.id, revision: state.revision });
        }
        return { revision: root.revision, children, intent: yield* store.activations.read() };
      }
      const beforeBinding = await start(bindingState).result;
      const requestsBeforeBinding = peer.requests.length;
      const approvalBinding = await start(() =>
        resolveToolExecution(toolExecutions(journal), approvalItem.execution),
      ).result;
      expect(approvalBinding.execution).toBe(approvalItem.execution);
      expect(approvalBinding.tool).toBe(confirm);
      expect(approvalBinding.tool).not.toBe(contracts[0]);
      const repairBinding = await start(() =>
        resolveToolExecution(toolExecutions(journal), repairItem.execution),
      ).result;
      expect(repairBinding.tool).toBe(compensate);
      const bindingsBeforeRejections = bindings;
      // A valid execution is not reachable merely because its ID is known.
      const otherStore = createSqliteJournalRig<
        string,
        CapabilityRequest,
        unknown,
        string,
        unknown,
        Y
      >({
        program: "chat-frontier-batch-v3",
        equals: isDeepStrictEqual,
      });
      onTestFinished(() => otherStore.close());
      const otherOwner = otherStore.open();
      await start(() => otherOwner.admit("chat-frontier-batch-v3", {})).result;
      await expect(
        start(() => resolveToolExecution(toolExecutions(otherOwner), approvalItem.execution))
          .result,
      ).rejects.toThrow("Not a direct owned child");
      await expect(
        start(() => resolveToolExecution(toolExecutions(journal), otherOwner.id)).result,
      ).rejects.toThrow("Not a direct owned child");
      await expect(
        start(() => resolveToolExecution(toolExecutions(journal), "missing-execution")).result,
      ).rejects.toThrow("Not a direct owned child");
      await expect(
        start(() =>
          resolveToolExecution(toolExecutions(journal, new Map()), approvalItem.execution),
        ).result,
      ).rejects.toThrow("Pinned tool is unavailable");
      await expect(
        start(() =>
          resolveToolExecution(
            toolExecutions(journal, new Map([[confirm.id, compensate]])),
            approvalItem.execution,
          ),
        ).result,
      ).rejects.toThrow("Pinned tool is unavailable");
      expect(bindings).toBe(bindingsBeforeRejections);
      // A miswired adapter returning a real sibling must not grant that sibling's ingress.
      await expect(
        start(() =>
          resolveToolExecution(
            {
              ...toolExecutions(journal),
              bind: () =>
                journal.openChildInteractions<CapabilityRequest, unknown, string>(
                  repairItem.execution,
                  compensate.id,
                ),
            },
            approvalItem.execution,
          ),
        ).result,
      ).rejects.toThrow("Resolved tool execution does not match persisted ownership");
      await expect(answer({ ...approvalItem, tool: compensate.id }, true)).rejects.toThrow(
        "Unknown interaction owner",
      );
      await expect(answer({ ...approvalItem, effect: repair.id }, true)).rejects.toThrow(
        "Wrong interaction contract",
      );
      expect(await start(bindingState).result).toEqual(beforeBinding);
      expect(acquired).toBe(count);
      expect(peer.requests).toHaveLength(requestsBeforeBinding);
      expect(approvalItem).toMatchObject({
        context: "Approve publication?",
        scope: { phase: "body" },
        responseSchema: { type: "boolean" },
      });
      expect(repairItem).toMatchObject({
        context: "draft-7",
        scope: { phase: "cleanup" },
        responseSchema: { type: "object", required: ["action", "evidence"] },
      });
      await expect(answer(approvalItem, "yes")).rejects.toThrow("schema");
      await expect(answer(repairItem, { action: "released", evidence: "" })).rejects.toThrow(
        "schema",
      );
      await expect(answer({ ...approvalItem, grant: repairItem.grant }, true)).rejects.toThrow();
      const valueFor = (item: Interaction) =>
        item.tool === "confirm" ? true : { action: "released", evidence: "operator-record-7" };
      const envelope = items.map((target) => ({ target, value: valueFor(target) }));
      let finalAnswers = envelope;
      let client: ReturnType<typeof createClient> | undefined;
      let clientReplies = 0;
      let loseNextResponse = false;
      if (first === "client-recovery" || first === "client-correction") {
        client = createClient(
          items,
          async (answers, budget) => {
            const response = await advance(answers, budget).result;
            if (loseNextResponse) {
              loseNextResponse = false;
              throw new Error("Client response lost");
            }
            return response;
          },
          (item) => {
            clientReplies++;
            return first === "client-correction" && item.tool === "compensate"
              ? { action: "released", evidence: "" }
              : valueFor(item);
          },
        );
        if (first === "client-correction") {
          client.prepare(approvalItem);
          client.prepare(repairItem);
          const partial = await client.flush(16);
          expect(partial.answers.map((answer) => answer.status)).toEqual(["accepted", "rejected"]);
          expect(partial.answers[1]).toMatchObject({ error: expect.stringContaining("schema") });
          expect(reportOf(partial)).toMatchObject({ state: "child", reason: "waiting" });
          expect(frontierOf(partial).map((item) => item.grant)).toEqual([repairItem.grant]);
          expect(client.view().answers.map((answer) => answer.status)).toEqual([
            "accepted",
            "rejected",
          ]);
          expect(client.view().pendingAnswers).toBe(1);
          const unchanged = await client.flush(0);
          expect(unchanged.answers).toEqual([]); // neither accepted nor rejected inputs are resent
          expect(client.view().answers.map((answer) => answer.status)).toEqual([
            "accepted",
            "rejected",
          ]);
          expect(() => client!.correct(approvalItem, false)).toThrow("Only a rejected answer");
          journal = store.reopen();
          client.prepare(approvalItem);
          client.prepare(repairItem);
          expect(clientReplies).toBe(2);
          const corrected = { action: "released", evidence: "operator-record-7" };
          client.correct(repairItem, corrected);
          corrected.evidence = "caller mutation";
          loseNextResponse = true;
          await expect(client.flush(0)).rejects.toThrow("Client response lost");
          expect(client.view().answers.map((answer) => answer.status)).toEqual([
            "accepted",
            "unconfirmed",
          ]);
          expect(() => client!.correct(repairItem, valueFor(repairItem))).toThrow(
            "Only a rejected answer",
          );
          journal = store.reopen();
          const recovered = await client.flush(0);
          expect(recovered.answers).toEqual([
            { index: 0, status: "accepted", duplicate: true, receipt: repairItem.grant.requestId },
          ]);
          expect((await answer(repairItem, valueFor(repairItem))).duplicate).toBe(true);
          expect(client.view().pendingAnswers).toBe(0);
          expect(clientReplies).toBe(2);
        } else {
          client.prepare(approvalItem);
          const available = discoveryCatalog;
          discoveryCatalog = new Map([[confirm.id, contracts[0]]]);
          const hidden = await client.flush(0);
          expect(hidden.answers[0]).toMatchObject({ status: "accepted", duplicate: false });
          expect(client.view()).toMatchObject({
            pendingAnswers: 0,
            delivery: "received",
            discovery: { status: "unknown" },
          });
          expect(client.view().drive).toMatchObject({
            status: "reported",
            report: { state: "yielded" },
          });
          discoveryCatalog = available;
          journal = store.reopen();
          client.prepare(approvalItem); // stale rediscovery must not ask the client to answer again
          client.prepare(repairItem);
          expect(clientReplies).toBe(2);
          loseNextResponse = true;
          await expect(client.flush(0)).rejects.toThrow("Client response lost");
          expect(client.view()).toMatchObject({
            pendingAnswers: 1,
            delivery: "unconfirmed",
            discovery: { status: "unknown" },
            drive: undefined,
          });
          journal = store.reopen();
          client.prepare(repairItem);
          const acknowledged = await client.flush(0);
          expect(acknowledged.answers).toEqual([
            { index: 0, status: "accepted", duplicate: true, receipt: repairItem.grant.requestId },
          ]);
          expect(client.view()).toMatchObject({
            pendingAnswers: 0,
            discovery: { status: "observed", frontier: [] },
            drive: { status: "reported", report: { state: "yielded" } },
          });
          expect(clientReplies).toBe(2); // empty frontier + yielded is not completion
        }
      } else if (first === "partial") {
        const available = discoveryCatalog;
        discoveryCatalog = new Map([[confirm.id, contracts[0]]]);
        const acceptedBeforeDiscovery = await advance([{ target: approvalItem, value: true }], 16)
          .result;
        expect(acceptedBeforeDiscovery.answers).toEqual([
          { index: 0, status: "accepted", duplicate: false, receipt: approvalItem.grant.requestId },
        ]);
        expect(reportOf(acceptedBeforeDiscovery)).toMatchObject({
          state: "child",
          reason: "waiting",
        });
        expect(acceptedBeforeDiscovery.discovery).toMatchObject({
          status: "unavailable",
          error: expect.stringContaining("Unknown interaction program"),
        });
        expect("frontier" in acceptedBeforeDiscovery.discovery).toBe(false);
        discoveryCatalog = available;
        journal = store.reopen();
        const partial = await advance([
          { target: approvalItem, value: true },
          { target: repairItem, value: { action: "released", evidence: "" } },
        ]).result;
        expect(partial.answers.map((receipt) => receipt.status)).toEqual(["accepted", "rejected"]);
        expect(partial.answers[0]).toMatchObject({ status: "accepted", duplicate: true });
        expect(reportOf(partial)).toMatchObject({ state: "child", reason: "waiting" });
        expect(frontierOf(partial).map((item) => item.grant)).toEqual([repairItem.grant]);
        expect(modelRequests).toHaveLength(1);
      } else if (first !== "together" && first !== "drive-failure") {
        const chosen = first === "confirm" ? approvalItem : repairItem;
        const remaining = first === "confirm" ? repairItem : approvalItem;
        expect((await answer(chosen, valueFor(chosen))).duplicate).toBe(false);
        journal = store.reopen();
        expect((await answer(chosen, valueFor(chosen))).duplicate).toBe(true);
        expect(await run().result).toMatchObject({ state: "child", reason: "waiting" });
        expect(modelRequests).toHaveLength(1);
        journal = store.reopen();
        expect((await frontier()).map((item) => item.grant)).toEqual([remaining.grant]);
        finalAnswers = [{ target: remaining, value: valueFor(remaining) }];
      }
      journal = store.reopen();
      if (client) {
        loseNextResponse = true;
      }
      const finalRun = client ? { result: client.flush(16) } : advance(finalAnswers);
      await Promise.race([peer.waitForRequests(4), finalRun.result]);
      expect(recordedEvents.map((event) => event.type)).toEqual([
        "assistant",
        "tool-batch-started",
        "tool-completed",
        "tool-completed",
      ]);
      expect(
        recordedEvents
          .filter((event) => event.type === "tool-completed")
          .map((event) => event.call.id),
      ).toEqual(["approval-call", "cleanup-call"]);
      expect(modelRequests[1]!.history.filter((message) => message.role === "tool")).toEqual([
        {
          role: "tool",
          toolCallId: "approval-call",
          name: "confirm",
          content: '"approved"',
          isError: false,
        },
        {
          role: "tool",
          toolCallId: "cleanup-call",
          name: "compensate",
          content: '"compensated"',
          isError: false,
        },
      ]);
      if (first === "drive-failure") {
        peer.fail("model-1", new Error("Model response lost"));
        const failed = await finalRun.result;
        expect(failed.answers.map((answer) => answer.status)).toEqual(["accepted", "accepted"]);
        expect(failed.drive).toMatchObject({
          status: "unconfirmed",
          error: expect.stringContaining("Model response lost"),
        });
        expect(frontierOf(failed)).toEqual([]);
        const count = acquired;
        journal = store.reopen();
        const retry = await advance(envelope).result;
        expect(
          retry.answers.map((answer) => answer.status === "accepted" && answer.duplicate),
        ).toEqual([true, true]);
        expect(reportOf(retry)).toMatchObject({ state: "occupied" });
        expect(frontierOf(retry)).toEqual([]);
        expect(acquired).toBe(count);
        expect(peer.requests).toHaveLength(4);
        return;
      }
      if (client) {
        await expect(client.flush(0)).rejects.toThrow("Client exchange in progress");
        expect(() => client.correct(repairItem, valueFor(repairItem))).toThrow(
          "Client exchange in progress",
        );
      }
      peer.reply("model-1", { status: 200, body: JSON.stringify(response("Both tasks settled.")) });
      if (client) {
        await expect(finalRun.result).rejects.toThrow("Client response lost");
        expect(client.view()).toMatchObject({
          delivery: "unconfirmed",
          pendingAnswers: 0,
          drive: undefined,
          discovery: { status: "unknown" },
        });
        journal = store.reopen();
        const acquiredBeforeRetry = acquired;
        const terminal = await client.flush(16);
        expect(terminal.answers).toEqual([]); // acknowledged inputs stay retired despite lost drive response
        expect(reportOf(terminal)).toEqual({ state: "completed", value: "Both tasks settled." });
        expect(client.view()).toMatchObject({
          delivery: "received",
          pendingAnswers: 0,
          discovery: { status: "observed", frontier: [] },
        });
        client.prepare(approvalItem);
        client.prepare(repairItem);
        expect(client.view().pendingAnswers).toBe(0);
        expect(clientReplies).toBe(2);
        expect(acquired).toBe(acquiredBeforeRetry);
        expect(peer.requests).toHaveLength(4);
        return;
      }
      // Simulate losing the envelope after the server has completed the model turn.
      await expect(
        finalRun.result.then(() => {
          throw new Error("Edge response lost");
        }),
      ).rejects.toThrow("Edge response lost");
      journal = store.reopen();
      const terminalAcquisitions = acquired;
      const beforeRetry = await start(() => readJournal(journal)).result;
      const intentBefore = await start(() => store.activations.read()).result;
      expect(await frontier()).toEqual([]);
      // No current interaction is needed to recover the original definition/grant.
      const terminalBeforeBinding = await start(bindingState).result;
      const terminalBinding = await start(() =>
        resolveToolExecution(toolExecutions(journal), approvalItem.execution),
      ).result;
      expect(terminalBinding.tool).toBe(confirm);
      expect(terminalBinding.interactions).not.toBe(approvalBinding.interactions);
      const terminalRequest = await start(() =>
        terminalBinding.interactions.request(approvalItem.grant),
      ).result;
      expect(terminalRequest.effect).toBe(approval.id);
      // Old connection capabilities are not silently redirected to the reopened store.
      await expect(
        start(() => approvalBinding.interactions.request(approvalItem.grant)).result,
      ).rejects.toThrow();
      expect(await start(bindingState).result).toEqual(terminalBeforeBinding);
      expect(acquired).toBe(terminalAcquisitions);
      const retry = await advance(envelope).result;
      expect(retry.answers).toEqual(
        envelope.map((answer, index) => ({
          index,
          status: "accepted",
          duplicate: true,
          receipt: answer.target.grant.requestId,
        })),
      );
      expect(reportOf(retry)).toEqual({ state: "completed", value: "Both tasks settled." });
      expect(frontierOf(retry)).toEqual([]);
      const conflict = await advance([
        { target: repairItem, value: { action: "released", evidence: "conflict" } },
        { target: approvalItem, value: true },
      ]).result;
      expect(conflict.answers.map((receipt) => receipt.status)).toEqual([
        "unconfirmed",
        "accepted",
      ]);
      expect(reportOf(conflict)).toEqual(reportOf(retry));
      expect(await start(() => readJournal(journal)).result).toEqual(beforeRetry);
      expect(await start(() => store.activations.read()).result).toEqual(intentBefore);
      expect(await frontier()).toEqual([]);
      expect(await run().result).toEqual({ state: "completed", value: "Both tasks settled." });
      expect(acquired).toBe(terminalAcquisitions);
      expect(recordedEvents.map((event) => event.type)).toEqual([
        "assistant",
        "tool-batch-started",
        "tool-completed",
        "tool-completed",
        "assistant",
      ]);
      const accepted = await start(() => readJournal(journal)).result;
      expect(
        accepted.history
          .filter((entry) => entry.request.effect === progress.id)
          .map((entry) => entry.request.input),
      ).toEqual(recordedEvents);
      expect(peer.requests.map((request) => request.id).sort()).toEqual(
        [inspect.id, release.id, "model-0", "model-1"].sort(),
      );
    },
  );
});
// Application authoring check: identical complete wiring, three interaction shapes.
forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  it.each(["one", "ten", "asymmetric", "denied", "invalid-sample"] as const)(
    `${runtime.name}: file chat application advances and reopens (%s)`,
    async (scenario) => {
      const peer = createProtocolRig();
      const store = createSqliteJournalRig<string, CapabilityRequest, unknown, string, unknown, Y>({
        program: fileChatProgram,
        equals: isDeepStrictEqual,
      });
      onTestFinished(() => store.close());
      let journal = store.open();
      let acquisitions = 0;
      function task<T>(work: Work<T, Y>) {
        const result = runtime.start(work);
        void result.result.catch(() => undefined);
        onTestFinished(() => result.cancel());
        return result;
      }
      function bind() {
        return createFileChat(runtime, journal, {
          matches: isDeepStrictEqual,
          recovery: <R>(
            options: Parameters<
              typeof createHostedRecovery<R, CapabilityRequest, Y, unknown, string>
            >[1],
          ) =>
            createHostedRecovery<R, CapabilityRequest, Y, unknown, string>(runtime, {
              ...options,
              *acquire() {
                acquisitions++;
                return yield* options.acquire();
              },
            }),
          sampling: {
            *sample(request) {
              const reply = yield* runtime.fromPromise((signal) =>
                peer.send(
                  { id: `sample-${request.round}`, token: JSON.stringify(request) },
                  signal,
                ),
              );
              if (scenario === "denied") {
                return {
                  ok: false,
                  error: { code: "budget", message: "Sampling budget exhausted" },
                };
              }
              return {
                ok: true,
                value: {
                  model: scenario === "invalid-sample" ? { ...planner, id: "" } : planner,
                  response: responseDataSchema.parse(JSON.parse(reply.body)),
                },
              };
            },
          },
        });
      }
      let chat = bind();
      function reopen() {
        journal = store.reopen();
        chat = bind();
      }
      function observe() {
        return task(function* () {
          const stream = yield* chat.interactions();
          const items: ToolInteraction[] = [];
          while (true) {
            const item = yield* stream.next();
            if (item.done) {
              return items;
            }
            items.push(item.value);
          }
        }).result;
      }
      function answer(items: readonly ToolInteraction[]) {
        return task(function* () {
          for (const item of items) {
            yield* chat.answer(
              { execution: item.execution, grant: item.grant },
              { ok: true, value: `answer:${item.grant.requestId}` },
            );
          }
        }).result;
      }
      await expect(task(() => chat.run()).result).rejects.toThrow("requires admitted input");
      expect(peer.requests).toHaveLength(0);
      await task(() => journal.admit(fileChatProgram, { prompt: "Read the requested files." }))
        .result;
      const first = task(() => chat.run()); // No reader is mounted.
      await Promise.race([peer.waitForRequests(1), first.result]);
      const modes =
        scenario === "asymmetric"
          ? ["single", "followup", "cleanup"]
          : Array.from({ length: scenario === "ten" ? 10 : 1 }, () => "single");
      const initial: Response = {
        ...response("Reading files"),
        message: {
          role: "assistant",
          content: modes.map((mode, index) => ({
            type: "tool-call",
            toolCall: {
              id: `file-${index}`,
              name: "read_file",
              input: { path: `file-${index}.txt`, mode },
              thoughtSignature: null,
            },
          })),
        },
      };
      peer.reply("sample-0", { status: 200, body: JSON.stringify(initial) });
      if (scenario === "denied" || scenario === "invalid-sample") {
        await expect(first.result).rejects.toThrow(
          scenario === "denied" ? "Sampling budget exhausted" : "schema",
        );
        const accepted = await task(() => readJournal(journal)).result;
        expect(accepted.history).toHaveLength(scenario === "denied" ? 1 : 0);
        if (scenario === "denied") {
          expect(accepted.history[0]!.outcome).toMatchObject({
            ok: true,
            value: { ok: false, error: { code: "budget" } },
          });
        }
        reopen();
        if (scenario === "denied") {
          await expect(task(() => chat.run()).result).rejects.toThrow("Sampling budget exhausted");
        } else {
          expect(await task(() => chat.run()).result).toMatchObject({ state: "occupied" });
        }
        expect(peer.requests).toHaveLength(1);
        expect(await observe()).toEqual([]);
        return;
      }
      expect(await first.result).toMatchObject({ state: "child", reason: "waiting" });
      // A reader disconnects after one observation. It owns no execution work.
      const partial = await task(function* () {
        const stream = yield* chat.interactions();
        return yield* stream.next();
      }).result;
      expect(partial.done).toBe(false);
      reopen();
      const acquired = acquisitions;
      const questions = await observe();
      expect(acquisitions).toBe(acquired);
      expect(questions).toHaveLength(modes.length);
      expect(peer.requests).toHaveLength(1);
      let followupReceipt: string | undefined;
      if (scenario === "asymmetric") {
        const cleanup = questions.find((item) => item.scope?.phase === "cleanup")!;
        expect(cleanup.input).toEqual({ path: "file-2.txt", step: "repair" });
        await answer(questions.filter((item) => item !== cleanup));
        reopen();
        expect(await task(() => chat.run()).result).toMatchObject({
          state: "child",
          reason: "waiting",
        });
        const next = await observe();
        expect(next).toHaveLength(2);
        const followup = next.find((item) => item.execution !== cleanup.execution)!;
        expect(followup.input).toEqual({ path: "file-1.txt", step: "confirm" });
        expect(next.find((item) => item.execution === cleanup.execution)?.grant).toEqual(
          cleanup.grant,
        );
        expect(next.some((item) => item.execution === questions[0]!.execution)).toBe(false);
        expect(peer.requests).toHaveLength(1); // Model cannot continue past the unfinished batch.
        followupReceipt = followup.grant.requestId;
        await answer([followup]);
        reopen();
        expect(await task(() => chat.run()).result).toMatchObject({
          state: "child",
          reason: "waiting",
        });
        const remaining = await observe();
        expect(remaining).toHaveLength(1);
        expect(remaining[0]!.grant).toEqual(cleanup.grant);
        await answer(remaining);
      } else {
        await answer(questions);
      }
      expect(peer.requests).toHaveLength(1); // Answering is not driving.
      reopen();
      expect(await observe()).toEqual([]); // Empty questions still require advancement.
      const last = task(() => chat.run());
      await Promise.race([peer.waitForRequests(2), last.result]);
      const request = JSON.parse(peer.requests[1]!.token) as ChatLoopRequest;
      const results = request.history.filter((message) => message.role === "tool");
      expect(results.map((message) => message.toolCallId)).toEqual(
        modes.map((_, index) => `file-${index}`),
      );
      expect(results.every((message) => !message.isError)).toBe(true);
      expect(results.map((message) => message.content)).toEqual(
        modes.map((mode, index) => {
          if (mode === "cleanup") {
            return "cleaned";
          }
          const original = questions.find(
            (item) => z.object({ path: z.string() }).parse(item.input).path === `file-${index}.txt`,
          )!;
          const contents = `answer:${original.grant.requestId}`;
          return mode === "followup" ? `${contents}: answer:${followupReceipt}` : contents;
        }),
      );
      peer.reply("sample-1", { status: 200, body: JSON.stringify(response("Files handled.")) });
      expect(await last.result).toEqual({ state: "completed", value: "Files handled." });
      reopen();
      const terminalAcquisitions = acquisitions;
      expect(await task(() => chat.run()).result).toEqual({
        state: "completed",
        value: "Files handled.",
      });
      expect(await observe()).toEqual([]);
      expect(acquisitions).toBe(terminalAcquisitions);
      expect(peer.requests).toHaveLength(2);
    },
  );
});
forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  it(`${runtime.name}: conversation admits a second turn from accepted history across reopen`, async () => {
    const database = createSqliteDatabaseRig();
    onTestFinished(() => database.close());
    const peer = createProtocolRig();
    let acquisitions = 0;
    let failReservation = true;
    function task<T>(work: Work<T, Y>) {
      const result = runtime.start(work);
      void result.result.catch(() => undefined);
      onTestFinished(() => result.cancel());
      return result;
    }
    function assemble(conversation = "conversation-1") {
      return createFileConversation(
        runtime,
        database.database,
        conversation,
        {
          matches: isDeepStrictEqual,
          recovery: <R>(
            options: Parameters<
              typeof createHostedRecovery<R, CapabilityRequest, Y, unknown, string>
            >[1],
          ) =>
            createHostedRecovery<R, CapabilityRequest, Y, unknown, string>(runtime, {
              ...options,
              *acquire() {
                acquisitions++;
                return yield* options.acquire();
              },
            }),
          sampling: {
            *sample(request) {
              const reply = yield* runtime.fromPromise((signal) =>
                peer.send(
                  {
                    id: `conversation-model-${peer.requests.length}`,
                    token: JSON.stringify(request),
                  },
                  signal,
                ),
              );
              return {
                ok: true,
                value: {
                  model: planner,
                  response: responseDataSchema.parse(JSON.parse(reply.body)),
                },
              };
            },
          },
        },
        function* () {
          if (failReservation) {
            failReservation = false;
            throw new Error("Lost owner after reservation");
          }
        },
      );
    }
    let conversation = assemble();
    const firstCommand = { command: "message-1", prompt: "Read the first file.", after: null };
    await expect(task(() => conversation.submit(firstCommand)).result).rejects.toThrow(
      "after reservation",
    );
    expect(conversation.turns()).toHaveLength(1);
    expect(peer.requests).toHaveLength(0);
    database.reopen();
    conversation = assemble();
    const first = await task(() => conversation.submit(firstCommand)).result;
    expect(first).toMatchObject({ ordinal: 1, duplicate: true });
    expect(conversation.turns()).toHaveLength(1);
    await expect(
      task(() =>
        conversation.submit({ command: "message-2", prompt: "Too early", after: first.execution }),
      ).result,
    ).rejects.toThrow("not completed");
    await expect(
      task(() => conversation.submit({ ...firstCommand, prompt: "Different" })).result,
    ).rejects.toThrow("different input");
    expect(() => assemble("another-conversation").turn(first.execution)).toThrow(
      "outside this conversation",
    );
    const running = task(() => conversation.turn(first.execution).run());
    await Promise.race([peer.waitForRequests(1), running.result]);
    peer.reply("conversation-model-0", {
      status: 200,
      body: JSON.stringify({
        ...response("Read the file"),
        message: {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCall: {
                id: "read-first",
                name: "read_file",
                input: { path: "first.txt", mode: "single" },
                thoughtSignature: null,
              },
            },
          ],
        },
      }),
    });
    expect(await running.result).toMatchObject({ state: "child", reason: "waiting" });
    database.reopen();
    conversation = assemble();
    const count = acquisitions;
    const question = await task(function* () {
      const stream = yield* conversation.turn(first.execution).interactions();
      const item = yield* stream.next();
      if (item.done) {
        throw new Error("Missing file question");
      }
      return item.value;
    }).result;
    expect(acquisitions).toBe(count);
    await task(() =>
      conversation
        .turn(first.execution)
        .answer(
          { execution: question.execution, grant: question.grant },
          { ok: true, value: "accepted first file" },
        ),
    ).result;
    const finishing = task(() => conversation.turn(first.execution).run());
    await Promise.race([peer.waitForRequests(2), finishing.result]);
    peer.reply("conversation-model-1", {
      status: 200,
      body: JSON.stringify(response("First turn finished.")),
    });
    expect(await finishing.result).toMatchObject({ state: "completed" });
    const predecessor = await task(() => conversation.read(first.execution)).result;
    if (predecessor.status !== "completed") {
      throw new Error("First turn did not finish");
    }
    expect(predecessor.value.history.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(predecessor.value.history[2]).toMatchObject({
      toolCallId: "read-first",
      content: "accepted first file",
    });
    database.reopen();
    conversation = assemble();
    const secondCommand = {
      command: "message-2",
      prompt: "Now summarize that file.",
      after: first.execution,
    };
    // Lose the response after both reservation and journal admission succeeded.
    await expect(
      Promise.all([
        task(() => conversation.submit(secondCommand)).result,
        task(() => conversation.submit(secondCommand)).result,
      ]).then(([submitted, repeated]) => {
        expect(submitted.execution).toBe(repeated.execution);
        expect([submitted.duplicate, repeated.duplicate].sort()).toEqual([false, true]);
        throw new Error("Lost submit response");
      }),
    ).rejects.toThrow("Lost submit response");
    database.reopen();
    conversation = assemble();
    const second = await task(() => conversation.submit(secondCommand)).result;
    expect(second).toMatchObject({ ordinal: 2, duplicate: true });
    expect(second.execution).not.toBe(first.execution);
    expect(conversation.turns()).toHaveLength(2);
    expect(await task(() => conversation.submit(firstCommand)).result).toMatchObject({
      execution: first.execution,
      ordinal: 1,
      duplicate: true,
    });
    await expect(
      task(() =>
        conversation.submit({ command: "other-message", prompt: "Fork", after: first.execution }),
      ).result,
    ).rejects.toThrow("Stale conversation predecessor");
    const next = task(() => conversation.turn(second.execution).run());
    await Promise.race([peer.waitForRequests(3), next.result]);
    const request = JSON.parse(peer.requests[2]!.token) as ChatLoopRequest;
    expect(request.round).toBe(0);
    expect(request.history).toEqual([
      ...predecessor.value.history,
      { role: "user", content: secondCommand.prompt },
    ]);
    peer.reply("conversation-model-2", {
      status: 200,
      body: JSON.stringify(response("Summary complete.")),
    });
    expect(await next.result).toMatchObject({ state: "completed" });
    database.reopen();
    conversation = assemble();
    const terminalAcquisitions = acquisitions;
    const original = await task(() => conversation.read(first.execution)).result;
    expect(original).toMatchObject({
      status: "completed",
      revision: predecessor.revision,
      value: predecessor.value,
      admission: predecessor.admission,
    });
    expect(original.history.end).toEqual(predecessor.history.end);
    expect(await task(() => conversation.turn(second.execution).run()).result).toMatchObject({
      state: "completed",
    });
    expect(acquisitions).toBe(terminalAcquisitions);
    expect(peer.requests).toHaveLength(3);
    expect(conversation.turns()).toHaveLength(2);
  });
});
