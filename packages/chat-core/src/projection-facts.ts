import type { Json } from "@sweatpants/foundation";
import type { ProjectionFactEnvelope } from "@sweatpants/durable-execution";
import { z } from "zod";

const chatTurnHistoryEntrySchema = z
  .object({
    type: z.literal("chat_turn"),
    executionId: z.string(),
    turnId: z.string(),
    events: z.array(z.json()),
    outcome: z.json(),
  })
  .loose();

export const CHAT_TURN_COMPLETED_FACT = "chat.turn.completed";

export type ChatTurnHistoryEntry = {
  readonly type: "chat_turn";
  readonly executionId: string;
  readonly turnId: string;
  readonly outcome: Json;
  readonly events: Json[];
};

export function createChatTurnCompletedFact(request: {
  readonly executionId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly outcome: Json;
  readonly events: readonly Json[];
}): ProjectionFactEnvelope {
  return {
    executionId: request.executionId,
    sessionId: request.sessionId,
    turnId: request.turnId,
    sequence: 1,
    kind: CHAT_TURN_COMPLETED_FACT,
    payload: {
      type: "chat_turn",
      executionId: request.executionId,
      turnId: request.turnId,
      outcome: request.outcome,
      events: [...request.events],
    },
  };
}

/** Projects only the explicit chat fact contract, never private authority records. */
export function projectChatTurnFacts(
  facts: readonly ProjectionFactEnvelope[],
): readonly ChatTurnHistoryEntry[] {
  return facts.map((fact) => {
    if (fact.kind !== CHAT_TURN_COMPLETED_FACT || !isChatTurnHistoryEntry(fact.payload)) {
      throw new Error(`Unsupported chat Projection Fact: ${fact.kind}`);
    }
    return fact.payload;
  });
}

function isChatTurnHistoryEntry(value: Json): value is ChatTurnHistoryEntry {
  return chatTurnHistoryEntrySchema.safeParse(value).success;
}
