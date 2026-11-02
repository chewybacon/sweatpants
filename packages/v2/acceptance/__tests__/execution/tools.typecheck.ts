import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Operation, Outcome } from "@standard-durability/core";
import { defineEffect, type CapabilityRequest } from "@sweatpan.ts/core";
import { createEffectCapabilities, type Hosting } from "@sweatpan.ts/hosting";
import type { OwnedJournal, JournalReader } from "@sweatpan.ts/durable";
import type { Runtime, Stream } from "@sweatpan.ts/runtime";
import {
  defineTool,
  createToolInteractionStream,
  type ToolInteraction,
  resolveToolExecution,
  type ToolExecution,
  type ToolExecutionResolution,
  admitTool,
  installElicitHandlers,
  projectToolContract,
  type ToolContract,
  type ElicitHandlers,
} from "@sweatpan.ts/tools";

// Non-executed consumer checked against source and emitted declarations.
export function toolInference<Y>(
  runtime: Runtime<Y>,
  schema: StandardSchemaV1<string, { text: string }>,
) {
  const question = defineEffect({ key: "question", context: schema, response: schema });
  const tool = defineTool("inspect")
    .parameters(schema)
    .elicits({ question })
    .execute(function* (input, ctx) {
      const text: string = yield* ctx.await(
        async (signal) => {
          const aborted: boolean = signal.aborted;
          return aborted ? "aborted" : input.text;
        },
        { record: {} },
      );
      // @ts-expect-error Unrecorded Promise execution is deferred.
      ctx.await(async () => input.text);
      // @ts-expect-error A factory is required so recording controls execution.
      ctx.await(Promise.resolve(input.text), { record: {} });
      const reply = yield* ctx.elicit("question", text);
      // @ts-expect-error Only declared elicitation keys are accepted.
      ctx.elicit("missing", text);
      // @ts-expect-error Elicitation callers supply schema input.
      ctx.elicit("question", { text });
      // @ts-expect-error No capabilities have been declared.
      ctx.capabilities.read(text);
      yield* ctx.scope.ensure(function* () {});
      return { text, reply };
    });
  type Result = { text: string; reply: Outcome<{ text: string }, unknown> };
  const call: Operation<Outcome<Result, never>, CapabilityRequest> = tool.call("query");
  // @ts-expect-error Caller input is distinct from normalized body input.
  tool.call({ text: "query" });
  // @ts-expect-error Result inference survives the public builder.
  const wrong: Operation<Outcome<number, never>, CapabilityRequest> = tool.call("query");
  const effects = createEffectCapabilities(runtime, "tools");
  const grant = effects.grant({ tool }, { record: true });
  const granted: Operation<Outcome<Result, never>, CapabilityRequest> = grant.capabilities.tool(
    "query",
  );
  defineTool("native")
    .parameters(schema)
    // @ts-expect-error Native host work is not a tool-body instruction.
    .execute(function* () {
      return yield* runtime.fromPromise(async () => 1);
    });
  return { call, wrong, granted };
}

export function toolAdmissionInference<Y>(
  runtime: Runtime<Y>,
  schema: StandardSchemaV1<string, { query: string }>,
  journal: OwnedJournal<unknown, unknown, unknown, unknown, unknown, Y>,
) {
  const tool = defineTool("admission")
    .parameters(schema)
    .execute(function* (input) {
      return input.query;
    });
  const admitted: Operation<{ query: string }, Y> = admitTool(runtime, tool, journal, "query");
  // @ts-expect-error Admission takes caller input, not the normalized output.
  admitTool(runtime, tool, journal, { query: "query" });
  // @ts-expect-error The admitted result is schema output, not schema input.
  const wrong: Operation<string, Y> = admitTool(runtime, tool, journal, "query");
  return { admitted, wrong };
}

export function elicitHandlerInference<Y>(
  runtime: Runtime<Y>,
  host: Hosting<unknown, CapabilityRequest, unknown, string, Y>,
  schema: StandardSchemaV1<string, { text: string }>,
) {
  const effects = createEffectCapabilities(runtime, "typed-elicit");
  const question = defineEffect({ key: "typed-question", context: schema, response: schema });
  const tool = defineTool("typed-tool")
    .parameters(schema)
    .elicits({ question })
    .execute(function* () {});
  installElicitHandlers(host, effects, tool, {
    *question(context) {
      const text: string = context.text;
      return { ok: true, value: text };
    },
  });
  installElicitHandlers(host, effects, tool, {
    // @ts-expect-error Only declared elicitation keys are accepted.
    *missing() {
      return { ok: true, value: "answer" };
    },
  });
  installElicitHandlers(host, effects, tool, {
    // @ts-expect-error Handler receives normalized context, not caller input.
    *question(context: string) {
      return { ok: true, value: context };
    },
  });
  installElicitHandlers(host, effects, tool, {
    // @ts-expect-error Success supplies response-schema input, not transformed output.
    *question() {
      return { ok: true, value: { text: "answer" } };
    },
  });
  installElicitHandlers(host, effects, tool, {
    // @ts-expect-error Handlers must return explicit authored Outcomes.
    *question() {
      return "answer";
    },
  });
  return installElicitHandlers(host, effects, tool);
}

