import { run } from "effection";
import { describe, expect, it } from "vitest";
import type { ConversationStreamEvent } from "@sweatpants/chat-core";
import type { SessionRegistry } from "../../response-streams/index.ts";
import { reconnectResponse } from "../reconnect-response.ts";

describe("response reconnect after host loss", () => {
  it("selects durable recovery without requiring the lost response buffer", async () => {
    let acquisitions = 0;
    const registry: SessionRegistry<ConversationStreamEvent> = {
      *acquire() {
        acquisitions += 1;
        throw new Error("Session not found and no source provided");
      },
      *release() {
        throw new Error("No response reader was acquired");
      },
    };
    const result = await run(() =>
      reconnectResponse("active-execution", registry, "lost-tail", undefined),
    );
    expect(result.session).toBeUndefined();
    expect(result.recoverDetachedSession).toBe(true);
    expect(acquisitions).toBe(0);
  });
});
