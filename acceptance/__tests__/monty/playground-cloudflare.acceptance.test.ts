// @vitest-environment node
import { expect, it } from "vitest";
import { call, race, spawn } from "effection";
import { withTestScenario } from "@sweatpants/test-rig";
import { startCloudflareHost } from "../../../apps/yo-workflow/src/__tests__/fixtures/cloudflare-host.ts";

it("model protocol authors Python and a real workerd executor restores its human question", async () => {
  let host: Awaited<ReturnType<typeof startCloudflareHost>>;
  await withTestScenario(
    {
      binding: "http",
      modelId: "python-game",
      scenarioTimeoutMs: 40000,
      async createApplication({ model }) {
        host = await startCloudflareHost(model, true, "python");
        return host;
      },
    },
    function* (s) {
      let conversation = s.conversation();
      let turn = yield* conversation.send("Play rock, paper, scissors with me.");
      function* modelRequest() {
        return yield* race([
          s.model.request(),
          (function* () {
            const failure = yield* turn.failure();
            throw Error(failure.message);
          })(),
        ]);
      }
      const initial = yield* modelRequest();
      expect(initial.body.tools).toMatchObject([{ name: "python" }]);
      yield* initial.respond.toolCalls([
        {
          id: "validate",
          name: "python",
          arguments: { program: "async def main(:", validateOnly: true },
        },
      ]);
      const repair = yield* modelRequest();
      expect(JSON.stringify(repair.body.input)).toContain("invalid");
      yield* repair.respond.toolCalls([
        {
          id: "game",
          name: "python",
          arguments: {
            program: `from sandbox import random, ask
async def main():
    computer = await random({"choices": ["rock", "paper", "scissors"]})
    answer = await ask({"message": "Your move?", "suggestions": ["rock", "paper", "scissors"]})
    if answer["action"] != "accept":
        return answer
    player = answer["content"]["reply"]
    beats = {"rock": "scissors", "paper": "rock", "scissors": "paper"}
    result = "tie" if computer == player else "win" if beats[player] == computer else "lose"
    return {"player": player, "computer": computer, "result": result}`,
          },
        },
      ]);
      const pending = yield* turn.elicit("reply");
      yield* call(() => host.replace());
      conversation = yield* conversation.reopen();
      turn = conversation.resumePendingElicit("reply");
      const restored = yield* turn.elicit("reply");
      expect(restored.elicitId).toBe(pending.elicitId);
      yield* restored.accept({ reply: "rock" });
      const final = yield* modelRequest();
      expect(JSON.stringify(final.body.input)).toContain('\\"player\\":\\"rock\\"');
      expect(JSON.stringify(final.body.input)).toContain('\\"computer\\":');
      yield* final.respond.text("Round complete.");
      expect((yield* turn.settled()).text).toBe("Round complete.");
      expect(s.model.requests()).toHaveLength(3);
    },
  );
}, 60000);

