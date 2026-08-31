import { CrankError } from "@sweatpants/durable-execution";
import type { Json } from "@sweatpants/foundation";
import { parsePortableSchemaDescriptor } from "@sweatpants/foundation/schema";

export type TreePlacement = {
  readonly nodeId: string;
  readonly parentNodeId: string | null;
  readonly sequence: number;
};

export interface ElicitationContextEvidence {
  readonly historical: boolean;
  readonly authoredContext: Json | undefined;
  readonly responseProjection: Json | undefined;
  readonly publicKey: string;
  readonly callId: string | undefined;
  readonly toolName: string | undefined;
  readonly elicitId: string | undefined;
}

/** Decodes historical lifted-tool context once at the projection boundary. */
export function elicitationContextEvidence(
  value: Json | undefined,
  fallbackKey: string,
): ElicitationContextEvidence {
  const context = jsonRecord(value);
  const nested = jsonRecord(context?.["context"]);
  const historical = typeof context?.["ephemeralTool"] === "string";
  return {
    historical,
    authoredContext: historical ? nested : context,
    responseProjection: historical ? context?.["responseSchema"] : undefined,
    publicKey:
      typeof context?.["ephemeralKey"] === "string" ? context["ephemeralKey"] : fallbackKey,
    callId:
      typeof context?.["ephemeralRoute"] === "string"
        ? context["ephemeralRoute"]
        : typeof nested?.["callId"] === "string"
          ? nested["callId"]
          : undefined,
    toolName:
      typeof context?.["ephemeralTool"] === "string"
        ? context["ephemeralTool"]
        : typeof nested?.["toolName"] === "string"
          ? nested["toolName"]
          : undefined,
    elicitId:
      typeof nested?.["elicitId"] === "string"
        ? nested["elicitId"]
        : typeof context?.["ephemeralKey"] === "string"
          ? context["ephemeralKey"]
          : undefined,
  };
}

export interface ToolFailureEnvelope {
  readonly status: "error";
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: Json;
  };
}

/** Decodes the application failure envelope before it crosses into chat events. */
export function toolFailureEnvelope(value: Json | undefined): ToolFailureEnvelope {
  const envelope = jsonRecord(value);
  const error = jsonRecord(envelope?.["error"]);
  if (
    envelope?.["status"] !== "error" ||
    typeof error?.["code"] !== "string" ||
    typeof error["message"] !== "string"
  ) {
    throw new CrankError(
      "invalid_journal",
      "Tool failure result does not contain a serialized application error",
    );
  }
  return {
    status: "error",
    error: {
      code: error["code"],
      message: error["message"],
      ...(error["details"] === undefined ? {} : { details: error["details"] }),
    },
  };
}

export function jsonRecord(value: Json | undefined): Record<string, Json> | undefined {
  return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : undefined;
}

export function placementFromJson(value: Json | undefined): TreePlacement | undefined {
  const input = jsonRecord(value);
  if (!input) return undefined;
  const nodeId = input["nodeId"];
  const parentNodeId = input["parentNodeId"];
  const sequence = input["sequence"];
  return typeof nodeId === "string" &&
    (parentNodeId === null || typeof parentNodeId === "string") &&
    typeof sequence === "number" &&
    Number.isSafeInteger(sequence) &&
    sequence >= 0
    ? { nodeId, parentNodeId, sequence }
    : undefined;
}

export function portableDescriptorFromJson(value: Json | undefined) {
  if (value === undefined) return undefined;
  try {
    return parsePortableSchemaDescriptor(value);
  } catch {
    return undefined;
  }
}
