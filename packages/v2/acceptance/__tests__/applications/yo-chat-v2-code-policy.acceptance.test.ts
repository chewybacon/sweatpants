import { expect, it, onTestFinished } from "vitest";
import { createApplication } from "../../../../../apps/yo-chat-v2/src/application.ts";
import { viewSchema } from "../../../../../apps/yo-chat-v2/src/contracts.ts";
import { chooseFlight } from "../../../../../apps/yo-chat-v2/src/flight.ts";
import { completedSampling } from "../../examples/yo-chat-sampling.ts";
import { createSqliteDatabaseRig } from "@sweatpan.ts/testing";
import type { ChatSampling } from "@sweatpan.ts/chat";
import type { Runtime } from "@sweatpan.ts/runtime";
import { forEachRuntime } from "../runtime/assembly.ts";

forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  for (const scenario of [
    "pairs",
    "unsupported",
    "invalid-argument",
    "authored-error",
    "compute-limit",
  ] as const) {
    it(`${runtime.name}: code ${scenario} preserves its failure disposition without starting flight work`, async () => {
      const database = createSqliteDatabaseRig();
      let samples = 0;
      const source =
        scenario === "pairs"
          ? 'local chars="abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"; local out={}; for i=1,52 do for j=1,52 do out[#out+1]=string.sub(chars,i,i)..string.sub(chars,j,j) end end return table.concat(out," ")'
          : scenario === "unsupported"
            ? 'local reply = workflow.effect("forged", { effect = "choose_flight", input = {destination="LAX"} }); assert(reply.ok, reply.error)'
            : scenario === "invalid-argument"
              ? "return choose_flight({destination=42})"
              : scenario === "compute-limit"
                ? "while true do end"
                : 'error("authored failure")';
      const sampling: ChatSampling<Y> = {
        *sample(request) {
          samples++;
          expect(request.tools.map((tool) => tool.name)).toEqual(["run_lua"]);
          if (scenario === "unsupported") {
            expect(request.tools[0]!.description).not.toContain('"name":"choose_flight"');
          }
          if (samples === 2) {
            const result = request.history.find((message) => message.role === "tool");
            const value = JSON.parse(String(result?.content));
            if (scenario === "pairs") {
              expect(value.status).toBe("completed");
              const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
              expect(value.value.split(" ")).toEqual(
                [...alphabet].flatMap((a) => [...alphabet].map((b) => a + b)),
              );
              expect(request.tools[0]!.description).toContain("string.sub");
            } else {
              expect(value).toMatchObject({ status: "failed" });
            }
          }
          return {
            ok: true,
            value: {
              model: {
                id: "local",
                name: "Local",
                provider: "test",
                api: "scripted",
                input: ["text"],
                output: ["text"],
                contextWindow: 8192,
                maxOutputTokens: 1024,
                reasoningLevels: [],
              },
              response: {
                message: {
                  role: "assistant",
                  content:
                    samples === 1
                      ? [
                          {
                            type: "tool-call",
                            toolCall: {
                              id: "code",
                              name: "run_lua",
                              input: { source },
                              thoughtSignature: null,
                            },
                          },
                        ]
                      : [{ type: "text", text: "The program failed; no flight was selected." }],
                },
                source: null,
                usage: null,
                stopReason: null,
                responseId: null,
                errorMessage: null,
              },
            },
          };
        },
      };
      let app = createApplication(runtime, database.database, {
        sampling: completedSampling(runtime, sampling),
      });
      onTestFinished(async () => {
        await app.close();
        database.close();
      });
      const submission = {
        command: "code-policy",
        prompt: "Choose a flight",
        after: null,
        mode: "code",
        support:
          scenario === "unsupported"
            ? []
            : [{ tool: chooseFlight.id, elicits: ["pickFlight", "pickSeat"] }],
      };
      const post = (body: unknown) =>
        app.fetch(
          new Request("http://localhost/api/conversation", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }),
        );
      expect((await post(submission)).status).toBe(202);
      const read = async () =>
        viewSchema.parse(
          await (await app.fetch(new Request("http://localhost/api/conversation"))).json(),
        );
      if (scenario === "compute-limit") {
        await expect
          .poll(async () => {
            const view = await read();
            return (
              view.messages.some((message) =>
                message.parts.some((part) => part.type === "code-run"),
              ) && !view.active
            );
          })
          .toBe(true);
        const stopped = await read();
        expect(stopped.status).toBe("running");
        expect(stopped.questions).toEqual([]);
        expect(samples).toBe(1);
        await app.close();
        database.reopen();
        app = createApplication(runtime, database.database, {
          sampling: completedSampling(runtime, sampling),
        });
        expect(await read()).toEqual(stopped);
        expect(samples).toBe(1);
        return;
      }
      await expect.poll(async () => (await read()).status).toBe("completed");
      const view = await read();
      expect(view.questions).toEqual([]);
      const programs = view.messages
        .flatMap((message) => message.parts)
        .filter((part) => part.type === "code-run");
      expect(programs).toHaveLength(1);
      expect(programs[0]).toMatchObject({
        run: {
          source,
          state: "completed",
          result: { status: scenario === "pairs" ? "completed" : "failed" },
        },
        questions: [],
      });
      expect((await post({ ...submission, mode: "tools" })).status).toBe(409);
      expect((await post(submission)).status).toBe(202);
      expect(samples).toBe(2);
      await app.close();
      database.reopen();
      app = createApplication(runtime, database.database, {
        sampling: completedSampling(runtime, sampling),
      });
      expect(await read()).toEqual(view);
      expect(samples).toBe(2);
    });
  }
});