for (const running of [false, true]) {
  it(`Playground Stop ${running ? "running provider" : "parked question"} journals AnyIO unwind and restores cleanup`, async () => {
    let host: Awaited<ReturnType<typeof startCloudflareHost>>;
    await withTestScenario(
      {
        binding: "http",
        modelId: "python-anyio-stop",
        scenarioTimeoutMs: 40000,
        async createApplication({ model }) {
          host = await startCloudflareHost(model, true, "python");
          return host;
        },
      },
      function* (s) {
        let conversation = s.conversation();
        let turn = yield* conversation.send("Run a task with shielded cleanup.");
        const request = yield* s.model.request();
        expect(JSON.stringify(request.body.tools)).toContain("CancelScope");
        yield* request.respond.toolCalls([
          {
            id: "public-anyio",
            name: "python",
            arguments: {
              program: `import anyio
from sandbox import ask, sample
async def worker():
    try:
        ${running ? 'await sample({"prompt": "Hold this request"})' : 'await ask({"message": "Body question"})'}
    finally:
        with anyio.CancelScope(shield=True):
            await ask({"message": "Cleanup question"})
async def main():
    async with anyio.create_task_group() as group:
        group.start_soon(worker)
    return "done"`,
            },
          },
        ]);
        let bodyId: string | undefined;
        let aborted;
        if (running) {
          const nested = yield* s.model.request();
          aborted = yield* spawn(() => nested.respond.awaitAbort());
        } else {
          bodyId = (yield* turn.elicit("reply")).elicitId;
        }
        yield* turn.cancel();
        if (aborted) {
          yield* aborted;
        }
        conversation = yield* conversation.reopen();
        turn = conversation.resumePendingElicit("reply");
        const cleanup = yield* turn.elicit("reply");
        expect(cleanup.elicitId).not.toBe(bodyId);
        yield* turn.cancel();
        conversation = yield* conversation.reopen();
        turn = conversation.resumePendingElicit("reply");
        const repeated = yield* turn.elicit("reply");
        expect(repeated.elicitId).toBe(cleanup.elicitId);
        yield* call(() => host.replace());
        conversation = yield* conversation.reopen();
        turn = conversation.resumePendingElicit("reply");
        const restored = yield* turn.elicit("reply");
        expect(restored.elicitId).toBe(cleanup.elicitId);
        yield* restored.accept({ reply: "released" });
        // Root host cancellation stays terminal; no further author model call.
        const state = yield* turn.expectSnapshot((snapshot) => snapshot.canSendMessage);
        expect(state.authority?.state).toBe("idle");
        expect(s.model.requests()).toHaveLength(running ? 2 : 1);
      },
    );
  }, 60000);
}

for (const surface of ["asyncio", "anyio"] as const) {
  for (const failure of [false, true]) {
    it(`workerd public ${surface} nested groups ${failure ? "failure" : "normal"} restore cleanup`, async () => {
      let host: Awaited<ReturnType<typeof startCloudflareHost>>;
      await withTestScenario(
        {
          binding: "http",
          modelId: `python-${surface}-${failure}`,
          scenarioTimeoutMs: 40000,
          async createApplication({ model }) {
            host = await startCloudflareHost(model, true, "python");
            return host;
          },
        },
        function* (s) {
          let conversation = s.conversation();
          let turn = yield* conversation.send("Run the bounded public concurrency example.");
          const request = yield* s.model.request();
          const group = surface === "anyio" ? "anyio.create_task_group()" : "asyncio.TaskGroup()";
          yield* request.respond.toolCalls([
            {
              id: "nested",
              name: "python",
              arguments: {
                program: `import ${surface}
from sandbox import ask
async def worker():
    try:
        await ask({"message": "Body question"})
        ${failure ? 'raise ValueError("child failure")' : "pass"}
    finally:
        await ask({"message": "Cleanup question"})
async def main():
    try:
        async with ${group} as outer:
            async with ${group} as inner:
                ${surface === "anyio" ? "inner.start_soon(worker)" : "inner.create_task(worker())"}
    except RuntimeError:
        return "failure drained"
    return "done"`,
              },
            },
          ]);
          const body = yield* turn.elicit("reply");
          yield* body.accept({ reply: "continue" });
          const cleanup = yield* turn.elicit("reply");
          expect(cleanup.elicitId).not.toBe(body.elicitId);
          yield* call(() => host.replace());
          conversation = yield* conversation.reopen();
          turn = conversation.resumePendingElicit("reply");
          const restored = yield* turn.elicit("reply");
          expect(restored.elicitId).toBe(cleanup.elicitId);
          yield* restored.accept({ reply: "released" });
          const final = yield* s.model.request();
          expect(JSON.stringify(final.body.input)).toContain(failure ? "failure drained" : "done");
          yield* final.respond.text("Complete.");
          expect((yield* turn.settled()).text).toBe("Complete.");
        },
      );
    }, 60000);
  }
}
