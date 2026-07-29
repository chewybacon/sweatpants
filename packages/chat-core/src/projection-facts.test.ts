import { describe, expect, it } from "vitest";
import {
  CHAT_TURN_COMPLETED_FACT,
  createChatTurnCompletedFact,
  projectChatTurnFacts,
} from "./projection-facts.ts";

describe("chat Projection Facts", () => {
  it("projects explicit accepted Turn facts without private authority records", () => {
    const fact = createChatTurnCompletedFact({
      executionId: "execution-1",
      sessionId: "session-1",
      turnId: "turn-1",
      outcome: "done",
      events: [{ type: "RUN_FINISHED" }],
    });
    expect(fact.kind).toBe(CHAT_TURN_COMPLETED_FACT);
    expect(projectChatTurnFacts([fact])).toEqual([
      {
        type: "chat_turn",
        executionId: "execution-1",
        turnId: "turn-1",
        outcome: "done",
        events: [{ type: "RUN_FINISHED" }],
      },
    ]);
  });

  it("rejects facts outside the chat bounded context", () => {
    expect(() =>
      projectChatTurnFacts([
        {
          executionId: "execution-1",
          sessionId: "session-1",
          turnId: "turn-1",
          sequence: 1,
          kind: "private.task_record",
          payload: {},
        },
      ]),
    ).toThrow("Unsupported chat Projection Fact");
  });
});
