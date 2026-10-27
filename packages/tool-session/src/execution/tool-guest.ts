import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { JournalRequest, ToolDefinition } from "@sweatpants/agent-sdk";
import { toolImplementation } from "@sweatpants/agent-sdk/internal/tool-execution";
import type { Json } from "@sweatpants/foundation";
import {
  success,
  failure,
  type Outcome,
  type IterableOperation,
} from "@sweatpants/foundation/computation";
import { createIteratorGuest } from "@sweatpants/primitive-journal";

/** Chat admission policy: preserve Result inside completion data; transport failures stay native. */
export function createToolGuest<P extends StandardSchemaV1, Result>(
  tool: ToolDefinition<P, Result>,
  input: unknown,
  callId: string,
) {
  return createIteratorGuest(function* (): IterableOperation<
    Outcome<Result, Json>,
    JournalRequest
  > {
    try {
      return success(yield* toolImplementation(tool).invoke(input, callId));
    } catch (error) {
      return failure(error instanceof Error ? error.message : String(error));
    }
  });
}
