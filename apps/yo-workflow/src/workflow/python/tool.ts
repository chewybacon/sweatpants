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
import { playgroundIdentity } from "@sweatpants/flowmode-runtime-monty";
import { MontyEvaluationPort } from "@sweatpants/flowmode-runtime-monty/evaluation";
import { runPythonReplay } from "./replay.ts";

export function createPythonTool(bindings: readonly BoundTool[]) {
  const registry = new Map(bindings.map((tool) => [tool.name, tool]));
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
  const names = contracts.map((contract) => contract.name);
  if (registry.size !== bindings.length || new Set(names).size !== names.length) {
    throw new Error("Duplicate Python capability");
  }
  return createDurableTool("python")
    .description(`Author and execute ordinary Python in Monty/Wasm. Supply title, program and optional validateOnly. Define async def main() returning a JSON-compatible value. Validate before executing. Validation runs to the first host boundary without performing host effects; later paths remain unchecked.
Use real imports: from sandbox import ask, random, echo, sample, decision, document_create, document_read, document_edit, present_choices, display_document. Each is an async capability accepting ONE dictionary argument, e.g. answer = await ask({"message": "Rock, paper, or scissors?", "suggestions": ["rock", "paper", "scissors"]}); move = await random({"choices": ["rock", "paper", "scissors"]}). ask returns a dictionary: action accept has content.reply with literal user text; handle decline and cancel too. Random is journaled and returns the chosen value directly. Do not implement capabilities or invent fields. There is no guest filesystem, network, clock or arbitrary package loading.
Use ordinary Python loops, dictionaries, lists, functions, async def/await, try/finally and supported async context managers. Import asyncio for gather of distinct capability calls; requests are admitted concurrently, but this playground services the outstanding frontier in admission order. Human questions park until answered; locals and results persist across turns. Return useful final state including relevant literal exchanges. No TaskGroup, standard Queue, timers, async generators, arbitrary awaitables or full CPython/asyncio compatibility. Cancellation of the chat tool is not a promise to run guest cleanup; an ask cancel is a returned action your program handles explicitly. Do not use private VM syntax.
Capability contracts (JSON schemas describe Python dictionary shapes):\n${JSON.stringify(contracts)}`)
    .identity({
      version: "0.0.1",
      digest: sha256(
        canonicalJson({
          engine: "monty-playground1",
          playgroundIdentity,
          samplingIdentity,
          decisionBinding,
          bindings: bindings.map((tool) => ({
            name: tool.name,
            digest: tool.manifest.digest,
            interface: tool.interfaceDigest,
          })),
        }),
      ),
    })
    .parameters(
      z
        .object({
          title: z.string().min(1).max(120).optional(),
          program: z.string().min(1).max(48000),
          validateOnly: z.boolean().optional(),
        })
        .strict(),
    )
    .output(z.json())
    .samples()
    .decisions(decisionBinding)
    .execute(function* ({ program, validateOnly }, context): Operation<Json> {
      if (!(yield* MontyEvaluationPort.isInstalled())) {
        throw Error("Python evaluation driver is not installed");
      }
      return yield* runPythonReplay({
        source: program,
        validateOnly: validateOnly ?? false,
        context,
        *exchange({ capability: { name, input: data }, completedEffects: count, invocationId }) {
          const binding = registry.get(name);
          const schema =
            binding?.parameters ??
            (name === "random"
              ? randomParameters
              : name === "sample"
                ? samplingParameters
                : name === "decision"
                  ? decisionRequestSchema
                  : undefined);
          if (!schema) {
            return {
              kind: "stop",
              result: {
                status: "failed",
                diagnostic: { message: `Unknown Python capability: ${name}` },
                completedEffects: count,
              },
            };
          }
          const checked = validateAuthoredSchema<Json>(schema, data);
          if (checked.status !== "ok") {
            return {
              kind: "stop",
              result: {
                status: "failed",
                diagnostic: { message: `Invalid ${name} request: ${JSON.stringify(checked)}` },
                completedEffects: count,
              },
            };
          }
          const callId = `${invocationId}/tool-${count}`;
          yield* context.emit("tool_started", {
            callId,
            tool: name,
            input: assertJson(checked.value),
          });
          let value: Json;
          if (binding) {
            value = assertJson(
              yield* context.pull({
                kind: "invoke",
                child: {
                  id: binding.manifest.programId,
                  version: binding.manifest.version,
                  digest: binding.manifest.digest,
                  input: assertJson(checked.value),
                },
              }),
            );
          } else if (name === "random") {
            value = yield* randomValue(randomParameters.parse(checked.value), context);
          } else if (name === "decision") {
            value = assertJson(yield* context.decision(decisionRequestSchema.parse(checked.value)));
          } else {
            value = assertJson(
              yield* sampleCompletion(samplingParameters.parse(checked.value), context, callId),
            );
          }
          yield* context.emit("tool_completed", {
            callId,
            tool: name,
            result: value,
            failed: false,
          });
          return { kind: "resume", value };
        },
      });
    });
}
