import { createFileRoute } from "@tanstack/react-router";
import { chatApp } from "@/server/chat-application";

export async function forwardSnapshotAwareChatRead(
  request: Request,
  threadId: string,
): Promise<Response> {
  const sourceUrl = new URL(request.url);
  const chatUrl = new URL("/api/chat", sourceUrl);
  chatUrl.searchParams.set("conversationId", threadId);

  const offset = sourceUrl.searchParams.get("offset");
  if (offset !== null) {
    chatUrl.searchParams.set("offset", offset);
  }

  const forwarded = new Request(chatUrl.toString(), {
    method: request.method,
    headers: request.headers,
  });

  const response = await chatApp.handle(forwarded);
  if (request.method.toUpperCase() === "HEAD" || !response.body) {
    const headers = new Headers(response.headers);
    headers.set("Content-Type", "application/x-ndjson");
    return new Response(null, { status: response.status, headers });
  }

  const raw = await response.text();
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const events = lines
    .map((line) => JSON.parse(line) as { event?: unknown })
    .map((frame) => frame.event)
    .filter((event): event is Record<string, unknown> => !!event && typeof event === "object");

  const body =
    events.map((event) => JSON.stringify(event)).join("\n") + (events.length > 0 ? "\n" : "");
  const headers = new Headers(response.headers);
  headers.set("Content-Type", "application/x-ndjson");
  headers.delete("X-Session-Id");

  return new Response(body, {
    status: response.status,
    headers,
  });
}

export const Route = createFileRoute("/api/streams/chat/$threadId")({
  server: {
    handlers: {
      GET: async ({ request, params }) => forwardSnapshotAwareChatRead(request, params.threadId),
      HEAD: async ({ request, params }) => forwardSnapshotAwareChatRead(request, params.threadId),
    },
  },
});
