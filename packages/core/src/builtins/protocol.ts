import { z } from "zod";
import { createProtocol } from "../protocol/create.ts";

/**
 * Schema for elicit options sent over the wire.
 */
const ElicitPayloadSchema = z.object({
  type: z.string(),
  message: z.string(),
  schema: z.unknown(), // Zod schema serialized
  meta: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Schema for elicit result.
 */
const ElicitResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("accepted"), value: z.unknown() }),
  z.object({ status: z.literal("declined") }),
  z.object({ status: z.literal("cancelled") }),
]);

/**
 * Schema for notify options sent over the wire.
 */
const NotifyPayloadSchema = z.object({
  message: z.string(),
  progress: z.number().optional(),
  level: z.enum(["info", "warning", "error", "success"]).optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Schema for notify result.
 */
const NotifyResultSchema = z.object({
  ok: z.boolean(),
});

/**
 * Schema for sample message.
 */
const SampleMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string(),
});

/**
 * Schema for sample options sent over the wire.
 */
const SamplePayloadSchema = z.object({
  prompt: z.union([z.string(), z.array(SampleMessageSchema)]),
  maxTokens: z.number().optional(),
  temperature: z.number().optional(),
  stop: z.array(z.string()).optional(),
  model: z.string().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Schema for sample result.
 */
const SampleResultSchema = z.object({
  text: z.string(),
  usage: z.object({
    promptTokens: z.number(),
    completionTokens: z.number(),
    totalTokens: z.number(),
  }).optional(),
  model: z.string().optional(),
  finishReason: z.enum(["stop", "length", "content_filter", "tool_calls"]).optional(),
});

/**
 * The Sweatpants Protocol defines the built-in operations that can be
 * invoked by the Principal (agent) and handled by the Operative (UI).
 * 
 * Use this protocol with `createImplementation` on the operative side
 * to handle elicit, notify, and sample requests.
 * 
 * @example
 * ```ts
 * // On the operative side
 * const inspector = createImplementation(SweatpantsProtocol, function*() {
 *   return {
 *     elicit(payload) {
 *       return resource(function*(provide) {
 *         // Show UI, get user input
 *         const value = yield* showElicitDialog(payload);
 *         yield* provide({
 *           *next() {
 *             return { done: true, value: { status: "accepted", value } };
 *           }
 *         });
 *       });
 *     },
 *     notify(payload) { ... },
 *     sample(payload) { ... },
 *   };
 * });
 * 
 * const handle = yield* inspector.attach();
 * yield* serveProtocol(handle, operativeTransport);
 * ```
 */
export const SweatpantsProtocol = createProtocol({
  /**
   * Elicit structured data from the user.
   * The operative should display appropriate UI based on the type and schema.
   */
  elicit: {
    input: ElicitPayloadSchema,
    progress: z.never(),
    output: ElicitResultSchema,
  },

  /**
   * Send a notification to the user.
   * The operative should display the notification appropriately.
   */
  notify: {
    input: NotifyPayloadSchema,
    progress: z.never(),
    output: NotifyResultSchema,
  },

  /**
   * Request an LLM completion.
   * The operative should route this to an LLM provider.
   */
  sample: {
    input: SamplePayloadSchema,
    progress: z.never(),
    output: SampleResultSchema,
  },
});

// Export schemas for use in implementations
export {
  ElicitPayloadSchema,
  ElicitResultSchema,
  NotifyPayloadSchema,
  NotifyResultSchema,
  SamplePayloadSchema,
  SampleResultSchema,
  SampleMessageSchema,
};
