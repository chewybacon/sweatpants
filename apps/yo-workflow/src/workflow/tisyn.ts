import { randomContract, randomValue, randomParameters } from "./random.ts";
import { JSON_VALUE_OPERATION, evaluateJsonValue } from "./json-values.ts";
import kernelBundle from "./evaluation/generated/kernel-source.json" with { type: "json" };
import { decisionRequestSchema, type DecisionBinding } from "@sweatpants/model-decision";
import { decisionContract, type DecisionContext } from "./decisions.ts";
import type { Operation } from "effection";
import { createDurableTool, type AnyToolContract } from "@sweatpants/agent-sdk";
import type { DurableProgramContext, DurableTool } from "@sweatpants/durable-execution";
import { assertJson, canonicalJson, sha256, type Json } from "@sweatpants/foundation";
import { validateAuthoredSchema } from "@sweatpants/foundation/parser";
import { z } from "zod";

import { MAX_SOURCE_LENGTH, parseTisynSource } from "./source.ts";
import { createEvaluation, EVALUATION_LIMITS } from "./evaluation/port.ts";
import type { TisynExpr } from "@tisyn/ir";
import packageJson from "../../package.json" with { type: "json" };

import {
  samplingContract,
  samplingIdentity,
  samplingParameters,
  sampleCompletion,
  type SamplingContext,
} from "./sampling.ts";

export type BoundTool = DurableTool & AnyToolContract;
const structural = new Set([
  "let",
  "seq",
  "if",
  "get",
  "add",
  "sub",
  "mul",
  "div",
  "mod",
  "neg",
  "gt",
  "gte",
  "lt",
  "lte",
  "eq",
  "neq",
  "and",
  "or",
  "not",
  "construct",
  "array",
  "concat",
  "throw",
  "call",
  "while",
]);
const reserved = new Set([
  JSON_VALUE_OPERATION,
  "try",
  "concat-arrays",
  "merge-objects",
  "all",
  "race",
  "scope",
  "spawn",
  "join",
  "resource",
  "provide",
  "timebox",
]);
const MAX_PROGRAM_VALUES = 4000;
const unsafeKeys = new Set(["__proto__", "prototype", "constructor"]);
/** Fail closed before any tool can run, including effects inside unselected branches. */
export function parseProgram(
  source: string,
  tools: readonly BoundTool[],
  sampling = false,
  decisions = false,
  operations: readonly string[] = [],
): TisynExpr {
  const ir = parseTisynSource(source);
  const names = new Set([
    ...tools.map((tool) => tool.name),
    JSON_VALUE_OPERATION,
    "random",
    ...operations,
  ]);
  if (sampling) {
    names.add("sample");
  }
  if (decisions) {
    names.add("decision");
  }
  const pending: unknown[] = [ir];
  let nodes = 0;
  while (pending.length) {
    const value = pending.pop();
    if (++nodes > MAX_PROGRAM_VALUES) {
      throw new Error(`Tisyn program exceeds ${MAX_PROGRAM_VALUES} values`);
    }
    if (value === null || typeof value !== "object") {
      continue;
    }
    if (Array.isArray(value)) {
      if (value.length > 64) {
        throw new Error("Tisyn array exceeds 64 items");
      }
      pending.push(...value);
      continue;
    }
    const node = value as Record<string, unknown>;
    if (node.tisyn === "eval") {
      if (typeof node.id !== "string" || (!structural.has(node.id) && !names.has(node.id))) {
        throw new Error(`Unsupported Tisyn operation: ${String(node.id)}`);
      }
      if (structural.has(node.id)) {
        const data = node.data as Record<string, unknown> | null;
        const fields = data?.expr;
        if (
          !data ||
          data.tisyn !== "quote" ||
          !fields ||
          typeof fields !== "object" ||
          Array.isArray(fields) ||
          "tisyn" in fields
        ) {
          throw new Error(
            "Structural operations require static quoted fields; computed IR is not supported",
          );
        }
      }
    }
    for (const [key, child] of Object.entries(node)) {
      if (
        unsafeKeys.has(key) ||
        (key === "key" && typeof child === "string" && unsafeKeys.has(child))
      ) {
        throw new Error("Prototype-related fields are outside this spike's profile");
      }
      pending.push(child);
    }
  }
  assertJson(ir);
  return ir;
}

