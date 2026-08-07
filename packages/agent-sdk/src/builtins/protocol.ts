import type { StandardSchemaV1 } from "@standard-schema/spec";
import { z } from "zod";
import { createProtocol } from "../protocol/create.ts";
import type { Method, Protocol } from "../protocol/types.ts";

/**
 * Schema for elicit options sent over the wire.
 */
const ElicitPayloadSchema = z.strictObject({
  type: z.string(),
  message: z.string(),
  schemaDescriptor: z.record(z.string(), z.json()).optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Schema for elicit result.
 */
const ElicitResultSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("accept"), content: z.unknown() }),
  z.strictObject({ action: z.literal("decline"), reason: z.string().optional() }),
  z.strictObject({ action: z.literal("cancel"), reason: z.string().optional() }),
]);

/**
 * Schema for notify options sent over the wire.
 */
const NotifyPayloadSchema = z.strictObject({
  message: z.string(),
  progress: z.number().optional(),
  level: z.enum(["info", "warning", "error", "success"]).optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Schema for notify result.
 */
const NotifyResultSchema = z.strictObject({
  ok: z.boolean(),
});

/**
 * Schema for sample message.
 */
const SampleMessageSchema = z.strictObject({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string(),
});

/**
 * Schema for sample options sent over the wire.
 */
const SamplePayloadSchema = z.strictObject({
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
const SampleResultSchema = z.strictObject({
  text: z.string(),
  usage: z
    .object({
      promptTokens: z.number(),
      completionTokens: z.number(),
      totalTokens: z.number(),
    })
    .optional(),
  model: z.string().optional(),
  finishReason: z.enum(["stop", "length", "content_filter", "tool_calls"]).optional(),
});

export interface BuiltinElicitPayload {
  readonly type: string;
  readonly message: string;
  readonly schemaDescriptor?: Record<string, unknown>;
  readonly meta?: Record<string, unknown>;
}

export type BuiltinElicitResult =
  | { readonly action: "accept"; readonly content: unknown }
  | { readonly action: "decline"; readonly reason?: string }
  | { readonly action: "cancel"; readonly reason?: string };

export interface BuiltinNotifyPayload {
  readonly message: string;
  readonly progress?: number;
  readonly level?: "info" | "warning" | "error" | "success";
  readonly meta?: Record<string, unknown>;
}

export interface BuiltinNotifyResult {
  readonly ok: boolean;
}

export interface BuiltinSampleMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export interface BuiltinSamplePayload {
  readonly prompt: string | readonly BuiltinSampleMessage[];
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly stop?: readonly string[];
  readonly model?: string;
  readonly meta?: Record<string, unknown>;
}

export interface BuiltinSampleResult {
  readonly text: string;
  readonly usage?: {
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly totalTokens: number;
  };
  readonly model?: string;
  readonly finishReason?: "stop" | "length" | "content_filter" | "tool_calls";
}

type BuiltinMethod<I, O> = Method<
  StandardSchemaV1<unknown, I>,
  StandardSchemaV1<unknown, never>,
  StandardSchemaV1<unknown, O>
>;

type BuiltinMethods = {
  readonly elicit: BuiltinMethod<BuiltinElicitPayload, BuiltinElicitResult>;
  readonly notify: BuiltinMethod<BuiltinNotifyPayload, BuiltinNotifyResult>;
  readonly sample: BuiltinMethod<BuiltinSamplePayload, BuiltinSampleResult>;
};

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
export const SweatpantsProtocol: Protocol<BuiltinMethods> = createProtocol({
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
} as unknown as BuiltinMethods);
