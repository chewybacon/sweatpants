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
  const historical = typeof context?.["foreignTool"] === "string";
  return {
    historical,
    authoredContext: historical ? nested : context,
    responseProjection: historical ? context?.["responseSchema"] : undefined,
    publicKey: typeof context?.["foreignKey"] === "string" ? context["foreignKey"] : fallbackKey,
    callId:
      typeof context?.["foreignRoute"] === "string"
        ? context["foreignRoute"]
        : typeof nested?.["callId"] === "string"
          ? nested["callId"]
          : undefined,
    toolName:
      typeof context?.["foreignTool"] === "string"
        ? context["foreignTool"]
        : typeof nested?.["toolName"] === "string"
          ? nested["toolName"]
          : undefined,
    elicitId:
      typeof nested?.["elicitId"] === "string"
        ? nested["elicitId"]
        : typeof context?.["foreignKey"] === "string"
          ? context["foreignKey"]
          : undefined,
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
