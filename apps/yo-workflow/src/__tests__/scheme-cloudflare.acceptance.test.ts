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
      createApplication: ({ model }) => startCloudflareHost(model, true),
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
        host = await startCloudflareHost(model, true);
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

it.each(["present_choices", "display_document"])(
  "returns a repairable outcome for a missing document in %s",
  async (capability) => {
    await withTestScenario(
      {
        binding: "http",
        modelId: "scheme-missing-document",
        scenarioTimeoutMs: 20000,
        createApplication: ({ model }) => startCloudflareHost(model, true),
      },
      function* (s) {
        const turn = yield* s.conversation().send("Show my document.");
        const initial = yield* s.model.request();
        const choices =
          capability === "present_choices"
            ? '(cons "choices" (array (object (cons "id" "ok") (cons "label" "OK"))))'
            : "";
        yield* initial.respond.toolCalls([
          {
            id: "missing-document",
            name: "scheme",
            arguments: {
              program: `(effect "${capability}" (object (cons "document" (object (cons "id" "invented"))) (cons "message" "Continue?") ${choices}))`,
            },
          },
        ]);
        const repair = yield* race([
          s.model.request(),
          (function* () {
            const failure = yield* turn.failure();
            throw new Error(failure.message);
          })(),
        ]);
        expect(JSON.stringify(repair.body.input)).toContain("not_found");
        yield* repair.respond.toolCalls([
          { id: "recover", name: "scheme", arguments: { program: '"Recovered"' } },
        ]);
        const final = yield* s.model.request();
        expect(JSON.stringify(final.body.input)).toContain("Recovered");
        yield* final.respond.text("Recovered");
        expect((yield* turn.settled()).text).toBe("Recovered");
      },
    );
  },
  30000,
);
