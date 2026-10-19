import {
  getThreadMetadataStore,
  threadListLimit,
  type ThreadListOptions,
  type ThreadMetadataStore,
  type CreateThreadMetadataInput,
  type UpdateThreadMetadataInput,
} from "@/lib/thread-metadata-store";

function parseJsonBody<T>(request: Request): Promise<T | null> {
  return (request.json() as Promise<T>).catch(() => null);
}

function extractThreadId(pathname: string): string | null {
  const match = pathname.match(/^\/api\/threaded-chat\/threads\/([^/]+)$/);
  return match ? decodeURIComponent(match[1] as string) : null;
}

export async function handleThreadMetadataRequest(
  request: Request,
  store: ThreadMetadataStore = getThreadMetadataStore(),
): Promise<Response> {
  const url = new URL(request.url);
  const pathname = url.pathname.replace(/\/$/, "");
  const method = request.method.toUpperCase();

  if (pathname === "/api/threaded-chat/threads") {
    if (method === "GET") {
      const options: ThreadListOptions = {};
      try {
        if (url.searchParams.has("limit")) {
          options.limit = Number(url.searchParams.get("limit"));
        }
        options.limit = threadListLimit(options);
        const cursor = url.searchParams.get("before");
        if (cursor !== null) {
          if (cursor.length > 1024) {
            throw new Error("Invalid thread cursor");
          }
          const value = JSON.parse(cursor);
          if (
            !value ||
            !Number.isSafeInteger(value.updatedAt) ||
            value.updatedAt < 0 ||
            typeof value.id !== "string" ||
            !value.id ||
            value.id.length > 512
          ) {
            throw new Error("Invalid thread cursor");
          }
          options.before = { updatedAt: value.updatedAt, id: value.id };
        }
      } catch {
        return new Response("Invalid thread pagination", { status: 400 });
      }
      const threads = await store.list(url.searchParams.get("namespace") ?? undefined, options);
      const last = threads.at(-1);
      return Response.json({
        threads,
        nextCursor:
          threads.length === options.limit && last
            ? JSON.stringify({ updatedAt: last.updatedAt, id: last.id })
            : null,
      });
    }

    if (method === "POST") {
      const body = (await parseJsonBody<CreateThreadMetadataInput>(request)) ?? {};
      const thread = await store.create(body);
      return Response.json({ thread }, { status: 201 });
    }

    return new Response("Method Not Allowed", { status: 405 });
  }

  const threadId = extractThreadId(pathname);
  if (!threadId) {
    return new Response("Not Found", { status: 404 });
  }

  if (method === "GET") {
    const thread = await store.get(threadId);
    if (!thread) {
      return new Response("Not Found", { status: 404 });
    }

    return Response.json({ thread });
  }

  if (method === "PUT") {
    const body = (await parseJsonBody<CreateThreadMetadataInput>(request)) ?? {};
    const existing = await store.get(threadId);
    if (existing) {
      const updated = await store.update(threadId, body);
      return Response.json({ thread: updated }, { status: 200 });
    }

    const thread = await store.create({ ...body, id: threadId });
    return Response.json({ thread }, { status: 201 });
  }

  if (method === "PATCH") {
    const body = (await parseJsonBody<UpdateThreadMetadataInput>(request)) ?? {};
    const updated = await store.update(threadId, body);
    if (!updated) {
      return new Response("Not Found", { status: 404 });
    }

    return Response.json({ thread: updated });
  }

  if (method === "DELETE") {
    const deleted = await store.delete(threadId);
    if (!deleted) {
      return new Response("Not Found", { status: 404 });
    }

    return new Response(null, { status: 204 });
  }

  return new Response("Method Not Allowed", { status: 405 });
}
