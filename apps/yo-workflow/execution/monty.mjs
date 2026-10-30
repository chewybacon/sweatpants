import { readFileContract } from "@sweatpants/flowmode-runtime-monty/contract";
import { createMontyProgram } from "@sweatpants/flowmode-runtime-monty/program";
import {
  demoSource,
  cleanupSource,
  errorSource,
  anyioSource,
} from "@sweatpants/flowmode-runtime-monty/guest";
import { ANY_JSON_SCHEMA_DESCRIPTOR as schema } from "@sweatpants/durable-execution";
import { createPortableSchemaDescriptor } from "@sweatpants/foundation/schema";
import { z } from "zod";
const replyValidator = z.union([
  z.strictObject({ operationId: z.number().int().nonnegative(), value: z.string().max(12000) }),
  z.strictObject({
    operationId: z.number().int().nonnegative(),
    error: z.strictObject({
      type: z.enum(readFileContract.errors),
      message: z.string().max(12000),
    }),
  }),
]);
const replyShape = z.toJSONSchema(replyValidator);
const operationReply = createPortableSchemaDescriptor({
  identity: "yo-workflow/monty-operation-reply",
  role: "elicit_response",
  version: "2",
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
    examples: { cleanup: cleanupSource, error: errorSource, anyio: anyioSource },
    schemas: [{ descriptor: operationReply, schema: replyValidator }],
    *buildProgram(source) {
      const program = createMontyProgram(
        {
          source,
          contract: {
            programId: "monty-concurrent-reads",
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
              message: "Fulfill a read from the bounded demo fixtures",
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

// Explicit local data only. No path is ever passed to an OS filesystem API.
export const readFixtures = Object.freeze({
  "a.txt": "Contents of a.txt",
  "b.txt": "Contents of b.txt",
  "c.txt": "Contents of c.txt",
  "d.txt": "Contents of d.txt",
  "e.txt": "Contents of e.txt",
  "cleanup-a.txt": "A cleanup acknowledged",
  "cleanup-b.txt": "B cleanup acknowledged",
  "session-cleanup.txt": "Session cleanup acknowledged",
});
export function fulfillRead(operation) {
  const request = operation?.request;
  if (
    request?.capability !== readFileContract.capability ||
    !Object.hasOwn(readFixtures, request.arguments.path)
  ) {
    throw Error("Read is outside the demo fixture allowlist");
  }
  return readFixtures[request.arguments.path];
}
