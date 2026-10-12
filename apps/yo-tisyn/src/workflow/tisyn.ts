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
  sampleText,
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
const unsafeKeys = new Set(["__proto__", "prototype", "constructor"]);
/** Fail closed before any tool can run, including effects inside unselected branches. */
export function parseProgram(
  source: string,
  tools: readonly BoundTool[],
  sampling = false,
  decisions = false,
): TisynExpr {
  const ir = parseTisynSource(source);
  const names = new Set(tools.map((tool) => tool.name));
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
    if (++nodes > 1000) {
      throw new Error("Tisyn program exceeds 1000 values");
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
    const tool = registry.get(descriptor.id);
    if (
      !tool &&
      !(sampling && descriptor.id === "sample") &&
      !(decisions && descriptor.id === "decision")
    ) {
      throw new Error(`No Tisyn tool binding: ${descriptor.id}`);
    }
    const input = validateAuthoredSchema<Json>(
      tool
        ? tool.parameters
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
      : descriptor.id === "decision"
        ? yield* decisions!.decision(decisionRequestSchema.parse(input.value))
        : yield* sampleText(samplingParameters.parse(input.value), sampling!);
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
    id: "yo-tisyn@0.0.1/profile-5-guarded-loops",
    limits: EVALUATION_LIMITS,
    description: `Limits: ${EVALUATION_LIMITS.toolCalls} tool calls per program; ${EVALUATION_LIMITS.stepMilliseconds} ms of synchronous evaluation between tool calls (human wait time is excluded). Limits fail explicitly; they are not successful completion. Recursion also has a JavaScript stack limit.`,
  },
  sampling = false,
  decisions?: DecisionBinding,
) {
  const names = new Set<string>([
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
    elicits: Object.fromEntries(
      Object.entries(tool.artifacts.elicits).map(([key, value]) => [
        key,
        {
          response: value.response.inputProjection,
          context: value.context?.inputProjection ?? null,
        },
      ]),
    ),
  }));
  if (sampling) {
    contracts.push(samplingContract);
  }
  if (decisions) {
    contracts.push(decisionContract);
  }
  const description = [
    "Execute a small Tisyn workflow. This is the only tool you can call directly.",
    "Before executing a program, call this tool with validateOnly: true. This checks syntax and admitted operations without running any effects. If invalid, correct the diagnostic and validate again (at most three repairs). After validation succeeds, call with the identical program and validateOnly: false to execute. A valid check does not prove runtime logic correct.",
    "For an interactive task, author the complete interaction as one workflow, including how it continues after each reply and how it ends. Do not implement only the first question and leave the remaining interaction to outer chat turns.",
    "When the next action requires reasoning about earlier replies, call sample inside the workflow with the task and accumulated context. Use its result to choose the next action or construct the next prompt. Choose the workflow's state and stopping conditions from the user's request.",
    "The caller receives your program's final value, not the intermediate child-tool transcript. Return accumulated facts that explain what completed, useful results, and why execution stopped. Preserve completed work when a later interaction is declined or cancelled; a bare terminal string cannot distinguish an empty run from a productive one.",
    "After a workflow returns a terminal result, summarize it and end your turn. Do not restart a completed, declined, or cancelled interaction unless the user requests a new one.",
    'For every ask result, branch on Get(Ref("answer"), "action") before reading content: only "accept" has content.reply. On decline or cancel, return the accumulated state and that stop reason immediately.',
    "Account for successful completion as well as exhaustion of any limit. Include the latest reply in accumulated state before checking completion. Make the reply protocol clear to the user and handle that protocol in your program.",
    "Keep source readable with indentation and small named functions. Fn has exactly two arguments: the parameter array and one body expression. Let has exactly three: name, value, body. Use Seq to combine expressions into one body.",
    "The program is constructor DSL, NOT JavaScript. Use double-quoted strings.",
    'Eval("name", {"key": value}) calls a registered tool and returns its JSON result.',
    'Let("x", expression, body) binds a result. Ref("x") reads it. Get(expr, "key") reads an object field.',
    "Seq(a,b) runs in order and returns b. If(condition,then,else) chooses one branch.",
    'Construct({"key": expr}) evaluates object fields. Arr(a,b) builds an array. Plain objects elsewhere are literal data.',
    "Concat(a,b) joins strings. Add/Sub/Mul/Div and Eq/Gt/Lt operate on values. And/Or short-circuit.",
    "Available: JSON literals, Let, Ref, Seq, If, Get, Construct, Arr, Concat, arithmetic/comparisons, And/Or/Not, Throw.",
    'Fn(["parameter"], body) defines a function. Call(functionExpression, argument) calls it. Functions use the caller environment plus parameter bindings.',
    "A function bound by Let can call itself through Ref. Carry accumulated state as function parameters. Bindings are immutable; While(condition, [body]) does not mutate outer bindings.",
    'Recursion example: Let("countdown", Fn(["n"], If(Eq(Ref("n"),0),0,Call(Ref("countdown"),Sub(Ref("n"),1)))), Call(Ref("countdown"),3))',
    `Interactive accumulation example (adapt the state and conditions to the task):
Let("loop", Fn(["history"],
  Let("answer", Eval("ask", {"message":"Next item?"}),
    If(Eq(Get(Ref("answer"),"action"),"accept"),
      Call(Ref("loop"), Concat(Ref("history"), "\\n", Get(Get(Ref("answer"),"content"),"reply"))),
      Construct({"status":Get(Ref("answer"),"action"),"history":Ref("history")})))),
  Call(Ref("loop"),""))`,
    "For repetition, write ONE program with Fn/Call recursion or While. Keep all rounds inside that invocation until its stop condition. Do not unroll rounds or return to the model between rounds.",
    "Inspect tool results according to their contracts. Carry any state needed by later calls as function parameters.",
    "Sampling calls receive only the context you explicitly supply. You can construct their prompts from earlier tool results and read their returned text with Get.",
    profile.description,
    ...(decisions
      ? [
          'Classify({"input": value, "instructions": "what to classify", "choices": {"label": "meaning", "other": "other meaning"}}) performs one decision and returns its answer. Labels are distinct identifiers. Branch on answer.type first: only "choice" has choice, probabilities and confidence; "refusal" requires a separate path.',
          'Switch(value, {"label": branch, "other": branch}, fallback) evaluates value once and runs only the selected branch. All branches are validated. Branches can call Fn values. Use Classify for bounded semantic choices and sample for generated text. Keep arithmetic and exact limits in code. Choose uncertainty thresholds only when appropriate to the task.',
        ]
      : []),
    "No Try, concurrency, computed IR, arbitrary JS, imports, or undeclared operations.",
    "Use a single program to carry values across tool calls. Human replies are returned by ask, not invented by you.",
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
          authorValidation: 1,
          decisionSyntax: 1,
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
