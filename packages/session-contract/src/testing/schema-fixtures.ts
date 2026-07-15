import { assertJson } from "../canonical.ts";
import {
  createPortableSchemaDescriptor,
  type PortableSchemaDescriptor,
  type PortableSchemaRole,
} from "../schema-descriptor.ts";
import { standardSchemaOf, type DurableSchemaRegistryEntry } from "../schema-registry.ts";
import type { Json } from "../types.ts";

/** One reusable descriptor + validator fixture for conformance and driver tests. */
export interface SchemaFixture {
  readonly descriptor: PortableSchemaDescriptor;
  readonly entry: DurableSchemaRegistryEntry;
}

/** Creates a deterministic descriptor plus guard-backed Standard Schema validator. */
export function createSchemaFixture(
  identity: string,
  role: PortableSchemaRole,
  projection: Json,
  guard: (value: unknown) => string | undefined,
): SchemaFixture {
  const descriptor = createPortableSchemaDescriptor({
    identity,
    role,
    version: "1",
    vendor: "sweatpants",
    inputProjection: projection,
    outputProjection: projection,
    fidelity: { input: "explicit", output: "explicit" },
  });
  const entry: DurableSchemaRegistryEntry = {
    descriptor,
    schema: standardSchemaOf("sweatpants", (value) => {
      const message = guard(value);
      return message === undefined ? { value: assertJson(value) } : { issues: [{ message }] };
    }),
  };
  return { descriptor, entry };
}

/** Guard fixture accepting only strings. */
export const stringGuard = (value: unknown): string | undefined =>
  typeof value === "string" ? undefined : "value must be a string";

/** Guard fixture accepting only booleans. */
export const booleanGuard = (value: unknown): string | undefined =>
  typeof value === "boolean" ? undefined : "value must be a boolean";

/** Guard fixture accepting only null. */
export const nullGuard = (value: unknown): string | undefined =>
  value === null ? undefined : "value must be null";

/** Guard fixture accepting any canonical JSON. */
export const anyGuard = (value: unknown): string | undefined => {
  try {
    assertJson(value);
    return undefined;
  } catch {
    return "value must be canonical JSON";
  }
};
