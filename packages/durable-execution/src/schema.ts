import {
  parsePortableSchemaDescriptor,
  type PortableSchemaDescriptor,
} from "@sweatpants/foundation/schema-descriptor";
import { CrankError } from "./errors.ts";

/** Closed descriptor-role algebra accepted by durable program boundaries. */
export type ProgramSchemaRole =
  | "program_input"
  | "program_output"
  | "elicit_response"
  | "elicit_context";

export type ProgramSchemaDescriptor = PortableSchemaDescriptor<ProgramSchemaRole>;

export function isProgramSchemaRole(role: string): role is ProgramSchemaRole {
  return (
    role === "program_input" ||
    role === "program_output" ||
    role === "elicit_response" ||
    role === "elicit_context"
  );
}

/** Parses generic persisted mechanics and then enforces the program role algebra. */
export function parseProgramSchemaDescriptor(value: unknown): ProgramSchemaDescriptor {
  const descriptor = parsePortableSchemaDescriptor(value);
  if (!isProgramSchemaRole(descriptor.role)) {
    throw new CrankError(
      "invalid_schema_descriptor",
      `Invalid program schema role: ${descriptor.role}`,
    );
  }
  return { ...descriptor, role: descriptor.role };
}
