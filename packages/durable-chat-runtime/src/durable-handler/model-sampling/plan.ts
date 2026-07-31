import { CrankError } from "@sweatpants/durable-execution";
import { applyHistoryPolicy, type HistoryPolicy } from "@sweatpants/chat-core";
import type {
  Context,
  Model,
  ModelProviderStreamRequest,
  StreamOptions,
  Tool,
} from "@sweatpants/model-provider";
import type {
  ModelResponseMode,
  ModelSampleRequest,
  ModelSamplingExecutionContext,
} from "@sweatpants/model-sampling";
import { manifest, type ChatToolCatalog } from "../program-driver-schema.ts";

export type ModelCallerEvidence =
  | { type: "chat-root"; taskId: string }
  | {
      type: "nested-program";
      taskId: string;
      program: ModelSamplingExecutionContext["placement"]["program"];
    };

export type ModelInvocationDecision =
  | { type: "tool-catalog-bound"; digest: string }
  | { type: "history-policy"; policy: string; decisionCount: number };

export interface ModelInvocationPlan {
  readonly caller: ModelCallerEvidence;
  readonly providerRequest: ModelProviderStreamRequest;
  readonly response: ModelResponseMode;
  readonly delivery: { type: "none" } | { type: "outer-assistant"; messageId: string };
  readonly decisions: readonly ModelInvocationDecision[];
}

function callerEvidence(context: ModelSamplingExecutionContext): ModelCallerEvidence {
  const program = context.placement.program;
  return program.id === manifest.programId &&
    program.version === manifest.version &&
    program.digest === manifest.digest
    ? { type: "chat-root", taskId: context.taskId }
    : { type: "nested-program", taskId: context.taskId, program };
}

function resolveTools(
  request: ModelSampleRequest,
  catalog: ChatToolCatalog,
): { tools?: Tool[]; decision?: ModelInvocationDecision } {
  switch (request.tools.type) {
    case "none":
      return {};
    case "embedded":
      return {
        tools: request.tools.tools.map((tool) => ({
          name: tool.name,
          ...(tool.description !== undefined ? { description: tool.description } : {}),
          parameters: tool.parameters,
        })),
      };
    case "catalog":
      if (request.tools.digest !== catalog.digest) {
        throw new CrankError(
          "catalog_mismatch",
          "Model sampling catalog differs from the accepted chat catalog",
        );
      }
      return {
        tools: Object.values(catalog.entries).map((entry) => ({
          name: entry.model.name,
          ...(entry.model.description !== undefined
            ? { description: entry.model.description }
            : {}),
          parameters: entry.model.parameters,
        })),
        decision: { type: "tool-catalog-bound", digest: catalog.digest },
      };
  }
}

/** Pure deterministic planning from parsed command and authority evidence. */
export function planModelInvocation(input: {
  request: ModelSampleRequest;
  execution: ModelSamplingExecutionContext;
  model: Model;
  streamOptions?: StreamOptions;
  catalog: ChatToolCatalog;
  historyPolicy?: HistoryPolicy;
}): ModelInvocationPlan {
  const caller = callerEvidence(input.execution);
  const resolvedTools = resolveTools(input.request, input.catalog);
  const providerContext: Context = {
    messages: input.request.invocation.context.messages,
    ...(input.request.invocation.context.systemPrompt !== undefined
      ? { systemPrompt: input.request.invocation.context.systemPrompt }
      : {}),
    ...(resolvedTools.tools ? { tools: resolvedTools.tools } : {}),
  };
  const history =
    caller.type === "chat-root"
      ? applyHistoryPolicy(input.historyPolicy, providerContext)
      : { context: providerContext, decisions: [] };
  const responseFormat =
    input.request.response.type === "json"
      ? {
          responseFormat: {
            type: "json_schema" as const,
            ...(input.request.response.name !== undefined
              ? { name: input.request.response.name }
              : {}),
            schema: input.request.response.schema,
          },
        }
      : {};
  const options: StreamOptions = {
    ...input.streamOptions,
    ...input.request.invocation.options,
    signal: input.execution.cancellation,
    sessionId: input.execution.pullId,
    ...responseFormat,
  };
  const decisions: ModelInvocationDecision[] = [
    ...(resolvedTools.decision ? [resolvedTools.decision] : []),
    ...(history.decisions.length > 0 && input.historyPolicy
      ? [
          {
            type: "history-policy" as const,
            policy: input.historyPolicy.name,
            decisionCount: history.decisions.length,
          },
        ]
      : []),
  ];
  return {
    caller,
    providerRequest: {
      model: input.model,
      context: history.context,
      options,
    },
    response: input.request.response,
    delivery:
      caller.type === "chat-root"
        ? {
            type: "outer-assistant",
            messageId: `assistant:stream:${input.execution.taskId}:${input.execution.pullId}`,
          }
        : { type: "none" },
    decisions,
  };
}
