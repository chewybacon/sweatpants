import { expect, it } from "vitest";
import { withTestScenario, normalizeResponsesHistory } from "@sweatpants/test-rig";
import { startCloudflareHost } from "./fixtures/cloudflare-host.ts";

it("continues a durable loop after settled activities spill out of the hot checkpoint", async () => {
  await withTestScenario(
    {
      binding: "http",
      modelId: "tisyn-long-loop",
      scenarioTimeoutMs: 30_000,
      createApplication: (context) => startCloudflareHost(context.model),
    },
    function* (s) {
      let conversation = s.conversation();
      let turn = yield* conversation.send("Collect twenty replies in one workflow.");
      const initial = yield* s.model.request();
      yield* initial.respond.toolCalls([
        {
          id: "long-loop",
          name: "tisyn",
          arguments: {
            program: `Let("loop",Fn(["n","history"],
            If(Gt(Ref("n"),20),Ref("history"),
              Let("a",Eval("ask",{"message":"Next item?"}),
                If(Eq(Get(Ref("a"),"action"),"accept"),
                  Call(Ref("loop"),Add(Ref("n"),1),Concat(Ref("history"),Get(Get(Ref("a"),"content"),"reply"),";")),
                  Ref("history"))))),Call(Ref("loop"),1,""))`,
          },
        },
      ]);
      for (let n = 1; n <= 20; n++) {
        let pending = yield* turn.elicit("reply");
        if (n === 12) {
          conversation = yield* conversation.reopen();
          turn = conversation.resumePendingElicit("reply");
          const restored = yield* turn.elicit("reply");
          expect(restored.elicitId).toBe(pending.elicitId);
          pending = restored;
        }
        expect(s.model.requests()).toHaveLength(1);
        yield* pending.accept({ reply: String(n) });
      }
      const final = yield* s.model.request();
      expect(normalizeResponsesHistory(final.body.input)).toMatchObject([
        { type: "user_text" },
        { type: "assistant_tool_call", name: "tisyn" },
        { type: "tool_result", output: Array.from({ length: 20 }, (_, i) => `${i + 1};`).join("") },
      ]);
      yield* final.respond.text("Collected twenty replies.");
      expect((yield* turn.settled()).text).toBe("Collected twenty replies.");
      expect(s.model.requests()).toHaveLength(2);
    },
  );
  // Twenty HTTP resumes plus reopen and final publication share this scenario budget.
}, 30_000);
