import type { Runtime } from "@sweatpan.ts/runtime";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { EffectDefinition } from "@sweatpan.ts/core";
import {
  createToolApplication,
  type ToolDefinition,
  type ToolApplicationOptions,
} from "@sweatpan.ts/tools";
import type { StandaloneHttpContext, StandaloneView, QuestionRecord } from "./contracts.ts";
import { parseStandaloneAnswer } from "./protocol.ts";

/** Standalone example policy over shared scoped commands and journal readers. The outer route
 * owns authentication. Scoped native interruption is not durable cancellation.
 * POST admits {input}; PUT accepts {grant,outcome} then advances; GET never advances. */
export function createStandaloneHandlers<
  S extends StandardSchemaV1,
  D extends Record<string, EffectDefinition>,
  L extends Record<string, EffectDefinition>,
  R,
  Y,
>(
  runtime: Runtime<Y>,
  tool: ToolDefinition<S, D, L, R>,
  options: ToolApplicationOptions<
    StandardSchemaV1.InferInput<S>,
    StandardSchemaV1.InferOutput<S>,
    NoInfer<R>,
    Y
  >,
) {
  const application = createToolApplication(runtime, tool, options);
  function observe(execution: string) {
    return runtime.composition.scoped(function* () {
      const journal = yield* options.open(execution);
      if (journal.id !== execution) {
        throw new Error("Wrong standalone execution");
      }
      const { history, ...snapshot } = yield* journal.read();
      if (snapshot.program !== tool.id) {
        throw new Error("Wrong standalone program");
      }
      const declared = new Set(Object.values(tool.elicits).map((effect) => effect.id));
      const questions: QuestionRecord[] = [];
      for (let offset = 0; offset < history.end.position; ) {
        const page = yield* history.read(offset, 128);
        if (!page.length) {
          throw new Error("Incomplete tool question history");
        }
        for (const entry of page) {
          if (!declared.has(entry.request.effect)) {
            continue;
          }
          const base = {
            sequence: entry.sequence,
            effect: entry.request.effect,
            input: entry.request.input,
          };
          if (!entry.outcome.ok) {
            questions.push({ ...base, state: "failed", error: entry.outcome.error });
          } else {
            const value = entry.outcome.value;
            if (!value || typeof value !== "object" || !("ok" in value)) {
              throw new Error("Invalid accepted tool Outcome");
            }
            if (value.ok === true && "value" in value) {
              questions.push({
                ...base,
                state: "answered",
                outcome: { ok: true, value: value.value },
              });
            } else if (value.ok === false && "error" in value) {
              questions.push({
                ...base,
                state: "answered",
                outcome: { ok: false, error: value.error },
              });
            } else {
              throw new Error("Invalid accepted tool Outcome");
            }
          }
        }
        offset = page[page.length - 1]!.sequence + 1;
      }
      if (
        snapshot.status === "running" &&
        snapshot.pending &&
        declared.has(snapshot.pending.request.effect)
      ) {
        questions.push({
          sequence: snapshot.pending.sequence,
          ...snapshot.pending.request,
          state:
            snapshot.interaction?.state === "waiting"
              ? "waiting"
              : snapshot.interaction?.state === "invalidated"
                ? "cancelled"
                : "blocked",
        });
      } else if (
        snapshot.cancellation &&
        declared.has(snapshot.cancellation.request.effect) &&
        !questions.some((question) => question.sequence === snapshot.cancellation!.position)
      ) {
        questions.push({
          sequence: snapshot.cancellation.position,
          ...snapshot.cancellation.request,
          state: "cancelled",
        });
      }
      return { ...snapshot, questions };
    });
  }
  async function handle(
    { request, params }: StandaloneHttpContext,
    method: "GET" | "POST" | "PUT",
  ) {
    const execution = params.execution;
    if (!/^[a-zA-Z0-9_-]{1,200}$/.test(execution)) {
      return Response.json({ error: "invalid-execution-id" }, { status: 400 });
    }
    const origin = request.headers.get("origin");
    if (method !== "GET" && origin !== null && origin !== new URL(request.url).origin) {
      return Response.json({ error: "foreign-origin" }, { status: 403 });
    }
    let input: StandardSchemaV1.InferInput<S> | undefined;
    let answer: ReturnType<typeof parseStandaloneAnswer> | undefined;
    if (method !== "GET") {
      try {
        const data: unknown = await request.json();
        if (method === "PUT") {
          answer = parseStandaloneAnswer(data);
        } else {
          if (!data || typeof data !== "object" || !Object.hasOwn(data, "input")) {
            throw new Error("Missing input");
          }
          // Public admission validates this wire input against the original schema.
          input = (data as { input: StandardSchemaV1.InferInput<S> }).input;
        }
      } catch {
        return Response.json({ error: "invalid-command" }, { status: 400 });
      }
    }
    const value = await runtime.start(() =>
      runtime.withSignal(request.signal, function* () {
        let accepted: { receipt: string; duplicate: boolean } | undefined;
        if (method === "POST") {
          yield* application.operations.start(execution, input as StandardSchemaV1.InferInput<S>);
        }
        if (method === "PUT") {
          const result = yield* application.operations.answer(
            execution,
            answer!.grant,
            answer!.outcome,
          );
          accepted = { receipt: result.entry.receipt, duplicate: result.duplicate };
          yield* application.operations.run(execution);
        }
        const snapshot = yield* observe(execution);
        if (!snapshot.admission) {
          return undefined;
        }
        const base = {
          version: "tool-http/1" as const,
          execution,
          program: snapshot.program,
          questions: snapshot.questions,
        };
        let view: StandaloneView<R>;
        if (snapshot.status === "completed") {
          view = { ...base, status: "completed", value: snapshot.value };
        } else if (snapshot.status === "cancelled") {
          view = { ...base, status: "cancelled", reason: snapshot.reason };
        } else if (snapshot.pending && snapshot.interaction?.state === "waiting") {
          view = {
            ...base,
            status: "waiting",
            question: {
              effect: snapshot.pending.request.effect,
              input: snapshot.pending.request.input,
              grant: snapshot.interaction.grant,
            },
          };
        } else {
          view = { ...base, status: "running" };
        }
        return accepted ? { ...accepted, view } : view;
      }),
    ).result;
    return value === undefined
      ? Response.json({ error: "not-found" }, { status: 404 })
      : Response.json(value, { headers: { "Cache-Control": "no-store" } });
  }
  return {
    GET: (context: StandaloneHttpContext) => handle(context, "GET"),
    POST: (context: StandaloneHttpContext) => handle(context, "POST"),
    PUT: (context: StandaloneHttpContext) => handle(context, "PUT"),
    ANY: () => new Response(null, { status: 405, headers: { Allow: "GET, POST, PUT" } }),
  };
}
