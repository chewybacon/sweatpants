import { describe, expect, it, vi } from "vitest";
import { createContext, ensure, sleep } from "effection";
import { createChatApp, ChatApiError } from "../index.ts";
import { createChatApi, createChatRouter } from "../chat-api.ts";

const identity = {
  name: "server-api-test",
  secret: "server-api-test-secret-material-32-bytes",
  storage: { kind: "memory" as const },
};

describe("application HTTP router", () => {
  it("dispatches commands, both reconnect methods, and history without consuming the request", async () => {
    const postChat = vi.fn<(request: Request) => Promise<Response>>(
      async (_request) => new Response("command"),
    );
    const readChat = vi.fn<(input: unknown) => Promise<Response>>(
      async (_input) => new Response("read"),
    );
    const pageHistory = vi.fn<(input: unknown) => Promise<Response>>(
      async (_input) => new Response("history"),
    );
    const handler = createChatRouter("/custom/chat", { postChat, readChat, pageHistory });
    const command = new Request("http://localhost/custom/chat/", {
      method: "POST",
      body: "command body",
    });
    expect(await (await handler(command)).text()).toBe("command");
    expect(postChat).toHaveBeenCalledWith(command);
    expect(await command.text()).toBe("command body");
    for (const method of ["GET", "POST"]) {
      const request = new Request("http://localhost/custom/chat/a%2Fb/?clientId=client", {
        method,
        headers: { "x-known-window-token": " window " },
      });
      expect(await (await handler(request)).text()).toBe("read");
      expect(readChat).toHaveBeenLastCalledWith({
        request,
        conversationId: "a/b",
        knownWindowToken: "window",
      });
    }
    const history = new Request("http://localhost/custom/chat/a%2Fb/history:page", {
      method: "POST",
      body: '{"cursor":"opaque"}',
    });
    expect(await (await handler(history)).text()).toBe("history");
    expect(pageHistory).toHaveBeenCalledWith({ request: history, conversationId: "a/b" });
    expect(await history.text()).toBe('{"cursor":"opaque"}');
  });

  it("rejects unknown paths, invalid URI encodings, and incorrect methods before setup", async () => {
    let setups = 0;
    const app = createChatApp({
      ...identity,
      basePath: "/custom/chat/",
      setup: {
        application: function* () {
          setups++;
        },
      },
    });
    try {
      for (const path of [
        "/api/chat",
        "/custom/chatty",
        "/custom/chat/a/extra",
        "/custom/chat//a",
      ]) {
        expect(
          (await app.handler(new Request(`http://localhost${path}`, { method: "POST" }))).status,
        ).toBe(404);
      }
      expect((await app.handler(new Request("http://localhost/custom/chat/%ZZ"))).status).toBe(400);
      for (const [path, allow] of [
        ["", "POST"],
        ["/a", "GET, POST"],
        ["/a/history:page", "POST"],
      ]) {
        const response = await app.handler(
          new Request(`http://localhost/custom/chat${path}`, { method: "DELETE" }),
        );
        expect(response.status).toBe(405);
        expect(response.headers.get("allow")).toBe(allow);
      }
      expect(setups).toBe(0);
    } finally {
      await app.close();
    }
  });

  it.each([
    "relative",
    "//host",
    "/api?x",
    "/api#x",
    "/api/../chat",
    "/api/%2f",
    "/api//chat",
    "/api\\chat",
  ])("rejects invalid base path %s at composition", (basePath) => {
    expect(() => createChatApp({ ...identity, basePath })).toThrow("basePath");
  });

  it("supports mounting at the origin root", async () => {
    const app = createChatApp({
      ...identity,
      basePath: "/",
      authorizeHistoryRead: function* () {
        return "forbidden";
      },
    });
    try {
      const result = await app.api.pageHistory({
        body: { conversationId: "a", cursor: "opaque" },
        asResponse: true,
      });
      expect(result.status).toBe(403);
      expect((await app.handler(new Request("http://localhost/"))).headers.get("allow")).toBe(
        "POST",
      );
    } finally {
      await app.close();
    }
  });
});

