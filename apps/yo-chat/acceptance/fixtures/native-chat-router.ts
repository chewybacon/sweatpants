import type { ChatApplication } from "@sweatpants/agent-host/server";
import type { DurableChatEndpoints } from "@sweatpants/durable-chat-runtime/durable-handler";
import type { TestApplication } from "@sweatpants/test-rig";

function routeConversationId(pathname: string, suffix = ""): string | null {
  const pattern = new RegExp(`^/api/chat/([^/]+)${suffix}/?$`);
  const match = pattern.exec(pathname);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return null;
  }
}

/** Test-router binding for the native chat HTTP contract. */
export function routeNativeChatApplication(
  application: ChatApplication,
  endpoints: DurableChatEndpoints,
): TestApplication {
  return {
    async handle(request: Request): Promise<Response> {
      const pathname = new URL(request.url).pathname;
      if (request.method.toUpperCase() !== "POST") {
        return new Response(null, { status: 405, headers: { Allow: "POST" } });
      }
      if (pathname === "/api/chat" || pathname === "/chat") {
        return application.handleEndpoint(endpoints.postChat, request);
      }
      const historyConversationId = routeConversationId(pathname, "/history:page");
      if (historyConversationId) {
        return application.handleEndpoint(endpoints.pageHistory, {
          request,
          conversationId: historyConversationId,
        });
      }
      const conversationId = routeConversationId(pathname);
      if (conversationId) {
        return application.handleEndpoint(endpoints.readChat, { request, conversationId });
      }
      return new Response(null, { status: 404 });
    },
    close: () => application.close(),
  };
}
