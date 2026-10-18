import { z } from "zod";

/** Omit undefined values only for fields explicitly declared with .optional(). */
export function omitUndefinedOptionals<Schema extends z.ZodObject>(schema: Schema) {
  const optionalKeys = Object.entries(schema.shape)
    .filter(([, field]) => field instanceof z.ZodOptional)
    .map(([key]) => key);

  return schema.transform((value) => {
    for (const key of optionalKeys) {
      if (value[key] === undefined) {
        delete value[key];
      }
    }
    return value;
  });
}
