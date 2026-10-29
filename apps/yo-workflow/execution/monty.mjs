import { createMontyProgram } from "@sweatpants/flowmode-runtime-monty/program";
import { demoSource } from "@sweatpants/flowmode-runtime-monty/guest";
import { ANY_JSON_SCHEMA_DESCRIPTOR as schema } from "@sweatpants/durable-execution";
import { createPortableSchemaDescriptor } from "@sweatpants/foundation/schema";
import { z } from "zod";
const replyValidator = z.strictObject({
  operationId: z.number().int().nonnegative(),
  value: z.string().max(12000),
});
const replyShape = z.toJSONSchema(replyValidator);
const operationReply = createPortableSchemaDescriptor({
  identity: "yo-workflow/monty-operation-reply",
  role: "elicit_response",
  version: "1",
  vendor: "sweatpants",
  inputProjection: replyShape,
  outputProjection: replyShape,
  fidelity: { input: "lossless", output: "lossless" },
});
export function createMontyStack(loadModule) {
  return {
    descriptor: {
      id: "monty",
      label: "Python",
      runtime: "Monty / Wasm",
      developerLanguage: "Python",
    },
    caller: demoSource,
    schemas: [{ descriptor: operationReply, schema: replyValidator }],
    *buildProgram(source) {
      const program = createMontyProgram(
        {
          source,
          contract: {
            programId: "monty-concurrent-review",
            version: "1",
            inputSchema: schema,
            outputSchema: schema,
            effects: {},
            elicits: { operations: { response: operationReply } },
            capabilities: { durableEmissions: false, structuredChildren: false, replay: "strict" },
          },
          bindOperation(request) {
            if (request.binding !== "monty.operations") {
              throw Error("Unknown Python operation contract");
            }
            return {
              kind: "elicit",
              key: "operations",
              message: "Choose an operation to complete",
              response: operationReply,
              binding: { id: request.site },
            };
          },
        },
        loadModule,
      );
      return { ...program, developerSource: source, compiledSites: [] };
    },
  };
}
