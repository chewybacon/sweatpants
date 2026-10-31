import { describe, expect, it } from "vitest";
import { call, resource, spawn, suspend } from "effection";
import { withTestScenario } from "@sweatpants/test-rig";
import { setupInMemoryDurableStreams } from "@sweatpants/durable-chat-runtime/response-streams";
import { createApplication } from "../../fixtures/application.ts";

function chatBody() {
  const commandId = crypto.randomUUID();
  const messageId = crypto.randomUUID();
  return {
    conversationId: crypto.randomUUID(),
    clientId: crypto.randomUUID(),
    command: {
      type: "send-message",
      commandId,
      messageId,
      issuedAt: Date.now(),
      expiresAt: Date.now() + 300000,
      basisRevision: null,
    },
    userMessage: { id: messageId, role: "user", content: "Keep the provider live." },
    runId: commandId,
    state: {},
    context: [],
    forwardedProps: {},
  };
}

function chatRequest(body: ReturnType<typeof chatBody>, setup = false) {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (setup) {
    headers.set("X-Setup-Probe", "yes");
  }
  return new Request("http://localhost/api/chat", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function* streams() {
  yield* setupInMemoryDurableStreams<string>({ retentionPolicy: { mode: "retain_forever" } });
}

describe("public chat setup isolation", () => {
  for (const failure of ["throw", "reject", "none"] as const) {
    it(`preserves a live unrelated turn when stale setup is ${failure}`, async () => {
      let app!: ReturnType<typeof createApplication>;
      const lifecycle: string[] = [];
      await withTestScenario(
        {
          binding: "http",
          scenarioTimeoutMs: 15000,
          createApplication(context) {
            app = createApplication(context, {
              basePath: "/api/chat",
              shutdownDeadlineMs: 0,
              setup: {
                application: streams,
                chat: function* ({ request }) {
                  if (request.headers.has("X-Setup-Probe")) {
                    yield* resource(function* (provide) {
                      lifecycle.push("acquired");
                      try {
                        yield* provide(undefined);
                      } finally {
                        lifecycle.push("disposing");
                        yield* call(() => Promise.resolve());
                        lifecycle.push("disposed");
                      }
                    });
                    if (failure === "throw") {
                      throw new Error("original setup failure");
                    }
                    if (failure === "reject") {
                      yield* call(() => Promise.reject(new Error("original setup failure")));
                    }
                  }
                },
              },
            });
            return app;
          },
        },
        function* (rig) {
          const body = chatBody();
          const first = yield* spawn(() =>
            call(async () => (await app.handle(chatRequest(body))).text()),
          );
          const provider = yield* rig.model.request();
          const stale = structuredClone(body);
          stale.command.commandId = crypto.randomUUID();
          stale.runId = stale.command.commandId;
          const response = yield* call(() => app.handle(chatRequest(stale, true)));
          const text = yield* call(() => response.text());
          expect(response.status).toBe(200);
          expect(text).toContain(
            failure === "none" ? "conversation_state_changed" : "original setup failure",
          );
          expect(text).not.toContain("halted");
          expect(lifecycle).toEqual(["acquired", "disposing", "disposed"]);
          expect(rig.model.requests()).toHaveLength(1);
          yield* provider.respond.text("Original turn completed.");
          const completed = yield* first;
          expect(completed).toContain("RUN_FINISHED");
          expect(completed).toContain("Original turn completed.");
          expect(completed).not.toContain("RUN_ERROR");
          // A malformed successor must remain isolated after the failed setup.
          const invalid = yield* call(() =>
            app.handle(
              new Request("http://localhost/api/chat", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: "{}",
              }),
            ),
          );
          expect(yield* call(() => invalid.text())).toContain("invalid_chat_request");
          expect(lifecycle).toEqual(["acquired", "disposing", "disposed"]);
        },
      );
    });
  }

  it("keeps transferred setup resources until durable work finishes after body cancellation", async () => {
    let app!: ReturnType<typeof createApplication>;
    let acquired = 0;
    let disposed = 0;
    let finished!: () => void;
    const disposal = new Promise<void>((resolve) => {
      finished = resolve;
    });
    await withTestScenario(
      {
        binding: "http",
        scenarioTimeoutMs: 15000,
        createApplication(context) {
          app = createApplication(context, {
            basePath: "/api/chat",
            shutdownDeadlineMs: 0,
            setup: {
              application: streams,
              chat: function* () {
                yield* resource(function* (provide) {
                  acquired++;
                  try {
                    yield* provide(undefined);
                  } finally {
                    yield* call(() => Promise.resolve());
                    disposed++;
                    finished();
                  }
                });
              },
            },
          });
          return app;
        },
      },
      function* (rig) {
        const pending = yield* spawn(() => call(() => app.handle(chatRequest(chatBody()))));
        const provider = yield* rig.model.request();
        const response = yield* pending;
        expect(acquired).toBe(1);
        expect(disposed).toBe(0);
        yield* call(() => response.body!.cancel());
        expect(disposed).toBe(0);
        yield* provider.respond.text("Completed after consumer cancellation.");
        yield* call(() => disposal);
        expect(disposed).toBe(1);
        expect(rig.model.requests()).toHaveLength(1);
      },
    );
    expect(disposed).toBe(1);
  });

  it("halts suspended initialization with ordered disposal when the Host closes", async () => {
    let app!: ReturnType<typeof createApplication>;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const lifecycle: string[] = [];
    await withTestScenario(
      {
        binding: "http",
        scenarioTimeoutMs: 15000,
        createApplication(context) {
          app = createApplication(context, {
            basePath: "/api/chat",
            shutdownDeadlineMs: 0,
            setup: {
              application: streams,
              chat: function* () {
                yield* resource(function* (provide) {
                  lifecycle.push("acquired");
                  try {
                    yield* provide(undefined);
                  } finally {
                    yield* call(() => Promise.resolve());
                    lifecycle.push("disposed");
                  }
                });
                entered();
                yield* suspend();
              },
            },
          });
          return app;
        },
      },
      function* (rig) {
        const pending = yield* spawn(() =>
          call(async () => (await app.handle(chatRequest(chatBody()))).text()),
        );
        yield* call(() => ready);
        yield* call(() => app.close());
        const text = yield* pending;
        expect(text).toContain('"message":"halted"');
        expect(text).toContain("RUN_ERROR");
        expect(text).not.toContain("RUN_FINISHED");
        expect(lifecycle).toEqual(["acquired", "disposed"]);
        expect(rig.model.requests()).toHaveLength(0);
      },
    );
  });
});
