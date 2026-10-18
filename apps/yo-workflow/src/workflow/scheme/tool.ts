import { createDurableTool } from "@sweatpants/agent-sdk";
import { assertJson, canonicalJson, sha256, type Json } from "@sweatpants/foundation";
import { validateAuthoredSchema } from "@sweatpants/foundation/parser";
import { decisionRequestSchema } from "@sweatpants/model-decision";
import type { Operation } from "effection";
import { z } from "zod";
import type { BoundTool } from "../bound-tool.ts";
import { decisionBinding, decisionContract } from "../decisions.ts";
import { randomValue, randomParameters, randomContract } from "../random.ts";
import {
  sampleCompletion,
  samplingParameters,
  samplingContract,
  samplingIdentity,
} from "../sampling.ts";
import {
  createSchemeEvaluation,
  checkSchemeProgram,
  schemeDiagnostic,
  SchemeEvaluationError,
  limits,
} from "@sweatpants/scheme-runtime";
import manifest from "@sweatpants/scheme-runtime/manifest" with { type: "json" };
import { createSchemeReference } from "./reference.ts";
import { createRecoveryHistory } from "./recovery.ts";
import { schemeSourceHint } from "./diagnostics.ts";

const parameters = z
  .object({
    title: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .optional()
      .describe(
        "A short human-readable title describing this workflow, e.g. Play paper rock scissors. Supply the same title for validation and execution.",
      ),
    program: z.string().min(1).max(limits.source),
    input: z.json().optional(),
    validateOnly: z.boolean().optional(),
  })
  .strict();
const invocation = z
  .object({ program: z.string().min(1).max(limits.source), input: z.json() })
  .strict();
const reserved = new Set(["sample", "decision", "random", "scheme.invoke", "scheme"]);

/** The interpreter yields descriptions. Sweatpants owns every external effect and child. */
export function createSchemeTool(bindings: readonly BoundTool[]): BoundTool {
  const registry = new Map(bindings.map((tool) => [tool.name, tool]));
  if (registry.size !== bindings.length || bindings.some((tool) => reserved.has(tool.name)))
    throw new Error("Duplicate or reserved Scheme capability");
  const capabilities = [...registry.keys(), "random", "sample", "decision", "scheme.invoke"];
  const contracts = [
    ...bindings.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.artifacts.parameters.inputProjection,
      output: tool.artifacts.output?.outputProjection ?? null,
    })),
    randomContract,
    samplingContract,
    decisionContract,
  ];
  const tool: BoundTool = createDurableTool("scheme")
    .description(createSchemeReference(contracts))
    .identity({
      version: "0.0.1",
      digest: sha256(
        canonicalJson({
          engine: "hoot-scheme-v1",
          manifest,
          host: 2,
          samplingIdentity,
          decisionBinding,
          limits: {
            ...limits,
            validationFuel: String(limits.validationFuel),
            stepFuel: String(limits.stepFuel),
            totalFuel: String(limits.totalFuel),
          },
          bindings: bindings.map((t) => ({
            name: t.name,
            digest: t.manifest.digest,
            interface: t.interfaceDigest,
          })),
        }),
      ),
    })
    .parameters(parameters)
    .output(z.json())
    .samples()
    .decisions(decisionBinding)
    .execute(function* ({ program, input, validateOnly }, context): Operation<Json> {
      const validation = yield* checkSchemeProgram({
        source: program,
        input: assertJson(input ?? null),
      });
      if (!validation.valid) {
        const sourceHint = schemeSourceHint(program);
        const identifier = validation.diagnostic.identifier;
        const repairHint =
          validation.diagnostic.code === "E_VALIDATION_FUEL"
            ? "Validation reached its compiler resource limit; this is not evidence of a syntax error. Do not retry unchanged source or execute it to bypass validation. Split large helpers and move static data into input, then validate the complete program again."
            : identifier && registry.has(identifier)
              ? `${identifier} is a registered tool, not a Scheme procedure. Call (effect ${JSON.stringify(identifier)} request) with one request object matching its contract.`
              : identifier === "eq?"
                ? "Use equal? for value comparison; eq? is not in this evaluator's language reference."
                : undefined;
        return {
          status: "invalid",
          diagnostic: {
            ...validation.diagnostic,
            ...(sourceHint === undefined ? {} : { sourceHint }),
            ...(repairHint === undefined ? {} : { repairHint }),
          },
          completedEffects: 0,
        };
      }
      if (validateOnly)
        return {
          status: "valid",
          checks: {
            checked: [...validation.checks.checked],
            unchecked: [...validation.checks.unchecked],
          },
        };
      const evaluation = yield* createSchemeEvaluation({
        source: program,
        capabilities,
        input: assertJson(input ?? null),
      });
      let count = 0;
      const recovery = createRecoveryHistory();
      let invocationId: string | undefined;
      try {
        let step = yield* evaluation.next();
        while (!step.done) {
          const { id, data } = step.value;
          const binding = registry.get(id);
          const schema =
            binding?.parameters ??
            (id === "random"
              ? randomParameters
              : id === "sample"
                ? samplingParameters
                : id === "decision"
                  ? decisionRequestSchema
                  : invocation);
          const checked = validateAuthoredSchema<Json>(schema, data);
          if (checked.status !== "ok")
            throw new SchemeEvaluationError(`Invalid ${id} request: ${JSON.stringify(checked)}`);
          if (invocationId === undefined)
            invocationId = yield* context.record(
              { key: "scheme.invocation-id", retrySafety: { mode: "repeatable" } },
              function* (attempt) {
                return attempt.pullId;
              },
            );
          const callId = `${invocationId}/tool-${count}`;
          yield* context.emit("tool_started", {
            callId,
            tool: id === "scheme.invoke" ? "scheme" : id,
            input: assertJson(checked.value),
          });
          let value: Json;
          if (binding || id === "scheme.invoke") {
            const child = binding ?? tool;
            value = assertJson(
              yield* context.pull({
                kind: "invoke",
                child: {
                  id: child.manifest.programId,
                  version: child.manifest.version,
                  digest: child.manifest.digest,
                  input: assertJson(checked.value),
                },
              }),
            );
          } else if (id === "random")
            value = yield* randomValue(randomParameters.parse(checked.value), context);
          else if (id === "decision")
            value = assertJson(yield* context.decision(decisionRequestSchema.parse(checked.value)));
          else
            value = assertJson(
              yield* sampleCompletion(samplingParameters.parse(checked.value), context, callId),
            );
          recovery.record(value);
          count++;
          yield* context.emit("tool_completed", {
            callId,
            tool: id === "scheme.invoke" ? "scheme" : id,
            result: value,
            failed: false,
          });
          step = yield* evaluation.next(value);
        }
        return step.value;
      } catch (error) {
        // Authored faults are visible outcomes, with accepted work counted. Infrastructure failures propagate.
        if (!(error instanceof SchemeEvaluationError)) throw error;
        return {
          status: "failed",
          diagnostic: { ...schemeDiagnostic(error.message, "execution") },
          completedEffects: count,
          recovery: recovery.snapshot(),
        };
      }
    });
  return tool;
}
