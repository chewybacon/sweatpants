import type { BoundChatEndpoints } from "./chat-endpoints.ts";

export function normalizeChatBasePath(value: string): string {
  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    /[?#%\\\s]/.test(value) ||
    value.split("/").some((part) => part === "." || part === "..") ||
    value.includes("//")
  ) {
    throw new TypeError("ChatApp basePath must be an absolute URL path without query or fragment");
  }
  return new URL(value, "http://sweatpants.local").pathname.replace(/\/$/, "");
}

function routeError(status: number, error: string, allow?: string): Response {
  return Response.json({ error }, { status, headers: allow ? { Allow: allow } : undefined });
}

/** HTTP route dispatch only; endpoint implementations own request semantics. */
export function createChatRouter(basePath: string, endpoints: BoundChatEndpoints) {
  return async (request: Request): Promise<Response> => {
    const pathname = new URL(request.url).pathname.replace(/\/$/, "");
    if (pathname === basePath) {
      return request.method === "POST"
        ? endpoints.postChat(request)
        : routeError(405, "method_not_allowed", "POST");
    }
    if (!pathname.startsWith(`${basePath}/`)) {
      return routeError(404, "not_found");
    }
    const parts = pathname.slice(basePath.length + 1).split("/");
    const history = parts.length === 2 && parts[1] === "history:page";
    if (!parts[0] || (parts.length !== 1 && !history)) {
      return routeError(404, "not_found");
    }
    let conversationId: string;
    try {
      conversationId = decodeURIComponent(parts[0]);
    } catch {
      // Malformed URI input is an observable 400, never an unhandled routing exception.
      return routeError(400, "invalid_conversation_id");
    }
    if (history) {
      return request.method === "POST"
        ? endpoints.pageHistory({ request, conversationId })
        : routeError(405, "method_not_allowed", "POST");
    }
    if (request.method !== "POST" && request.method !== "GET") {
      return routeError(405, "method_not_allowed", "GET, POST");
    }
    const knownWindowToken = request.headers.get("x-known-window-token")?.trim();
    return endpoints.readChat({
      request,
      conversationId,
      knownWindowToken: knownWindowToken || undefined,
    });
  };
}
