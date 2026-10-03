import { afterEach, expect, it, vi } from "vitest";
afterEach(() => {
  vi.resetModules();
});
it("does not preload renderers when chat initializes", async () => {
  const preload = vi.fn(function* () {});
  const { createChatClient } = await import("../index.ts");
  const client = createChatClient({
    pipeline: {
      processors: [
        {
          name: "deferred",
          dependencies: [],
          preload,
          *process(frame) {
            return frame;
          },
        },
      ],
    },
    initialConversation: "new",
    connection: {
      *sendMessages() {
        throw new Error("No transport requests expected");
      },
      *reconnectToStream() {
        return null;
      },
      *disconnect() {},
    },
  });
  try {
    await client.initialized;
    expect(client.getSnapshot().renderStatus).toBe("ready");
    expect(client.getSnapshot().canSendMessage).toBe(true);
    expect(preload).not.toHaveBeenCalled();
  } finally {
    await client.close();
  }
});
