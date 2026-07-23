import { describe, expect, it } from "vitest";

import {
  STUDIO_CONVERSATION_KEY,
  getOrCreateConversationId,
  replaceConversationId,
} from "./session-id.ts";

function storage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  };
}

describe("yo-studio conversation identity", () => {
  it("survives page reconstruction and replaces identity only on new session", () => {
    const persisted = storage();
    expect(getOrCreateConversationId(persisted, () => "conversation-1")).toBe("conversation-1");
    expect(getOrCreateConversationId(persisted, () => "unused")).toBe("conversation-1");
    expect(replaceConversationId(persisted, () => "conversation-2")).toBe("conversation-2");
    expect(persisted.values.get(STUDIO_CONVERSATION_KEY)).toBe("conversation-2");
  });
});
