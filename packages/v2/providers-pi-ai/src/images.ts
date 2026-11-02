import { z } from "zod";
import type { ImageProvider } from "@sweatpan.ts/providers";
import type { Runtime } from "@sweatpan.ts/runtime";
import type { PiAiImageProviderOptions } from "./contracts.ts";
import { encodeContent } from "./content.ts";
import { decodeUsage, usageSchema } from "./decode.ts";

const schema = z.object({
  api: z.string(),
  provider: z.string(),
  model: z.string(),
  responseId: z.string().optional(),
  output: z.array(
    z.discriminatedUnion("type", [
      z.object({ type: z.literal("text"), text: z.string() }),
      z.object({
        type: z.literal("image"),
        data: z
          .string()
          .min(1)
          .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
        mimeType: z.string().startsWith("image/"),
      }),
    ]),
  ),
  usage: usageSchema.optional(),
  stopReason: z.literal("stop"),
  errorMessage: z.never().optional(),
});

/** Image generation/editing using the host-owned SDK registry and scoped cancellation. */
export function createPiAiImageProvider<Y>(
  runtime: Runtime<Y>,
  options: PiAiImageProviderOptions,
): ImageProvider<Y> {
  const model = structuredClone(options.model);
  const generate = options.generate;
  const apiKey = options.apiKey;
  return {
    *generate(request) {
      const input = encodeContent(structuredClone(request.input), model.input);
      const raw = yield* runtime.fromPromise((signal) =>
        generate(structuredClone(model), { input }, { apiKey, signal, maxRetries: 0 }),
      );
      const parsed = schema.safeParse(raw);
      if (!parsed.success) {
        throw new Error("Invalid or failed pi-ai image response");
      }
      const result = parsed.data;
      return {
        output: result.output.map((part) =>
          part.type === "text"
            ? part
            : {
                type: "image" as const,
                source: { type: "data" as const, value: part.data, mimeType: part.mimeType },
                metadata: null,
              },
        ),
        source: {
          api: result.api,
          provider: result.provider,
          model: result.model,
          responseModel: null,
        },
        responseId: result.responseId ?? null,
        usage: result.usage === undefined ? null : decodeUsage(result.usage),
      };
    },
  };
}
