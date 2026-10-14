import { expect, it } from "vitest";
import { call, race } from "effection";
import { withTestScenario } from "@sweatpants/test-rig";
import { startCloudflareHost } from "./fixtures/cloudflare-host.ts";

it("returns Scheme validation diagnostics and executes a repaired program inside workerd", async () => {
  await withTestScenario(
    {
      binding: "http",
      modelId: "scheme-validation",
      scenarioTimeoutMs: 20000,
      createApplication: ({ model }) => startCloudflareHost(model, true, "scheme"),
    },
    function* (s) {
      const turn = yield* s.conversation().send("Run a program.");
      const initial = yield* race([
        s.model.request(),
        (function* () {
          const failure = yield* turn.failure();
          throw new Error(failure.message);
        })(),
      ]);
      expect(initial.body.tools).toMatchObject([{ name: "scheme" }]);
      const tools = initial.body.tools as { description: string }[];
      expect(tools[0].description.length).toBeLessThanOrEqual(64 * 1024);
      yield* initial.respond.toolCalls([
        {
          id: "invalid",
          name: "scheme",
          arguments: { program: "(let ((x 1))", validateOnly: true },
        },
      ]);
      const repair = yield* race([
        s.model.request(),
        (function* () {
          const failure = yield* turn.failure();
          throw new Error(failure.message);
        })(),
      ]);
      expect(JSON.stringify(repair.body.input)).toContain("invalid");
      expect(JSON.stringify(repair.body.input)).toContain("end of input");
      yield* repair.respond.toolCalls([
        { id: "repaired", name: "scheme", arguments: { program: "(+ 20 22)" } },
      ]);
      const final = yield* race([
        s.model.request(),
        (function* () {
          const failure = yield* turn.failure();
          throw new Error(failure.message);
        })(),
      ]);
      expect(JSON.stringify(final.body.input)).toContain("42");
      yield* final.respond.text("42");
      expect((yield* turn.settled()).text).toBe("42");
    },
  );
}, 30000);

it("recovers a quoted Scheme child and its pending Ask after workerd replacement", async () => {
  let host: Awaited<ReturnType<typeof startCloudflareHost>>;
  await withTestScenario(
    {
      binding: "http",
      modelId: "scheme-child",
      scenarioTimeoutMs: 20000,
      async createApplication({ model }) {
        host = await startCloudflareHost(model, true, "scheme");
        return host;
      },
    },
    function* (s) {
      let conversation = s.conversation();
      let turn = yield* conversation.send("Ask in a child program.");
      const initial = yield* race([
        s.model.request(),
        (function* () {
          const failure = yield* turn.failure();
          throw new Error(failure.message);
        })(),
      ]);
      yield* initial.respond.toolCalls([
        {
          id: "child",
          name: "scheme",
          arguments: {
            program: `
    (invoke '(with-reply (object (cons "message" (field input "question")))
       (lambda (content exchange) (field content "reply")) (lambda (stop) stop))
       (object (cons "question" "Your name?")))`,
          },
        },
      ]);
      const pending = yield* turn.elicit("reply");
      yield* call(() => host.replace());
      conversation = yield* conversation.reopen();
      turn = conversation.resumePendingElicit("reply");
      const restored = yield* turn.elicit("reply");
      expect(restored.elicitId).toBe(pending.elicitId);
      yield* restored.accept({ reply: "Ada" });
      const final = yield* race([
        s.model.request(),
        (function* () {
          const failure = yield* turn.failure();
          throw new Error(failure.message);
        })(),
      ]);
      expect(JSON.stringify(final.body.input)).toContain("Ada");
      yield* final.respond.text("Hello, Ada.");
      expect((yield* turn.settled()).text).toBe("Hello, Ada.");
      expect(s.model.requests()).toHaveLength(2);
    },
  );
}, 30000);
