// @vitest-environment node
import { assertJson } from "@sweatpants/foundation";
import { run } from "effection";
import { expect, it } from "vitest";
import { createSchemeEvaluation, SchemeEvaluationPort } from "@sweatpants/flowmode-runtime-scheme";
import { createNodeSchemeDriver } from "@sweatpants/flowmode-runtime-scheme/node";
import { LuaEvaluationPort } from "@sweatpants/flowmode-runtime-lua";
import { invokeWasm } from "@sweatpants/flowmode-runtime-lua/node";
import { runLuaReplay } from "@sweatpants/flowmode-runtime-lua/replay";
import { luaFuelPolicy } from "@sweatpants/flowmode-runtime-lua/fuel";
import {
  ANY_JSON_SCHEMA_DESCRIPTOR as schema,
  createPinnedDurableProgram,
  createDurableToolRegistry,
} from "@sweatpants/durable-execution";
import { createWorkflowProgramDriver } from "@sweatpants/journal-authority";
import { createMemoryExecutionStore } from "@sweatpants/journal-authority/memory";
import { useProgramRig } from "../../support/program.ts";

it("runs the distinct Scheme session evaluator through its public capability exchange", async () => {
  await run(function* () {
    // Arrange: a real Playground evaluator, independently of Execution kernels.
    yield* SchemeEvaluationPort.installDriver(createNodeSchemeDriver());
    const evaluation = yield* createSchemeEvaluation({
      source:
        '(with-reply (object (cons "message" "Name?")) (lambda (content exchange) (field content "reply")) (lambda (stop) stop))',
      capabilities: ["ask"],
    });

    // Act / Assert: consume the actual effect and resume authored code with JSON.
    expect(yield* evaluation.next()).toEqual({
      done: false,
      value: { id: "ask", data: { message: "Name?" } },
    });
    expect(
      yield* evaluation.next({
        action: "accept",
        content: { reply: "Ada" },
        exchange: { messages: [] },
      }),
    ).toEqual({ done: true, value: "Ada" });
  });
});

it("replays ordinary Lua tool computation from real durable records without rerunning accepted Wasm slices", async () => {
  await run(function* () {
    // Arrange: observe real Wasm calls; journal records remain the replay authority.
    const commands: string[] = [];
    yield* LuaEvaluationPort.installDriver({
      *execute(command) {
        commands.push(command.action);
        return yield* invokeWasm(command);
      },
    });
    const tool = createPinnedDurableProgram(
      {
        programId: "lua-replay",
        version: "1",
        digest: "a".repeat(64),
        inputSchema: schema,
        outputSchema: schema,
        effects: {},
        elicits: { answer: { response: schema } },
        capabilities: { durableEmissions: true, structuredChildren: false, replay: "strict" },
      },
      function* (_input, ctx) {
        return yield* runLuaReplay({
          source:
            'local answer = workflow.effect("answer", {name = "answer", input = "Name?"})\nreturn answer',
          fuelPolicy: luaFuelPolicy,
          context: ctx,
          *approveComputation() {
            throw new Error("Tiny program exhausted fuel");
          },
          *exchange(request) {
            const reply = yield* ctx.pull(
              assertJson({
                kind: "elicit",
                key: "answer",
                message: String(request.capability.input),
                response: schema,
              }),
            );
            if (
              !reply ||
              typeof reply !== "object" ||
              Array.isArray(reply) ||
              reply["action"] !== "accept"
            ) {
              throw new Error("Expected accepted answer");
            }
            return { kind: "resume", value: reply["content"] };
          },
        });
      },
    );
    const program = {
      manifest: tool.manifest,
      createDriver: () => createWorkflowProgramDriver(createDurableToolRegistry([tool])),
    };
    const store = createMemoryExecutionStore();
    const first = yield* useProgramRig(store, program, null);
    yield* first.journal.advance({
      type: "execution.open-task",
      request: {
        ...first.attach,
        turnId: "turn",
        manifest: tool.manifest,
        attachmentId: "unattached",
        audience: "acceptance",
      },
    });

    // Act: persist computation, then park the authored tool on its external exchange.
    const parked = yield* first.advance();
    expect(parked.state).toBe("parked");
    if (parked.state !== "parked") {
      throw new Error("Expected Lua answer");
    }
    expect(commands).toEqual(["start"]);
    const capability = yield* first.journal.query({
      type: "pull.resolution-capability",
      sessionId: first.attach.sessionId,
      taskId: "root",
      pullId: parked.pullId,
    });
    const accepted = yield* first.journal.advance({
      type: "execution.resolve-pull",
      request: {
        capability,
        audience: "user:answer",
        outcome: { status: "ok", value: { action: "accept", content: "Ada" } },
      },
    });
    expect(accepted.status).not.toBe("rejected");

    // Assert: a fresh driver reuses the first compute result and only evaluates resume.
    const second = yield* useProgramRig(store, program, null);
    expect(yield* second.advance()).toEqual({ state: "completed", value: "Ada" });
    expect(commands).toEqual(["start", "resume"]);
    const journal = yield* second.journal.readSession(second.attach.sessionId);
    expect(
      journal.filter(
        (entry) =>
          entry.payload.type === "PullRequested" && entry.payload.descriptor.kind === "record",
      ),
    ).toHaveLength(3);
  });
});