/** Only descriptors cross into Sweatpants. Each tool remains a pinned child program. */
export function* executeProgram(
  source: string,
  tools: readonly BoundTool[],
  context: DurableProgramContext,
  sampling?: SamplingContext,
  decisions?: DecisionContext,
): Operation<Json> {
  const ir = parseProgram(source, tools, sampling !== undefined, decisions !== undefined);
  const registry = new Map(tools.map((tool) => [tool.name, tool]));
  const kernel = yield* createEvaluation(ir);
  let next = yield* kernel.next();
  let invocationId: string | undefined;
  let callIndex = 0;
  while (!next.done) {
    const descriptor = next.value;
    if (descriptor.id === JSON_VALUE_OPERATION) {
      next = yield* kernel.next(evaluateJsonValue(descriptor.data));
      continue;
    }
    const tool = registry.get(descriptor.id);
    if (
      !tool &&
      !(sampling && descriptor.id === "sample") &&
      !(decisions && descriptor.id === "decision") &&
      descriptor.id !== "random"
    ) {
      throw new Error(`No Tisyn tool binding: ${descriptor.id}`);
    }
    const input = validateAuthoredSchema<Json>(
      tool
        ? tool.parameters
        : descriptor.id === "random"
          ? randomParameters
          : descriptor.id === "decision"
            ? decisionRequestSchema
            : samplingParameters,
      descriptor.data,
    );
    if (input.status !== "ok") {
      throw new Error(`Invalid arguments for ${descriptor.id}: ${JSON.stringify(input)}`);
    }
    if (invocationId === undefined) {
      invocationId = yield* context.record(
        { key: "tisyn.invocation-id", retrySafety: { mode: "repeatable" } },
        function* (attempt) {
          return attempt.pullId;
        },
      );
    }
    // Chat correlates native child elicits with the start immediately before invoke.
    // The namespace comes from Sweatpants, never from model-authored source.
    const callId = `${invocationId}/tool-${callIndex++}`;
    yield* context.emit("tool_started", {
      callId,
      tool: descriptor.id,
      input: assertJson(input.value),
    });
    const value = tool
      ? yield* context.pull(
          assertJson({
            kind: "invoke",
            child: {
              id: tool.manifest.programId,
              version: tool.manifest.version,
              digest: tool.manifest.digest,
              input: assertJson(input.value),
            },
          }),
        )
      : descriptor.id === "random"
        ? yield* randomValue(randomParameters.parse(input.value), context)
        : descriptor.id === "decision"
          ? yield* decisions!.decision(decisionRequestSchema.parse(input.value))
          : yield* sampleCompletion(samplingParameters.parse(input.value), sampling!, callId);
    yield* context.emit("tool_completed", {
      callId,
      tool: descriptor.id,
      result: assertJson(value),
      failed: false,
    });
    // Errors/cancellation propagate unchanged; Try is intentionally not admitted yet.
    next = yield* kernel.next(assertJson(value));
  }
  const result = assertJson(next.value);
  if (canonicalJson(result).length > 32_768) {
    throw new Error("Tisyn result exceeds 32 KiB");
  }
  return result;
}

export interface EvaluationProfile {
  id: string;
  limits: Json;
  description: string;
}

/** Author feedback only: never creates an evaluator or dispatches an effect. */
export function validateProgram(
  source: string,
  tools: readonly BoundTool[],
  sampling = false,
  decisions = false,
): Json {
  try {
    parseProgram(source, tools, sampling, decisions);
    return { status: "valid", executed: false };
  } catch (error) {
    return {
      status: "invalid",
      executed: false,
      diagnostic: error instanceof Error ? error.message : String(error),
    };
  }
}

