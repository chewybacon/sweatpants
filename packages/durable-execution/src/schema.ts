import {
  createPortableSchemaDescriptor,
  parsePortableSchemaDescriptor,
  type PortableSchemaDescriptor,
} from "@sweatpants/foundation/schema";
import { CrankError } from "./errors.ts";

/** Closed descriptor-role algebra accepted by durable program boundaries. */
export type ProgramSchemaRole =
  | "program_input"
  | "program_output"
  | "elicit_response"
  | "elicit_context";

export type ProgramSchemaDescriptor = PortableSchemaDescriptor<ProgramSchemaRole>;

/** Scheduler/child JSON boundaries are durable-execution vocabulary, not generic Foundation. */
export const NULL_RESULT_SCHEMA_DESCRIPTOR = createPortableSchemaDescriptor({
  identity: "sweatpants/builtin/null-result",
  role: "builtin" as const,
  version: "1",
  vendor: "sweatpants",
  inputProjection: { type: "null" },
  outputProjection: { type: "null" },
  fidelity: { input: "lossless", output: "lossless" },
});

export const ANY_JSON_SCHEMA_DESCRIPTOR = createPortableSchemaDescriptor({
  identity: "sweatpants/builtin/any-json",
  role: "builtin" as const,
  version: "1",
  vendor: "sweatpants",
  inputProjection: true,
  outputProjection: true,
  fidelity: { input: "lossless", output: "lossless" },
});

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
