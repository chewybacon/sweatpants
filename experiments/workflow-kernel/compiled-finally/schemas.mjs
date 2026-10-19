// Uses the workspace's existing built schema/registry APIs. Validators stay out of snapshots.
import { createRequire } from "node:module";
import { createPortableSchemaDescriptor } from "../../../packages/foundation/dist/schema.js";
import {
  createDurableSchemaRegistry,
  parseRegisteredSchema,
} from "../../../packages/journal-authority/dist/index.js";
const { z } = createRequire(new URL("../../../packages/vite-plugin/package.json", import.meta.url))(
  "zod",
);
function binding(identity, version, schema) {
  const projection = z.toJSONSchema(schema);
  const descriptor = createPortableSchemaDescriptor({
    identity,
    version,
    role: "workflow_reply",
    vendor: "zod",
    inputProjection: projection,
    outputProjection: projection,
    fidelity: { input: "lossless", output: "lossless" },
  });
  return { descriptor, schema };
}
export const textV1 = binding("spike.text", "1", z.string().max(100));
export const textV2 = binding("spike.text", "2", z.enum(["yes", "no"]));
export const choice = binding(
  "spike.choice",
  "1",
  z.strictObject({ seat: z.enum(["window", "aisle"]), count: z.number().int().min(1).max(4) }),
);
export const ack = binding("spike.ack", "1", z.null());
export const bindings = [textV1, textV2, choice, ack];
export const schemas = createDurableSchemaRegistry(bindings);
export { createDurableSchemaRegistry, parseRegisteredSchema };
