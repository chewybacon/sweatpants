// @vitest-environment node
import { expect, it } from "vitest";
import { call, spawn } from "effection";
import { withTestScenario } from "@sweatpants/test-rig";
import { startCloudflareHost } from "../../../apps/yo-workflow/src/__tests__/fixtures/cloudflare-host.ts";

for (const languages of [["python"], ["lua"], ["lua", "scheme", "python"]]) {
  it(`rejected ${languages.join("/")} selections preserve running Python control, cleanup recovery and later language changes`, async () => {
    let host: Awaited<ReturnType<typeof startCloudflareHost>>;
    let first: Request | undefined;
    let selected = "python";
    await withTestScenario(
      {
        binding: "http",
        modelId: "language-owner",
        scenarioTimeoutMs: 40000,
        async createApplication({ model }) {
          host = await startCloudflareHost(model, true);
          return {
            async handle(request: Request) {
              const headers = new Headers(request.headers);
              headers.set("X-Workflow-Language", selected);
              const adjusted = new Request(request, { headers });
              if (request.method === "POST" && !first) {
                first = adjusted.clone();
              }
              return host.handle(adjusted);
            },
            close: () => host.close(),
          };
        },
      },
      function* (s) {
        let conversation = s.conversation();
        let turn = yield* conversation.send("Run public async with cleanup.");
        const request = yield* s.model.request();
        expect(request.body.tools).toMatchObject([{ name: "python" }]);
        yield* request.respond.toolCalls([
          {
            id: "run",
            name: "python",
            arguments: {
              program: `import anyio
from sandbox import sample, ask
async def main():
    try:
        await sample({"prompt": "Hold body"})
    finally:
        with anyio.CancelScope(shield=True):
            await ask({"message": "Cleanup question"})`,
            },
          },
        ]);
        const nested = yield* s.model.request();
        const aborted = yield* spawn(() => nested.respond.awaitAbort());
        const original = yield* call(() => first!.clone().json());
        // Concurrent requests all reach authoritative admission with fresh UUIDs
        // and the original stale null basis. No selected header can steal control.
        yield* call(async () => {
          const replies = await Promise.all(
            languages.map(async (language) => {
              const headers = new Headers(first!.headers);
              headers.set("X-Workflow-Language", language);
              headers.delete("content-length");
              const body = structuredClone(original);
              body.command.commandId = crypto.randomUUID();
              body.runId = body.command.commandId;
              expect(body.command.basisRevision).toBeNull();
              const response = await host.handle(
                new Request(first!.url, { method: "POST", headers, body: JSON.stringify(body) }),
              );
              expect(response.status).toBe(200);
              const text = await response.text();
              expect(text).toContain('"code":"conversation_state_changed"');
              expect(text).toContain('"state":"running"');
            }),
          );
          expect(replies).toHaveLength(languages.length);
          const headers = new Headers(first!.headers);
          headers.set("X-Workflow-Language", "lua");
          headers.delete("content-length");
          const invalid = await host.handle(
            new Request(first!.url, {
              method: "POST",
              headers,
              body: JSON.stringify({
                conversationId: original.conversationId,
                command: { type: "send-message" },
              }),
            }),
          );
          expect(await invalid.text()).toContain("RUN_ERROR");
        });
        // Even a foreign control header must reach the admitted live owner.
        selected = "lua";
        yield* turn.cancel();
        yield* aborted;
        conversation = yield* conversation.reopen();
        turn = conversation.resumePendingElicit("reply");
        const cleanup = yield* turn.elicit("reply");
        yield* turn.cancel();
        yield* call(() => host.replace());
        conversation = yield* conversation.reopen();
        turn = conversation.resumePendingElicit("reply");
        const restored = yield* turn.elicit("reply");
        expect(restored.elicitId).toBe(cleanup.elicitId);
        yield* restored.accept({ reply: "released" });
        const idle = yield* turn.expectSnapshot((snapshot) => snapshot.canSendMessage);
        expect(idle.authority?.state).toBe("idle");
        expect(s.model.requests()).toHaveLength(2);

        // A completed turn can legitimately select a different authoring surface.
        turn = yield* conversation.send("Use Lua now.");
        const lua = yield* s.model.request();
        expect(lua.body.tools).toMatchObject([{ name: "lua" }]);
        yield* lua.respond.toolCalls([
          { id: "lua-run", name: "lua", arguments: { program: 'return "lua switched"' } },
        ]);
        const result = yield* s.model.request();
        expect(JSON.stringify(result.body.input)).toContain("lua switched");
        yield* result.respond.text("Lua complete.");
        expect((yield* turn.settled()).text).toBe("Lua complete.");
        selected = "python";
        turn = yield* conversation.send("Use Python again.");
        const python = yield* s.model.request();
        expect(python.body.tools).toMatchObject([{ name: "python" }]);
        yield* python.respond.text("Python selected.");
        expect((yield* turn.settled()).text).toBe("Python selected.");
      },
    );
  }, 60000);
}

it("concurrent first language selections share admission and keep the admitted request's exposure", async () => {
  let host: Awaited<ReturnType<typeof startCloudflareHost>>;
  await withTestScenario(
    {
      binding: "http",
      modelId: "language-owner-first",
      scenarioTimeoutMs: 40000,
      async createApplication({ model }) {
        host = await startCloudflareHost(model, true);
        return host;
      },
    },
    function* (s) {
      const conversationId = crypto.randomUUID();
      const clientId = crypto.randomUUID();
      const requests = ["python", "lua"].map((language) => {
        const commandId = crypto.randomUUID();
        const messageId = crypto.randomUUID();
        return {
          language,
          commandId,
          request: new Request("http://localhost/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Workflow-Language": language },
            body: JSON.stringify({
              command: {
                type: "send-message",
                commandId,
                issuedAt: Date.now(),
                expiresAt: Date.now() + 300000,
                basisRevision: null,
                messageId,
              },
              clientId,
              conversationId,
              userMessage: { id: messageId, role: "user", content: "Select this language." },
              runId: commandId,
              state: {},
              context: [],
              forwardedProps: {},
            }),
          }),
        };
      });
      const responses = yield* spawn(() =>
        call(() =>
          Promise.all(
            requests.map(async ({ request }) => {
              const response = await host.handle(request);
              expect(response.status).toBe(200);
              return await response.text();
            }),
          ),
        ),
      );
      const author = yield* s.model.request();
      const tools = author.body.tools;
      yield* author.respond.text("Selected.");
      const texts = yield* responses;
      const winner = texts.findIndex((text) => text.includes('"type":"RUN_STARTED"'));
      expect(winner).toBeGreaterThanOrEqual(0);
      expect(texts.filter((text) => text.includes('"type":"RUN_STARTED"'))).toHaveLength(1);
      expect(tools).toMatchObject([{ name: requests[winner].language }]);
      expect(texts[winner]).toContain('"type":"RUN_FINISHED"');
      expect(texts[1 - winner]).toContain('"code":"conversation_state_changed"');
      expect(s.model.requests()).toHaveLength(1);
    },
  );
}, 60000);
