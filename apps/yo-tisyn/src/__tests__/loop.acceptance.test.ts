import { afterEach, describe, expect, it } from "vitest";
import { call } from "effection";
import { withTestScenario, normalizeResponsesHistory } from "@sweatpants/test-rig";
import { createPiAiModelProvider } from "@sweatpants/model-provider-pi-ai";
import type { ChatUIPart, ChatUIMessage } from "@sweatpants/chat-core";
import { createTisynApp } from "../server/application.ts";
import { inProcess } from "@sweatpants/agent-host/server";
import { TisynEvaluationPort } from "../workflow/evaluation/port.ts";
import { createNodeEvaluationDriver } from "../workflow/evaluation/node.ts";
import { startCloudflareHost } from "./fixtures/cloudflare-host.ts";

let phase = "initial";
afterEach((context) => {
  if (context.task.result?.state === "fail")
    console.error(`Loop acceptance stopped during: ${phase}`);
});

// Based on the model-authored loop probe; now exercise the actual application.
const source = `Let("loop",Fn(["acc"],
  Let("r",Eval("ask",{"message":"Input (decline to stop)"}),
    If(Eq(Get(Ref("r"),"action"),"accept"),
      Let("next",If(Eq(Ref("acc"),""),Get(Get(Ref("r"),"content"),"reply"),
        Concat(Ref("acc")," ",Get(Get(Ref("r"),"content"),"reply"))),
        Seq(Eval("echo",{"message":Ref("next")}),Call(Ref("loop"),Ref("next")))),
      Ref("acc")))),Call(Ref("loop"),""))`;

function parts(messages: readonly ChatUIMessage[]): ChatUIPart[] {
  function visit(part: ChatUIPart): ChatUIPart[] {
    return [
      part,
      ...(part.type === "message"
        ? parts([part.message])
        : "parts" in part
          ? part.parts.flatMap(visit)
          : []),
    ];
  }
  return messages.flatMap((message) => message.parts.flatMap(visit));
}

describe.each(["in-process", "http", "cloudflare"] as const)(
  "one durable loop over %s",
  (binding) => {
    it.each(["decline", "cancel"] as const)(
      "stays inside one model tool call until %s",
      async (action) => {
        phase = `${binding}/${action}: starting host`;
        let cloudflareHost: Awaited<ReturnType<typeof startCloudflareHost>> | undefined;
        await withTestScenario(
          {
            binding: binding === "cloudflare" ? "http" : binding,
            modelId: "tisyn-loop",
            scenarioTimeoutMs: 30_000,
            async createApplication(context) {
              if (binding === "cloudflare") {
                cloudflareHost = await startCloudflareHost(context.model);
                return cloudflareHost;
              }
              const app = createTisynApp({
                execution: inProcess({
                  *setup() {
                    yield* TisynEvaluationPort.installDriver(createNodeEvaluationDriver());
                  },
                }),
                storage: { kind: "memory" },
                model: {
                  model: context.model.model,
                  driver: createPiAiModelProvider().driver,
                  streamOptions: context.model.streamOptions,
                },
              });
              return { handle: app.handler, close: () => app.close() };
            },
          },
          function* (s) {
            let conversation = s.conversation();
            let turn = yield* conversation.send(
              "ask me for input in a loop until I decline, echo the accumulated response as it goes",
            );
            const initial = yield* s.model.request();
            expect(initial.body.tools).toMatchObject([{ name: "tisyn" }]);
            expect(initial.body.tools).toHaveLength(1);
            yield* initial.respond.toolCalls([
              { id: "one-loop", name: "tisyn", arguments: { program: source } },
            ]);
            const words = ["one", "two", "three", "four", "five", "six"];
            for (const [index, word] of words.entries()) {
              phase = `${binding}/${action}: waiting for reply ${index}`;
              let pending = yield* turn.elicit("reply");
              if (index === 3) {
                const host = cloudflareHost;
                if (host) {
                  phase = `${binding}/${action}: replacing host`;
                  yield* call(() => host.replace());
                }
                conversation = yield* conversation.reopen();
                turn = conversation.resumePendingElicit("reply");
                const recovered = yield* turn.elicit("reply");
                expect(recovered.elicitId).toBe(pending.elicitId);
                expect(recovered.callId).toBe(pending.callId);
                pending = recovered;
              }
              expect(s.model.requests()).toHaveLength(1);
              const snapshot = yield* turn.snapshot();
              const calls = parts(snapshot.messages).filter((part) => part.type === "tool-call");
              expect(calls.filter((part) => part.name === "tisyn")).toHaveLength(1);
              expect(calls.find((part) => part.name === "tisyn")?.state).toBe("input-available");
              expect(
                calls.filter((part) => part.name === "echo").map((part) => part.output),
              ).toEqual(
                words.slice(0, index).map((_, i) => ({ message: words.slice(0, i + 1).join(" ") })),
              );
              phase = `${binding}/${action}: accepting reply ${index}`;
              yield* pending.accept({ reply: word });
            }
            phase = `${binding}/${action}: waiting for stop question`;
            const pending = yield* turn.elicit("reply");
            expect(s.model.requests()).toHaveLength(1);
            phase = `${binding}/${action}: resolving stop`;
            if (action === "decline") {
              yield* pending.decline();
            } else {
              yield* pending.cancel();
            }
            phase = `${binding}/${action}: final model request`;
            const final = yield* s.model.request();
            expect(normalizeResponsesHistory(final.body.input)).toMatchObject([
              { type: "user_text" },
              { type: "assistant_tool_call", name: "tisyn" },
              { type: "tool_result", output: words.join(" ") },
            ]);
            yield* final.respond.text("Loop stopped.");
            expect((yield* turn.settled()).text).toBe("Loop stopped.");
            expect(s.model.requests()).toHaveLength(2);
            phase = `${binding}/${action}: reopen completed conversation`;
            const restored = yield* conversation.reopen();
            const calls = parts(restored.snapshot().messages).filter(
              (part) => part.type === "tool-call",
            );
            expect(calls.filter((part) => part.name === "tisyn")).toHaveLength(1);
            expect(calls.filter((part) => part.name === "ask")).toHaveLength(7);
            expect(calls.filter((part) => part.name === "echo")).toHaveLength(6);
            expect(calls.every((part) => part.state === "output-available")).toBe(true);
            expect(new Set(calls.map((part) => part.callId)).size).toBe(14);
            phase = `${binding}/${action}: follow-up turn`;
            const followUp = yield* restored.send("What was the final accumulated text?");
            const request = yield* s.model.request();
            expect(
              normalizeResponsesHistory(request.body.input).filter(
                (item) => item.type === "assistant_tool_call",
              ),
            ).toMatchObject([{ name: "tisyn" }]);
            yield* request.respond.text(words.join(" "));
            expect((yield* followUp.settled()).text).toBe(words.join(" "));
          },
        );
      },
    );
  },
);
