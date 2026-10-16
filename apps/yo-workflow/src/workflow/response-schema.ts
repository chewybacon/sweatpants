import { z } from "zod";

/** A deliberately bounded JSON Schema vocabulary for model-authored response contracts. */
const responseContract: z.ZodType = z.lazy(() =>
  z
    .object({
      type: z
        .enum(["object", "array", "string", "number", "integer", "boolean", "null"])
        .optional(),
      description: z.string().max(4096).optional(),
      properties: z.record(z.string(), responseContract).optional(),
      required: z.array(z.string()).max(128).optional(),
      additionalProperties: z.boolean().optional(),
      items: responseContract.optional(),
      enum: z
        .array(z.union([z.string(), z.number(), z.boolean(), z.null()]))
        .min(1)
        .max(128)
        .optional(),
      const: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
      anyOf: z.array(responseContract).min(1).max(16).optional(),
      minimum: z.number().optional(),
      maximum: z.number().optional(),
      minLength: z.number().int().nonnegative().optional(),
      maxLength: z.number().int().nonnegative().optional(),
      minItems: z.number().int().nonnegative().optional(),
      maxItems: z.number().int().nonnegative().optional(),
    })
    .strict(),
);

export function responseSchema(value: Record<string, unknown>): z.ZodType {
  // Bound traversal before entering either recursive schema implementation.
  function checkDepth(node: unknown, depth: number): void {
    if (depth > 32) {
      throw new Error("Response schema exceeds maximum depth of 32");
    }
    if (node !== null && typeof node === "object") {
      for (const child of Object.values(node)) {
        checkDepth(child, depth + 1);
      }
    }
  }
  checkDepth(value, 0);
  responseContract.parse(value);
  return compileResponseSchema(value);
}

type ResponseContract = {
  type?: string;
  properties?: Record<string, ResponseContract>;
  required?: string[];
  additionalProperties?: boolean;
  items?: ResponseContract;
  enum?: (string | number | boolean | null)[];
  const?: string | number | boolean | null;
  anyOf?: ResponseContract[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  description?: string;
};

/** Compile only the advertised vocabulary with the workspace's Zod version. */
function compileResponseSchema(schema: ResponseContract): z.ZodType {
  let result: z.ZodType;
  switch (schema.type) {
    case "object": {
      const required = new Set(schema.required ?? []);
      const properties = schema.properties ?? {};
      if ([...required].some((key) => !Object.hasOwn(properties, key))) {
        throw new Error("Required schema fields must be declared in properties");
      }
      const shape = Object.fromEntries(
        Object.entries(properties).map(([key, child]) => {
          const field = compileResponseSchema(child);
          return [key, required.has(key) ? field : field.optional()];
        }),
      );
      result = schema.additionalProperties === false ? z.strictObject(shape) : z.looseObject(shape);
      break;
    }
    case "array": {
      let array = z.array(schema.items ? compileResponseSchema(schema.items) : z.json());
      if (schema.minItems !== undefined) {
        array = array.min(schema.minItems);
      }
      if (schema.maxItems !== undefined) {
        array = array.max(schema.maxItems);
      }
      result = array;
      break;
    }
    case "string": {
      let string = z.string();
      if (schema.minLength !== undefined) {
        string = string.min(schema.minLength);
      }
      if (schema.maxLength !== undefined) {
        string = string.max(schema.maxLength);
      }
      result = string;
      break;
    }
    case "number":
    case "integer": {
      let number = schema.type === "integer" ? z.number().int() : z.number();
      if (schema.minimum !== undefined) {
        number = number.min(schema.minimum);
      }
      if (schema.maximum !== undefined) {
        number = number.max(schema.maximum);
      }
      result = number;
      break;
    }
    case "boolean":
      result = z.boolean();
      break;
    case "null":
      result = z.null();
      break;
    default:
      result = z.unknown();
  }
  for (const [keyword, type] of [
    ["properties", "object"],
    ["required", "object"],
    ["additionalProperties", "object"],
    ["items", "array"],
    ["minItems", "array"],
    ["maxItems", "array"],
    ["minLength", "string"],
    ["maxLength", "string"],
    ["minimum", "number"],
    ["maximum", "number"],
  ] as const) {
    if (
      keyword in schema &&
      schema.type !== type &&
      !(type === "number" && schema.type === "integer")
    ) {
      throw new Error(`${keyword} requires an explicit ${type} schema type`);
    }
  }
  let constrained = schema.type !== undefined;
  function constrain(next: z.ZodType): void {
    result = constrained ? z.intersection(result, next) : next;
    constrained = true;
  }
  if (schema.enum !== undefined) {
    constrain(z.union(schema.enum.map((value) => z.literal(value))));
  }
  if ("const" in schema) {
    constrain(z.literal(schema.const!));
  }
  if (schema.anyOf !== undefined) {
    constrain(z.union(schema.anyOf.map(compileResponseSchema)));
  }
  return schema.description === undefined ? result : result.describe(schema.description);
}
