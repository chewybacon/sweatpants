import { createApi } from "effection/experimental";
import type { Operation, Subscription } from "effection";
import type { ZodSchema } from "zod";
import { TransportContext } from "../context/transport.ts";
import type { ElicitResponse, NotifyResponse } from "../types/transport.ts";
import type {
  ElicitOptions,
  ElicitResult,
  NotifyOptions,
  NotifyResult,
  SampleOptions,
  SampleResult,
} from "./types.ts";

/**
 * Generate a unique request ID.
 */
function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * The Sweatpants API for framework operations.
 * 
 * These operations route through the transport to the Operative (UI) side:
 * - elicit: Request structured data from the user
 * - notify: Send notifications/status updates
 * - sample: Request LLM completions
 * 
 * @example
 * ```ts
 * // Use operations directly
 * const result = yield* SweatpantsApi.operations.elicit({ ... });
 * 
 * // Add middleware
 * yield* SweatpantsApi.decorate({
 *   *sample([options], next) {
 *     console.log("Sampling:", options.prompt);
 *     return yield* next(options);
 *   },
 * });
 * ```
 */
export const SweatpantsApi = createApi("sweatpants", {
  /**
   * Elicit structured data from the user.
   * 
   * @example
   * ```ts
   * const result = yield* elicit({
   *   type: "confirmation",
   *   message: "Are you sure you want to proceed?",
   *   schema: z.boolean(),
   * });
   * 
   * if (result.status === "accepted") {
   *   console.log("User confirmed:", result.value);
   * }
   * ```
   */
  *elicit<TSchema extends ZodSchema>(
    options: ElicitOptions<TSchema>,
  ): Operation<ElicitResult<TSchema>> {
    const transport = yield* TransportContext.expect();
    const requestId = generateId("elicit");

    const stream = transport.request<unknown, ElicitResponse>({
      id: requestId,
      kind: "elicit",
      type: options.type,
      payload: {
        message: options.message,
        schema: options.schema,
        meta: options.meta,
      },
    });

    const subscription: Subscription<unknown, ElicitResponse> = yield* stream;

    // Consume progress updates (if any)
    let result = yield* subscription.next();
    while (!result.done) {
      result = yield* subscription.next();
    }

    const response = result.value;

    if (response.status === "accepted") {
      // Validate and return the content
      // In a real implementation, we'd validate against the schema
      type AcceptedResult = Extract<ElicitResult<TSchema>, { status: "accepted" }>;
      return { status: "accepted", value: response.content as AcceptedResult["value"] };
    } else if (response.status === "declined") {
      return { status: "declined" };
    } else if (response.status === "cancelled") {
      return { status: "cancelled" };
    } else if (response.status === "denied") {
      throw new Error("Elicit request was denied");
    } else if (response.status === "other") {
      throw new Error(`Elicit request failed: ${response.content}`);
    }

    throw new Error("Unexpected elicit response status");
  },

  /**
   * Send a notification to the user.
   * 
   * @example
   * ```ts
   * yield* notify({ message: "Processing your request...", progress: 0.5 });
   * ```
   */
  *notify(options: NotifyOptions): Operation<NotifyResult> {
    const transport = yield* TransportContext.expect();
    const requestId = generateId("notify");

    const stream = transport.request<unknown, NotifyResponse>({
      id: requestId,
      kind: "notify",
      type: "notification",
      payload: {
        message: options.message,
        progress: options.progress,
        level: options.level ?? "info",
        meta: options.meta,
      },
    });

    const subscription: Subscription<unknown, NotifyResponse> = yield* stream;

    // Consume until done
    let result = yield* subscription.next();
    while (!result.done) {
      result = yield* subscription.next();
    }

    const response = result.value;
    return { ok: response.ok };
  },

  /**
   * Request an LLM completion.
   * 
   * @example
   * ```ts
   * const result = yield* sample({
   *   prompt: "Explain quantum computing in simple terms",
   *   maxTokens: 150,
   * });
   * 
   * console.log(result.text);
   * ```
   */
  *sample(options: SampleOptions): Operation<SampleResult> {
    const transport = yield* TransportContext.expect();
    const requestId = generateId("sample");

    const stream = transport.request<unknown, ElicitResponse>({
      id: requestId,
      kind: "elicit",
      type: "sample",
      payload: {
        prompt: options.prompt,
        maxTokens: options.maxTokens,
        temperature: options.temperature,
        stop: options.stop,
        model: options.model,
        meta: options.meta,
      },
    });

    const subscription: Subscription<unknown, ElicitResponse> = yield* stream;

    // Consume until done
    let result = yield* subscription.next();
    while (!result.done) {
      result = yield* subscription.next();
    }

    const response = result.value;

    if (response.status === "accepted") {
      return response.content as SampleResult;
    } else if (response.status === "declined") {
      throw new Error("Sample request was declined");
    } else if (response.status === "cancelled") {
      throw new Error("Sample request was cancelled");
    } else if (response.status === "denied") {
      throw new Error("Sample request was denied");
    } else if (response.status === "other") {
      throw new Error(`Sample request failed: ${response.content}`);
    }

    throw new Error("Unexpected sample response status");
  },
});

/**
 * Export individual operations for direct use.
 */
export const { elicit, notify, sample } = SweatpantsApi.operations;