function buildTisynTool(
  tools: readonly BoundTool[],
  profile: EvaluationProfile = {
    id: `yo-workflow@0.0.1/profile-5-guarded-loops/${kernelBundle.provenance.kernelSha256}/${kernelBundle.provenance.source?.fingerprint ?? "published"}`,
    limits: EVALUATION_LIMITS,
    description: `Limits: ${EVALUATION_LIMITS.toolCalls} tool calls per program; ${EVALUATION_LIMITS.stepMilliseconds} ms of synchronous evaluation between tool calls (human wait time is excluded). Limits fail explicitly; they are not successful completion. Recursion also has a JavaScript stack limit.`,
  },
  sampling = false,
  decisions?: DecisionBinding,
) {
  const names = new Set<string>([
    "random",
    ...(sampling ? ["sample"] : []),
    ...(decisions ? ["decision"] : []),
  ]);
  for (const tool of tools) {
    if (names.has(tool.name) || structural.has(tool.name) || reserved.has(tool.name)) {
      throw new Error(`Duplicate or reserved Tisyn tool name: ${tool.name}`);
    }
    names.add(tool.name);
  }
  const bindings = Object.freeze([...tools]);
  const contracts = bindings.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.artifacts.parameters.inputProjection,
    output: tool.artifacts.output?.outputProjection ?? null,
  }));
  contracts.push(randomContract);
  if (sampling) {
    contracts.push(samplingContract);
  }
  if (decisions) {
    contracts.push(decisionContract);
  }
  const description = [
    "Execute a small Tisyn workflow. This is the only tool you can call directly.",
    "Before executing a program, call this tool with validateOnly: true. This checks syntax and admitted operations without running any effects. If invalid, correct the diagnostic and validate again (at most three repairs). After repeated syntax errors, simplify the program into small Fn helpers with LetMany instead of repeatedly editing a deeply nested expression. After validation succeeds, call with the identical program and validateOnly: false to execute. A valid check does not prove runtime logic correct.",
    "For an interactive task, author the complete interaction as one workflow, including how it continues after each reply and how it ends. Do not implement only the first question and leave the remaining interaction to outer chat turns.",
    'Use Ask({message: ...}) and Sample({prompt: ..., exchanges: ..., context: ..., schema: ...}) to spell these capabilities. They are shorthand for the corresponding admitted effects. Use OnAccepted(Ask({...}), Fn(["content","exchange"], body), Fn(["stop"], body)) and OnParsed(Sample({...schema...}), Fn(["value","exchange"], body), Fn(["error"], body)). Callbacks may also be Ref("name") bound to a Fn with the same parameters. Each evaluates its result once and runs only the matching callback. OnAccepted stop contains action; OnParsed error contains message. OnParsed requires structured sampling with a schema. Use normal Let/Get for text-only sampling.',
    ...(decisions
      ? [
          'Classify({"input": value, "instructions": "what to classify", "choices": {"label": "meaning", "other": "other meaning"}}) performs one decision and returns its answer directly: {"type":"choice","choice":"label","confidence":1,"probabilities":[{"value":"label","probability":1}]} or {"type":"refusal"}. Read Get(result,"type") and Get(result,"choice"); there is no answer field on a Classify result. Raw Eval("decision", request) instead returns an envelope with an answer field. Labels are distinct identifiers. Branch on answer.type first: only "choice" has choice, probabilities and confidence; "refusal" requires a separate path.',
          'Switch(value, {"label": branch, "other": branch}, fallback) evaluates value once and runs only the selected branch. All branches are validated. Branches can call Fn values. Classify supplies a label, not extracted fields or generated prose. Its input may include explicit state and history. Labels and any uncertainty threshold belong to the task. Switch also works on values computed without a model call.',
          'Choice composition: Let("result",Classify({"input":"That sounds good","instructions":"Is the speaker agreeing?","choices":{"agree":"agreement","disagree":"disagreement","unclear":"neither is clear"}}),If(Eq(Get(Ref("result"),"type"),"choice"),Switch(Get(Ref("result"),"choice"),{"agree":true,"disagree":false},null),null)).',
        ]
      : []),
    'Schema constructors are pure static JSON Schema: ObjectSchema({field: StringSchema(), count: IntegerSchema(), kind: EnumSchema("answer","revise","clarify")}), ArraySchema(itemSchema), NumberSchema(), BooleanSchema(). ObjectSchema requires every declared field and forbids additional fields. EnumSchema takes scalar literals. Pass these directly in Sample.schema; use raw supported JSON Schema for bounds, optional fields, or anyOf.',
    'Text generation: Let("draft",Sample({"prompt":"Write a short greeting."}),Get(Ref("draft"),"text")). Typed generation: OnParsed(Sample({"prompt":"Extract a count from the supplied context.","context":"three items","schema":ObjectSchema({"count":IntegerSchema()})}),Fn(["value","exchange"],Ref("value")),Fn(["error"],Construct({"status":"invalid","error":Ref("error")}))). These are independent examples; compose only the effects a task needs.',
    "Ask obtains human input; it does not interpret it. OnAccepted dispatches accepted replies and stops. A reply may answer the pending question, revise earlier facts, or ask something else. Keep literal exchanges separately from accepted state. Interpretation can produce a named choice, extracted data, or generated text, according to what the next step needs.",
    'ask and present_choices return exchange.messages on accept. sample returns status "ok" with exchange.messages, and parsed when a schema was supplied; status "invalid" has parseError and no exchange. Accumulate completed exchanges with JsonAppend and pass them explicitly to sample as exchanges. Do not append the same exchange twice. History is conversational evidence, not automatically current state. Document contents are not included in exchanges.',
    "A state change is an explicit value computed from prior state and new input. Validate domain constraints before applying a proposed change. Clarification leaves unresolved facts unchanged. Corrections preserve original exchanges and recompute dependent values; they do not automatically repeat external effects. A schema checks shape, not truth. Refusal, ambiguity, and validation failure need explicit outcomes; retries may be bounded by the task.",
    "The caller receives your program's final value, not the intermediate child-tool transcript. Return accumulated facts that explain what completed, useful results, and why execution stopped. Preserve completed work when a later interaction is declined or cancelled; a bare terminal string cannot distinguish an empty run from a productive one.",
    "After a workflow returns a terminal result, summarize it and end your turn. Do not restart a completed, declined, or cancelled interaction unless the user requests a new one.",
    'For every ask result, branch on Get(Ref("answer"), "action") before reading content: only "accept" has content.reply. On decline or cancel, return the accumulated state and that stop reason immediately.',
    "Account for successful completion as well as exhaustion of any limit. Include the latest reply in accumulated state before checking completion. Make the reply protocol clear to the user and handle that protocol in your program.",
    "Keep source readable with indentation and small named functions. Fn has exactly two arguments: the parameter array and one body expression. Let has exactly three: name, value, body. Use Seq to combine expressions into one body.",
    "The program is constructor DSL, NOT JavaScript. Use double-quoted strings.",
    'Prefer LetMany([["name", expression], ["next", expression]], body) for sequential work. Each expression runs once, in order, and can use earlier bindings. The body returns the result. This is nested Let with a flat binding list; repeated names shadow earlier values. Put small named Fn helpers in this list and use another LetMany for each function body with multiple steps.',
    'Map(array, Fn(["item","index"], body)) builds an array; Filter(array, Fn(["item","index"], predicate)) keeps matching items; Reduce(array, initial, Fn(["acc","item","index"], body)) folds left. Pass exactly two callback parameters for Map/Filter and three for Reduce. Indices start at zero. Callbacks run sequentially and may call tools. The array, initial value, and callback expressions each run once. Empty arrays invoke no callback. These are bounded loops over a fixed input, not parallel work.',
    'Example: LetMany([["items",[2,4,6]],["total",Reduce(Ref("items"),0,Fn(["sum","item","index"],Add(Ref("sum"),Ref("item"))))]],Construct({"total":Ref("total"),"labels":Map(Ref("items"),Fn(["item","index"],JsonStringify(Ref("item"))))}))',
    'Eval("name", {"key": value}) calls a registered tool and returns its JSON result.',
    'Let("x", expression, body) binds a result. Ref("x") reads it. Get(expr, "key") reads an object field.',
    "Seq(a,b) runs in order and returns b. If(condition,then,else) chooses one branch.",
    'Construct({"key": expr}) evaluates object fields. Arr(a,b) builds an array. Plain objects elsewhere are literal data.',
    "Concat(a,b) joins strings. Add/Sub/Mul/Div and Eq/Gt/Lt operate on values. And/Or short-circuit.",
    "When(condition, body) and Unless(condition, body) are provided macros: execute body only when the condition is true or false respectively, otherwise return null.",
    'You may author local syntax macros: WithMacros({"Require":{"params":["condition","message"],"body":If(Hole("condition"),true,Throw(Hole("message")))}}, Use("Require",Gt(3,0),"Expected positive")). Use(name,arg1,...) substitutes unevaluated syntax for Hole("parameter") before execution. Repeating a Hole repeats its expression/effects; use a caller Let to evaluate once. Macro templates cannot contain Let, Fn, Ref, Try, or nested WithMacros; arguments may contain these. Macros are local to this source, limited to 16 definitions, 8 parameters and 64 expansions. Recursive macros are rejected by expansion bounds. Expanded code still undergoes normal capability validation. Prefer functions for runtime recursion and state.',
    "Available: JSON literals, Let, Ref, Seq, If, Get, Construct, Arr, Concat, arithmetic/comparisons, And/Or/Not, Throw.",
    'Fn(["parameter"], body) defines a function. Call(functionExpression, arg1, arg2, ...) calls it with exactly one argument per parameter; do not pack arguments into an array. Functions use the caller environment plus parameter bindings.',
    "A function bound by Let can call itself through Ref. Carry accumulated state as function parameters. Bindings are immutable; While(condition, [body]) does not mutate outer bindings.",
    'Recursion example: Let("countdown", Fn(["n"], If(Eq(Ref("n"),0),0,Call(Ref("countdown"),Sub(Ref("n"),1)))), Call(Ref("countdown"),3))',
    "For repetition, write ONE program with Fn/Call recursion or While. Keep all rounds inside that invocation until its stop condition. Do not unroll rounds or return to the model between rounds.",
    "Inspect tool results according to their contracts. Carry any state needed by later calls as function parameters.",
    "Sampling receives only explicitly supplied context and exchanges. Use OnParsed to handle structured results; text-only Sample returns text.",
    `Source is bounded to ${MAX_SOURCE_LENGTH} characters and the expanded program to ${MAX_PROGRAM_VALUES} JSON values.`,
    profile.description,
    "No Try, concurrency, computed IR, arbitrary JS, imports, or undeclared operations.",
    "Use a single program to carry values across tool calls. Human replies are returned by ask, not invented by you.",
    "Pure JSON operations: JsonGet(value,key) reads an object field or array cell using a computed key; JsonSet(value,key,replacement) returns an updated copy; JsonAppend(array,item) returns an array with one new item; JsonLength(arrayOrString), JsonKeys(object), JsonStringify(value). Indices must exist. No mutation or code evaluation. Carry the returned values in recursive function parameters. Use these to build collections, history, legal choices, and explicit sampling context. Values are bounded to 32 KiB, with at most 4096 JSON operations per program. These pure operations do not consume the separate tool-call budget.",
    'Random({"min":0,"max":2}) returns a uniform integer directly, with inclusive signed 32-bit bounds. Each executed call draws once and records its result for deterministic replay. Random({"choices":["red","green","blue"]}) chooses uniformly among distinct string labels and returns the selected label directly. Supply choices or min/max, never both. Use Random for chance, Classify for interpreting meaning, and Sample for generating content. Bind a draw with Let when reusing it; another Random call is another draw.',
    "Registered tool contracts:",
    JSON.stringify(contracts),
  ].join("\n");
  const builder = createDurableTool("tisyn")
    .description(description)
    .identity({
      version: "0.0.1",
      digest: sha256(
        canonicalJson({
          interpreter: profile.id,
          authorValidation: 3,
          maxProgramValues: MAX_PROGRAM_VALUES,
          decisionSyntax: 1,
          randomEffect: 2,
          macroSyntax: 3,
          jsonValues: 2,
          collectionSyntax: 1,
          exchangeSyntax: 2,
          valueOperations: EVALUATION_LIMITS.valueOperations,
          decisions: decisions ?? null,
          sampling: sampling
            ? {
                identity: samplingIdentity,
                dispatch: "direct",
                parameters: samplingContract.parameters,
                output: samplingContract.output,
              }
            : null,
          evaluationLimits: profile.limits,
          tisyn: Object.fromEntries(
            Object.entries(packageJson.dependencies).filter(([name]) => name.startsWith("@tisyn/")),
          ),
          tools: bindings.map((tool) => ({
            name: tool.name,
            digest: tool.manifest.digest,
            interface: tool.interfaceDigest,
          })),
        }),
      ),
    })
    .parameters(
      z.object({
        program: z.string().min(1).max(MAX_SOURCE_LENGTH),
        validateOnly: z.boolean().optional(),
      }),
    );
  if (decisions) {
    const ready = builder.decisions(decisions);
    if (sampling) {
      return ready.samples().execute(function* ({ program, validateOnly }, context) {
        if (validateOnly) {
          return validateProgram(program, bindings, true, true);
        }
        return yield* executeProgram(program, bindings, context, context, context);
      });
    }
    return ready.execute(function* ({ program, validateOnly }, context) {
      if (validateOnly) {
        return validateProgram(program, bindings, false, true);
      }
      return yield* executeProgram(program, bindings, context, undefined, context);
    });
  }
  if (sampling) {
    return builder.samples().execute(function* ({ program, validateOnly }, context) {
      if (validateOnly) {
        return validateProgram(program, bindings, true);
      }
      return yield* executeProgram(program, bindings, context, context);
    });
  }
  return builder.execute(function* ({ program, validateOnly }, context) {
    if (validateOnly) {
      return validateProgram(program, bindings);
    }
    return yield* executeProgram(program, bindings, context);
  });
}

/** Opt in to a native sampling pull; registered tools retain child invocation semantics. */
export function createTisynTool(tools: readonly BoundTool[], profile?: EvaluationProfile) {
  function builder(sampling: boolean, decisions?: DecisionBinding) {
    return {
      samples() {
        return builder(true, decisions);
      },
      decisions(binding: DecisionBinding) {
        return builder(sampling, Object.freeze({ ...binding }));
      },
      build() {
        return buildTisynTool(tools, profile, sampling, decisions);
      },
    };
  }
  return builder(false);
}
