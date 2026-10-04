import { z } from "zod";
import type { Json, JsonObject } from "@sweatpants/foundation";
import type {
  ToolInvocationAsk,
  ToolInvocationElicitAsk,
  ToolInvocationResume,
} from "../../invocation.ts";
import { decodeMcpFormResponse, type McpFormResponse } from "../continuations.ts";
import { encodeElicitationRequest, encodeSamplingRequest } from "../protocol/message-encoder.ts";
import { createDecoderContext, decodeResponse } from "../protocol/message-decoder.ts";
import { McpRequestMetadataError, requireMcpFormCapability } from "../request-metadata.ts";
import { McpHttpError } from "./http.ts";

/** Adapt a rich authored interaction to MCP's flat form without changing the tool. */
export interface McpFormAdapter {
  present(ask: ToolInvocationElicitAsk): { message: string; requestedSchema: JsonObject };
  accept(content: NonNullable<McpFormResponse["content"]>, ask: ToolInvocationElicitAsk): Json;
}
export type McpFormAdapters = Readonly<Record<string, Readonly<Record<string, McpFormAdapter>>>>;

export function projectInputRequest(
  ask: ToolInvocationAsk,
  forms?: Readonly<Record<string, McpFormAdapter>>,
) {
  if (ask.kind === "sample")
    return {
      method: "sampling/createMessage",
      params: encodeSamplingRequest(ask, ask.requestId).params,
    };
  const adapter = forms?.[ask.key];
  const params = adapter
    ? { mode: "form" as const, ...adapter.present(ask) }
    : encodeElicitationRequest(ask, ask.requestId).params!;
  // Plain forms must already be flat. Rich schemas need an explicit adapter;
  // never publish a schema that standard MCP clients cannot answer.
  const parsedSchema = z
    .record(z.string(), z.json())
    .safeParse("requestedSchema" in params ? params.requestedSchema : undefined);
  if (!parsedSchema.success) throw new McpHttpError(400, -32602, "Invalid MCP form schema");
  const schema = parsedSchema.data;
  const properties = schema.properties;
  if (
    schema.type !== "object" ||
    !properties ||
    typeof properties !== "object" ||
    Array.isArray(properties)
  )
    throw new McpHttpError(400, -32602, `Elicitation ${ask.key} requires a flat MCP form adapter`);
  for (const property of Object.values(properties)) {
    if (!property || typeof property !== "object" || Array.isArray(property))
      throw new McpHttpError(400, -32602, "Invalid MCP form property");
    if (
      !["string", "number", "integer", "boolean"].includes(String(property.type)) &&
      !(
        property.type === "array" &&
        property.items &&
        typeof property.items === "object" &&
        !Array.isArray(property.items) &&
        property.items.type === "string"
      )
    )
      throw new McpHttpError(
        400,
        -32602,
        `Elicitation ${ask.key} requires a flat MCP form adapter`,
      );
  }
  return { method: "elicitation/create", params };
}

export function resumeInput(
  ask: ToolInvocationAsk,
  responses: unknown,
  forms?: Readonly<Record<string, McpFormAdapter>>,
): ToolInvocationResume {
  if (ask.kind === "elicit") {
    const response = decodeMcpFormResponse(responses, ask.requestId);
    const adapter = forms?.[ask.key];
    return {
      kind: "elicit",
      requestId: ask.requestId,
      response:
        response.action === "accept"
          ? {
              action: "accept",
              content: adapter ? adapter.accept(response.content!, ask) : response.content!,
            }
          : { action: response.action },
    };
  }
  if (
    !responses ||
    typeof responses !== "object" ||
    Array.isArray(responses) ||
    Object.keys(responses).length !== 1 ||
    !Object.hasOwn(responses, ask.requestId)
  )
    throw new McpHttpError(400, -32602, "Expected the pending sampling response");
  const context = createDecoderContext();
  context.addPendingSampling(ask.requestId, ask.requestId);
  const decoded = decodeResponse(
    {
      jsonrpc: "2.0",
      id: ask.requestId,
      result: (responses as Record<string, unknown>)[ask.requestId],
    },
    context,
  );
  if (decoded.type !== "sampling_response")
    throw new McpHttpError(400, -32602, "Invalid sampling response");
  return { kind: "sample", requestId: ask.requestId, response: decoded.result };
}

export function requireInputCapabilities(
  ask: ToolInvocationAsk,
  capabilities: Readonly<Record<string, unknown>>,
): void {
  if (ask.kind === "elicit") return requireMcpFormCapability(capabilities);
  const tools = Boolean(ask.tools?.length || ask.schema);
  const schema = tools ? z.object({ tools: z.object({}) }) : z.object({});
  if (!schema.safeParse(capabilities.sampling).success)
    throw new McpRequestMetadataError(-32021, "Client does not support requested sampling", {
      requiredCapabilities: { sampling: tools ? { tools: {} } : {} },
    });
}
