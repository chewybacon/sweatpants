import { describe, expect, it } from "vitest";
import { call } from "effection";
import { withTestScenario } from "@sweatpants/test-rig";
import { startCloudflareHost } from "./fixtures/cloudflare-host.ts";

describe("Agent Host with conversation and tool executor DOs", () => {
  it.each([
    ["While(true,[1])", /compute interrupts/],
    ["While(true,[])", /compute interrupts/],
    ['Let("f",Fn([],Call(Ref("f"))),Call(Ref("f")))', /stack overflow|compute interrupts/],
    [
      'Let("grow",Fn(["s"],Call(Ref("grow"),Concat(Ref("s"),Ref("s")))),Call(Ref("grow"),"x"))',
      /out of memory/,
    ],
    ["Mul(1e308,1e308)", /non-JSON/],
  ])(
    "bounds %s inside workerd and accepts the next program",
    async (source, error) => {
      await withTestScenario(
        {
          binding: "http",
          modelId: "tisyn-guard",
          scenarioTimeoutMs: 20_000,
          createApplication: ({ model }) => startCloudflareHost(model),
        },
        function* (s) {
          const first = yield* s.conversation().send("Run the failing program.");
          const request = yield* s.model.request();
          yield* request.respond.toolCalls([
            { id: "bounded", name: "tisyn", arguments: { program: source } },
          ]);
          expect((yield* first.failure()).message).toMatch(error);
          const next = yield* s.conversation().send("Evaluate 42.");
          const retry = yield* s.model.request();
          yield* retry.respond.toolCalls([
            { id: "healthy", name: "tisyn", arguments: { program: "42" } },
          ]);
          const answer = yield* s.model.request();
          expect(JSON.stringify(answer.body.input)).toContain("42");
          yield* answer.respond.text("42");
          expect((yield* next.settled()).text).toBe("42");
        },
      );
    },
    30_000,
  );

  it("retains a completed conversation across workerd replacement", async () => {
    let host: Awaited<ReturnType<typeof startCloudflareHost>>;
    await withTestScenario(
      {
        modelId: "tisyn-cloudflare-placement",
        scenarioTimeoutMs: 20_000,
        binding: "in-process",
        async createApplication({ model }) {
          host = await startCloudflareHost(model);
          return host;
        },
      },
      function* (s) {
        const conversation = s.conversation();
        const turn = yield* conversation.send("Say hello without calling tools.");
        const request = yield* s.model.request();
        expect(request.body.tools).toMatchObject([{ name: "tisyn" }]);
        expect(request.body.tools).toHaveLength(1);
        yield* request.respond.text("Hello from Cloudflare.");
        expect((yield* turn.settled()).text).toBe("Hello from Cloudflare.");
        yield* call(() => host.replace());
        const reopened = yield* conversation.reopen();
        expect(JSON.stringify(reopened.snapshot().messages)).toContain("Hello from Cloudflare.");
        const next = yield* reopened.send("What did you say?");
        const recall = yield* s.model.request();
        expect(JSON.stringify(recall.body.input)).toContain("Hello from Cloudflare.");
        yield* recall.respond.text("I said hello.");
        expect((yield* next.settled()).text).toBe("I said hello.");
      },
    );
  }, 30_000);

  it("reaches the real Tisyn tool in the DO and fails closed at the uninstalled evaluation port", async () => {
    await withTestScenario(
      {
        modelId: "tisyn-cloudflare-placement",
        scenarioTimeoutMs: 20_000,
        binding: "in-process",
        createApplication: ({ model }) => startCloudflareHost(model, false),
      },
      function* (s) {
        const conversation = s.conversation();
        const turn = yield* conversation.send("Evaluate 42.");
        const request = yield* s.model.request();
        yield* request.respond.toolCalls([
          { id: "tisyn-in-do", name: "tisyn", arguments: { program: "42" } },
        ]);
        // Agent Host aborts a failed durable program; it does not sample a model recovery turn.
        // This negative configuration omits executor setup. No local driver or fallback exists.
        const failure = yield* turn.failure();
        expect(failure.message).toContain("No Tisyn evaluation driver is installed");
        expect(s.model.requests()).toHaveLength(1);
      },
    );
  }, 30_000);
});
