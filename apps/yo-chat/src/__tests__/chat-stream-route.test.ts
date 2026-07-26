import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/chat-application", () => ({
  chatApp: {
    handle: vi.fn(),
  },
}));

import { chatApp } from "@/server/chat-application";
import { forwardSnapshotAwareChatRead } from "@/routes/api/streams/chat/$threadId";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function ndjsonFrames(events: unknown[]): string {
  return events.map((event, index) => JSON.stringify({ lsn: index + 1, event })).join("\n") + "\n";
}

describe("snapshot-aware raw chat stream route", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("unwraps durable /api/chat frames into raw AG-UI NDJSON events", async () => {
    const handleSpy = vi.spyOn(chatApp, "handle").mockResolvedValue(
      new Response(
        ndjsonFrames([
          { type: "MESSAGES_SNAPSHOT", messages: [{ id: "user:1", role: "user", content: "hi" }] },
          { type: "STATE_SNAPSHOT", snapshot: {} },
        ]),
        {
          status: 200,
          headers: {
            "Content-Type": "application/x-ndjson",
            "Stream-Next-Offset": "0000000000000002",
            "Stream-Cursor-Reset": "true",
            "X-Session-Id": "session-1",
          },
        },
      ),
    );

    const response = await forwardSnapshotAwareChatRead(
      new Request("http://localhost/api/streams/chat/thread-1?offset=0", { method: "GET" }),
      "thread-1",
    );

    expect(handleSpy).toHaveBeenCalledTimes(1);
    const forwarded = new URL(handleSpy.mock.calls[0]![0].url);
    expect(forwarded.pathname).toBe("/api/chat");
    expect(forwarded.searchParams.get("conversationId")).toBe("thread-1");
    expect(forwarded.searchParams.get("offset")).toBe("0");

    expect(response.headers.get("Content-Type")).toBe("application/x-ndjson");
    expect(response.headers.get("Stream-Next-Offset")).toBe("0000000000000002");
    expect(response.headers.get("Stream-Cursor-Reset")).toBe("true");
    expect(response.headers.get("X-Session-Id")).toBeNull();

    const body = await response.text();
    expect(body).toBe(
      [
        JSON.stringify({
          type: "MESSAGES_SNAPSHOT",
          messages: [{ id: "user:1", role: "user", content: "hi" }],
        }),
        JSON.stringify({ type: "STATE_SNAPSHOT", snapshot: {} }),
        "",
      ].join("\n"),
    );
  });

  it("returns HEAD metadata without a body", async () => {
    vi.spyOn(chatApp, "handle").mockResolvedValue(
      new Response(null, {
        status: 200,
        headers: {
          "Stream-Next-Offset": "0000000000000005",
          "Stream-Up-To-Date": "true",
          "X-Session-Id": "session-head",
        },
      }),
    );

    const response = await forwardSnapshotAwareChatRead(
      new Request("http://localhost/api/streams/chat/thread-2", { method: "HEAD" }),
      "thread-2",
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Stream-Next-Offset")).toBe("0000000000000005");
    expect(response.headers.get("Stream-Up-To-Date")).toBe("true");
    expect(response.headers.get("Content-Type")).toBe("application/x-ndjson");
    expect(await response.text()).toBe("");
  });

  it("declares only read-only GET/HEAD handlers (TC-033/TC-N09)", () => {
    // REQ-033: the minimal stream endpoint is read-only. Mutable durable stream
    // operations (create/append/close/delete) must not be routed. The TanStack
    // Start plugin strips server.handlers from the client transform, so this is
    // a static source check: the route file must declare GET and HEAD handlers
    // and no mutable methods. Undeclared methods 404/405 at the router.
    const source = readFileSync(join(__dirname, "../routes/api/streams/chat/$threadId.ts"), "utf8");
    const declaredMethods = [...source.matchAll(/^\s*(GET|HEAD|POST|PUT|DELETE|PATCH):\s/gm)].map(
      (m) => m[1],
    );
    expect(declaredMethods.sort()).toEqual(["GET", "HEAD"]);
    for (const mutableMethod of ["POST", "PUT", "DELETE", "PATCH"]) {
      expect(declaredMethods).not.toContain(mutableMethod);
    }
  });
});
