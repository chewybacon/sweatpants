// @vitest-environment node
import { expect, it } from "vitest";
import { call, race } from "effection";
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
