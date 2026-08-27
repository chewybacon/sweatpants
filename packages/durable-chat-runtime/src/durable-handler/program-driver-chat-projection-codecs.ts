import type { Json } from "@sweatpants/foundation";
import { parsePortableSchemaDescriptor } from "@sweatpants/foundation/schema";

export type TreePlacement = {
  readonly nodeId: string;
  readonly parentNodeId: string | null;
  readonly sequence: number;
};

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
