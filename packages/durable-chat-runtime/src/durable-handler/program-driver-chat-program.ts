import { type Operation } from "effection";
import {
  CrankError,
  PullApplicationError,
  createPinnedDurableProgram,
  type DurableProgramContext,
} from "@sweatpants/durable-execution";
import {
  assistantText,
  assistantToolCalls,
  decodeModelContextSource,
  decodeModelSampleResult,
  encodeModelSampleSourceRequest,
  type ModelSampleSourceRequest,
} from "@sweatpants/model-sampling";
import { assertJson, type Json } from "@sweatpants/foundation";
import { FOREIGN_TOOL_ADAPTER_PROGRAM } from "@sweatpants/tool-session/foreign";

import { manifest, type ChatToolCatalogEntry } from "./program-driver-schema.ts";

type ChatCall = {
  id: string;
  target: string;
  input: Json;
  thoughtSignature: string | null;
};

// Root tool owns the deterministic sample/tool loop and its durable continuation semantics.
// fallow-ignore-next-line complexity
export const rootTool = createPinnedDurableProgram(manifest, function* (input, context) {
  const contextSource = decodeModelContextSource(input.contextSource);
  const completedCallIds = new Set<string>();
  for (let iteration = 0; iteration < input.maxIterations; iteration += 1) {
    const sampleRequest: ModelSampleSourceRequest = {
      invocation: {
        context: contextSource,
        ...(iteration === 0 && input.toolChoice !== undefined
          ? { options: { toolChoice: input.toolChoice } }
          : {}),
      },
      tools: {
        type: "embedded",
        tools: Object.values(input.catalog.entries).map((entry) => entry.model),
      },
      response: { type: "message" },
    };
    const sampled = decodeModelSampleResult(
      yield* context.pull(
        assertJson({
          kind: "sample",
          input: encodeModelSampleSourceRequest(sampleRequest),
        }),
      ),
    );
    const text = assistantText(sampled.message);
    const calls: ChatCall[] = assistantToolCalls(sampled.message)
      .filter((call) => !completedCallIds.has(call.id))
      .map((call) => ({
        id: call.id,
        target: resolveOuterToolTarget(
          call.name,
          Object.keys(input.catalog.entries).map((name) => ({ name })),
        ),
        input: call.input,
        thoughtSignature: call.thoughtSignature,
      }));
    if (calls.length === 0) {
      yield* context.emit("assistant_text", { text });
      return text;
    }
    for (const call of calls) {
      completedCallIds.add(call.id);
    }
    for (const call of calls) {
      yield* context.emit("tool_started", {
        callId: call.id,
        tool: call.target,
        input: call.input,
      });
      const catalogEntry = input.catalog.entries[call.target];
      if (!catalogEntry) {
        throw new CrankError("foreign_tool_not_found", `Tool not found: ${call.target}`);
      }
      const outcome = yield* invokeCatalogTool(context, catalogEntry.execution, call);
      yield* context.emit("tool_completed", {
        callId: call.id,
        tool: call.target,
        result: outcome.result,
        failed: outcome.failed,
      });
    }
  }
  throw new CrankError("max_tool_iterations", "Maximum tool iterations reached");
});

type CatalogToolCall = ChatCall;

/**
 * Failures that mean "the foreign process is gone or unreachable".
 *
 * These are outside the durable program's control: a non-journal-native tool
 * holds its continuation in its own process, and that process may vanish
 * between an elicitation and the human's answer. No amount of replay revives
 * it, so the conversation is told what happened and decides what to do next.
 *
 * `effect_outcome_indeterminate` is the authority's own verdict when a host
 * died with an unsafe attempt in flight: the call may or may not have landed,
 * and nobody can find out. That is the same class of fact.
 *
 * Everything else stays fatal on purpose — cancellation must keep unwinding,
 * and contract violations such as parameter validation must surface as run
 * errors rather than being narrated to the model as ordinary results.
 */
const RECOVERABLE_FOREIGN_FAILURES: ReadonlySet<string> = new Set([
  "foreign_session_ended",
  "foreign_continuation_lost",
  "foreign_tool_start_failed",
  "foreign_tool_error",
  "effect_outcome_indeterminate",
]);

/**
 * Runs one catalog tool call and converts an application-level failure into an
 * ordinary tool result.
 *
 * A foreign tool is not journal-native: its process may vanish between an
 * elicitation and the human's answer, and no amount of durable replay can
 * revive it. When that happens the adapter reports a typed failure and the
 * authority journals it. That is information the conversation can act on — the
 * model may restart the flow now that the human is engaged — not a reason to
 * destroy the turn.
 *
 * The substituted result is derived from the journaled error, so replay
 * reproduces it exactly. Cancellation and `CrankError` still propagate: durable
 * unwinding and authored contract violations must remain fatal.
 */
function* invokeCatalogTool(
  context: DurableProgramContext,
  entry: ChatToolCatalogEntry["execution"],
  call: CatalogToolCall,
): Operation<{ result: Json; failed: boolean }> {
  try {
    const child =
      entry.kind === "program"
        ? { ...entry.program, input: call.input }
        : {
            ...FOREIGN_TOOL_ADAPTER_PROGRAM,
            input: {
              driver: entry.driver,
              tool: entry.tool,
              input: call.input,
              durability: entry.durability,
              route: call.id,
            },
          };
    const result = yield* context.pull(assertJson({ kind: "invoke", child }));
    return { result, failed: false };
  } catch (error) {
    if (!(error instanceof PullApplicationError)) {
      throw error;
    }
    const { code, message, details } = error.applicationError;
    if (
      !RECOVERABLE_FOREIGN_FAILURES.has(code) ||
      (code === "foreign_tool_error" &&
        (entry.kind !== "foreign-tool" || entry.driver !== "tool-session"))
    ) {
      throw error;
    }
    return {
      result: {
        status: "error",
        error: { code, message, ...(details === undefined ? {} : { details }) },
      },
      failed: true,
    };
  }
}

function resolveOuterToolTarget(requested: string, tools: ReadonlyArray<{ name: string }>): string {
  if (tools.some((tool) => tool.name === requested)) {
    return requested;
  }
  const aliases = tools.filter((tool) => tool.name.startsWith(`${requested}_`));
  if (aliases.length === 1) {
    return aliases[0]!.name;
  }
  if (aliases.length > 1) {
    throw new CrankError(
      "ambiguous_tool_alias",
      `Tool name "${requested}" matches multiple catalog entries: ${aliases
        .map((tool) => tool.name)
        .join(", ")}`,
    );
  }
  // Preserve the provider's requested target so the root program can emit a
  // normal tool_started record before rejecting it at the bound catalog. That
  // produces a causal call/error-result pair for follow-up history.
  return requested;
}