// Independently compiled against both development source and built package declarations.
export function toolContractInference(schema: StandardSchemaV1<string, { text: string }>) {
  const read = defineEffect({ key: "contract.read", context: schema }, function* (input) {
    return input.text
      ? { ok: true as const, value: input.text }
      : { ok: false as const, error: "empty" as const };
  });
  const question = defineEffect({ key: "contract.question", context: schema, response: schema });
  const tool = defineTool("contract-tool")
    .parameters(schema)
    .capabilities({ read })
    .elicits({ question })
    .execute(function* (input) {
      return { length: input.text.length };
    });
  const contract = projectToolContract(tool);
  const publicView: ToolContract<
    typeof schema,
    { read: typeof read },
    { question: typeof question },
    { length: number }
  > = contract;
  const call: Operation<Outcome<{ length: number }, never>, CapabilityRequest> = contract.call(
    "query",
  );
  const effect: Operation<
    Outcome<string, "empty">,
    CapabilityRequest
  > = contract.capabilities.read.call("query");
  const reply: Operation<
    Outcome<{ text: string }, unknown>,
    CapabilityRequest
  > = contract.elicits.question.call("question");
  const parameters: typeof schema = contract.context;
  const response: StandardSchemaV1<string, { text: string }> | undefined =
    contract.elicits.question.response;
  // @ts-expect-error Projected contracts expose no body.
  void contract.body;
  // @ts-expect-error Nested defaults are stripped, not merely hidden by a broad declaration.
  void contract.capabilities.read.implementation;
  // @ts-expect-error Only declared aliases survive projection.
  void contract.elicits.missing;
  // @ts-expect-error Callers supply raw schema input, not normalized output.
  contract.call({ text: "query" });
  // @ts-expect-error The inferred result survives projection.
  const wrong: Operation<Outcome<number, never>, CapabilityRequest> = contract.call("query");
  // @ts-expect-error Projected maps are readonly.
  contract.capabilities.read = read;
  const handlers: ElicitHandlers<typeof contract.elicits, never> = {
    *question(context) {
      return { ok: true, value: context.text };
    },
  };
  const invalid: ElicitHandlers<typeof contract.elicits, never> = {
    // @ts-expect-error Answers supply response-schema input; normalized output belongs to the Guest.
    *question() {
      return { ok: true, value: { text: "yes" } };
    },
  };
  const empty = projectToolContract(
    defineTool("empty-contract")
      .parameters(schema)
      .execute(function* () {
        return 1;
      }),
  );
  // @ts-expect-error Empty declaration groups stay empty.
  void empty.capabilities.read;
  return { publicView, call, effect, reply, parameters, response, wrong, handlers, invalid, empty };
}

// Resolution preserves the catalog's exact definition type, transport error and runtime yield.
export function resolveToolConsumer<Tool extends { readonly id: string }, E, Y>(
  resolution: ToolExecutionResolution<Tool, E, Y>,
  execution: string,
): Operation<ToolExecution<Tool, E, Y>, Y> {
  return resolveToolExecution(resolution, execution);
}

export function* resolvedToolSurface<E, Y>(
  base: Omit<ToolExecutionResolution<{ readonly id: string }, E, Y>, "programs">,
  schema: StandardSchemaV1<string, string>,
  execution: string,
) {
  const approval = defineEffect({ key: "resolved.approval", context: schema, response: schema });
  const tool = defineTool("resolved-tool")
    .parameters(schema)
    .elicits({ approval })
    .execute(function* (input, ctx) {
      return yield* ctx.elicit("approval", input);
    });
  const bound = yield* resolveToolExecution(
    { ...base, programs: new Map([[tool.id, tool]]) },
    execution,
  );
  const original: typeof tool = bound.tool;
  const response: StandardSchemaV1<string, string> | undefined =
    bound.tool.elicits.approval.response;
  // @ts-expect-error Ingress does not expose registration authority.
  void bound.interactions.register;
  // @ts-expect-error Ingress does not expose journal mutation or execution.
  void bound.journal;
  return { original, response };
}

export function* toolInteractionConsumer<Y>(
  runtime: Runtime<Y>,
  reader: JournalReader<unknown, unknown, unknown, unknown, unknown, Y>,
  schema: StandardSchemaV1<string, string>,
) {
  const question = defineEffect({ key: "discovery.question", context: schema, response: schema });
  const tool = defineTool("discovery-tool")
    .parameters(schema)
    .elicits({ question })
    .execute(function* (input, ctx) {
      return yield* ctx.elicit("question", input);
    });
  const contract = projectToolContract(tool);
  const source: Stream<ToolInteraction, void, Y> = createToolInteractionStream(
    runtime.composition,
    reader,
    new Map([[contract.id, contract]]),
  );
  const stream = yield* source;
  const next = yield* stream.next();
  if (!next.done) {
    const schema: StandardSchemaV1 | undefined = next.value.declaration.response;
    // @ts-expect-error Dynamic program lookup does not statically decode the payload.
    const input: string = next.value.input;
    // @ts-expect-error Discovery does not grant answer authority.
    void next.value.interactions;
    return { schema, input };
  }
  return undefined;
}