describe("direct server API", () => {
  it("shares lazy setup, scoped authorization, and cleanup with HTTP", async () => {
    const Context = createContext<string>("api-test");
    let setups = 0;
    let cleaned = false;
    const requests: Request[] = [];
    const app = createChatApp({
      ...identity,
      baseURL: "https://chat.example",
      basePath: "/custom/chat",
      setup: {
        application: function* () {
          setups++;
          yield* sleep(1);
          yield* Context.set("installed");
          yield* ensure(() => {
            cleaned = true;
          });
        },
      },
      authorizeHistoryRead: function* (request, conversationId) {
        expect(yield* Context.expect()).toBe("installed");
        expect(conversationId).toBe("a/b");
        requests.push(request);
        return request.headers.get("authorization") === "Bearer allowed"
          ? "authorized"
          : "forbidden";
      },
    });
    const http = new Request("https://chat.example/custom/chat/a%2Fb/history:page", {
      method: "POST",
      body: '{"cursor":"invalid"}',
    });
    try {
      const [response, direct] = await Promise.all([
        app.handler(http),
        app.api.pageHistory({
          body: { conversationId: "a/b", cursor: "invalid" },
          asResponse: true,
        }),
      ]);
      expect(response.status).toBe(403);
      expect(direct.status).toBe(403);
      expect(await response.json()).toEqual(await direct.json());
      expect(setups).toBe(1);
      expect(requests[1]!.url).toBe(http.url);
      await expect(
        app.api.pageHistory({ body: { conversationId: "a/b", cursor: "invalid" } }),
      ).rejects.toMatchObject({
        name: "ChatApiError",
        status: 403,
        body: { error: "forbidden" },
      });
      // A credentialed call reaches cursor validation, exactly like credentialed HTTP.
      await expect(
        app.api.pageHistory({
          headers: { authorization: "Bearer allowed" },
          body: { conversationId: "a/b", cursor: "invalid" },
        }),
      ).rejects.toMatchObject({ status: 400 });
      expect(cleaned).toBe(false);
    } finally {
      await app.close();
    }
    expect(cleaned).toBe(true);
    await expect(app.handler(http)).rejects.toMatchObject({ name: "ChatApplicationClosedError" });
    await expect(
      app.api.readChat({ body: { conversationId: "a/b", clientId: "c" } }),
    ).rejects.toMatchObject({ name: "ChatApplicationClosedError" });
    await expect(
      app.api.pageHistory({ body: { conversationId: "a/b", cursor: "x" } }),
    ).rejects.toMatchObject({ name: "ChatApplicationClosedError" });
  });

  it("returns typed history data or the original response, and preserves error details", async () => {
    const page = { roots: [], nextOlderCursor: null };
    const responses = [
      Response.json(page),
      Response.json(page),
      Response.json({ error: "expired" }, { status: 409, headers: { "x-request-id": "r" } }),
    ];
    const handler = vi.fn<() => Promise<Response>>(async () => responses.shift()!);
    const api = createChatApi(handler, "http://localhost", "/api/chat");
    const input = { body: { conversationId: "a", cursor: "cursor" } };
    expect(await api.pageHistory(input)).toEqual(page);
    const response = await api.pageHistory({ ...input, asResponse: true });
    expect(response).toBeInstanceOf(Response);
    expect(await response.json()).toEqual(page);
    try {
      await api.pageHistory(input);
      expect.fail("should reject a failed typed call");
    } catch (error) {
      expect(error).toBeInstanceOf(ChatApiError);
      expect((error as ChatApiError).headers.get("x-request-id")).toBe("r");
      expect((error as ChatApiError).body).toEqual({ error: "expired" });
    }
  });

  it("does not buffer streaming responses and forwards cancellation and credentials", async () => {
    const controller = new AbortController();
    const response = new Response(
      new ReadableStream({
        start(stream) {
          stream.enqueue(new TextEncoder().encode("first\n"));
        },
      }),
    );
    let request: Request | undefined;
    const api = createChatApi(
      async (next) => {
        request = next;
        return response;
      },
      "http://localhost",
      "/api/chat",
    );
    const result = await api.readChat({
      headers: { authorization: "Bearer credential" },
      signal: controller.signal,
      body: { conversationId: "a", clientId: "c" },
    });
    expect(result).toBe(response);
    expect(response.bodyUsed).toBe(false);
    expect(request!.headers.get("authorization")).toBe("Bearer credential");
    controller.abort();
    expect(request!.signal.aborted).toBe(true);
    await response.body!.cancel();
  });
});
