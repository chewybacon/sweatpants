import {
  parsePortableSchemaDescriptor,
  type PortableSchemaDescriptor,
} from "@sweatpants/foundation/schema";

/** Closed schema roles owned by the author-facing tool/resource SDK. */
export type ToolResourceSchemaRole = "tool_parameters" | "tool_output";
export type ToolResourceSchemaDescriptor = PortableSchemaDescriptor<ToolResourceSchemaRole>;

export function isToolResourceSchemaRole(role: string): role is ToolResourceSchemaRole {
  return role === "tool_parameters" || role === "tool_output";
}

export function parseToolResourceSchemaDescriptor(value: unknown): ToolResourceSchemaDescriptor {
  const descriptor = parsePortableSchemaDescriptor(value);
  if (!isToolResourceSchemaRole(descriptor.role)) {
    throw new TypeError(`Invalid tool/resource schema role: ${descriptor.role}`);
  }
  return { ...descriptor, role: descriptor.role };
}
