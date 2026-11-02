import { askQuestion } from "../../../apps/yo-chat/src/tools/general/ask-question/tool.ts";
import { projectToolContract } from "@sweatpants/agent-sdk";
import { isIteratorTool } from "@sweatpants/agent-sdk/internal/tool-execution";
import type { ModelResponse } from "@sweatpants/model-provider";
import type { Json } from "@sweatpants/foundation";
// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { call, run, spawn } from "effection";
import { watch, readFileSync, existsSync } from "node:fs";
import { expect, expectTypeOf, it } from "vitest";
import {
  activateChat,
  type ChatCapabilities,
  type ChatRequest,
} from "@sweatpants/agent-host/primitive/activation";
import { effection, type EffectionYield } from "@sweatpants/standard-durability-effection";
import { createWorkerGuest, local } from "@sweatpants/tool-runtime-local";
import { activateJournal, success } from "@sweatpants/primitive-journal";
import { SqliteJournal } from "@sweatpants/primitive-journal/sqlite";
import { tools } from "../../../apps/yo-chat/src/server/tool-definitions.ts";
import { toolEffects } from "../../../apps/yo-chat/src/server/tool-effects.ts";
import { calculator } from "../../../apps/yo-chat/src/tools/calculator.ts";
import { pickCard } from "../../../apps/yo-chat/src/tools/pick-card/durable.ts";
import { routeTools } from "@sweatpants/tool-session/execution";
import { inProcess } from "@sweatpants/agent-host/server";

const workerUrl = new URL(
  "../../../apps/yo-chat/src/server/journal-tool-worker-bootstrap.mjs",
  import.meta.url,
);
const input = {
  initialToolChoice: "required" as const,
  messageId: "message-1",
  text: "Pick a card",
  modelIdentity: "scripted",
  messages: [{ role: "user", content: [{ type: "text", text: "Pick a card" }] }],
};
const identity = {
  executionId: "worker-card",
  program: { id: "yo-chat", version: "2", digest: "worker-card-fixture" },
  input,
};

it("retains concrete results through local and routed placement without output annotations", async () => {
  const worker = local({ worker: workerUrl, execArgv: ["--conditions=development"] });
  const routed = routeTools({
    default: inProcess(),
    routes: [{ tools: [calculator, askQuestion], runtime: worker }],
  });
  for (const placement of [inProcess(), worker, routed]) {
    const prepared = placement.prepare(calculator, "typed");
    // These probes create no computation: validation/body execution belongs to start.
    // @ts-expect-error typed placement preserves calculator parameters
    void prepared.guest({ expression: 42 }, "invalid");
    await run(function* () {
      const guest = yield* prepared.guest({ expression: "2 + 3" }, "calculator")();
      try {
        const turn = yield* guest.start();
        if (turn.kind !== "completed") {
          throw new Error("Expected calculator completion");
        }
        expectTypeOf(turn.value.expression).toEqualTypeOf<string>();
        expectTypeOf(turn.value.result).toEqualTypeOf<number | null>();
        // @ts-expect-error result has not widened to a JSON object index signature
        void turn.value.missing;
        expect(turn.value).toMatchObject({ expression: "2 + 3", result: 5 });
      } finally {
        yield* guest.close();
      }
    });
    const question = placement.prepare(askQuestion, "typed");
    await run(function* () {
      const guest = yield* question.guest({ question: "Ready?" }, "question")();
      try {
        const pending = yield* guest.start();
        expect(pending).toMatchObject({
          kind: "suspended",
          request: { kind: "elicit", key: "askQuestion" },
        });
        const turn = yield* guest.resume(success({ action: "accept", content: { answer: "yes" } }));
        if (turn.kind !== "completed") {
          throw new Error("Expected question completion");
        }
        expectTypeOf(turn.value.question).toEqualTypeOf<string>();
        expectTypeOf(turn.value.answer).toEqualTypeOf<string | null>();
        expect(turn.value).toEqual({ question: "Ready?", answer: "yes" });
      } finally {
        yield* guest.close();
      }
    });
  }
  const projection = projectToolContract(calculator);
  expect(projection.name).toBe(calculator.name);
  expect(isIteratorTool(projection)).toBe(false);
  expect(Object.hasOwn(calculator, "execute")).toBe(false);
  expect(Object.hasOwn(calculator, "invoke")).toBe(false);
  expect(Object.getOwnPropertySymbols(calculator)).toEqual([]);
  // @ts-expect-error execution is acquired through placement, not the definition
  void calculator.invoke;
  expect(Object.hasOwn(calculator, "execution")).toBe(false);
});

it("parks the routed card worker, releases it, then completes in a fresh worker without redrawing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "journal-worker-"));
  const database = join(directory, "journal.sqlite");
  let journal = new SqliteJournal(database, identity);
  const trace: string[] = [];
  let samples = 0;
  let draws = 0;
  const Placement = effection.createContext<string>("mixed-placement-scope");
  const options: ChatCapabilities<EffectionYield> = {
    tools: tools,
    effects: {
      ...toolEffects,
      *"pick_card.draw"(value) {
        draws++;
        expect(yield* Placement.expect()).toBe("routed");
        return yield* toolEffects["pick_card.draw"]!(value);
      },
    },
    execution: routeTools({
      default: inProcess({
        *setup() {
          yield* Placement.set("routed");
        },
      }),
      routes: [
        {
          tools: [pickCard],
          runtime: {
            prepare(tools, route) {
              const prepared = local({
                worker: workerUrl,
                execArgv: ["--conditions=development"],
              }).prepare(tools, route);
              return {
                ...prepared,
                guests: new Map(
                  [...prepared.guests!].map(([name, acquire]) => [
                    name,
                    (input, callId) =>
                      function* () {
                        trace.push("open");
                        const guest = yield* acquire(input, callId)();
                        return {
                          start: guest.start,
                          resume: guest.resume,
                          *close() {
                            yield* guest.close();
                            trace.push("closed");
                          },
                        };
                      },
                  ]),
                ),
              };
            },
          },
        },
      ],
    }),
    model: {
      model: {
        id: "scripted",
        name: "Scripted",
        api: "fixture",
        provider: "fixture",
        reasoning: false,
        input: ["text"],
        contextWindow: 4096,
        maxTokens: 100,
      },
      driver: {
        *stream(request) {
          samples++;
          expect(yield* Placement.expect()).toBe("routed");
          expect(request.options?.toolChoice).toBe(samples === 1 ? "required" : undefined);
          if (samples === 2) {
            expect(JSON.stringify(request.context.messages)).toContain("Card selection recorded");
            expect(
              request.context.messages.find(
                (message) => message.role === "tool" && message.toolCallId === "calculator-1",
              ),
            ).toMatchObject({
              content: [
                {
                  type: "text",
                  text: JSON.stringify({ expression: "2+3", result: 5, error: null }),
                },
              ],
            });
            expect(trace).toEqual(["open", "closed", "open", "closed"]);
          }
          const response: ModelResponse = {
            message: {
              role: "assistant",
              content:
                samples === 1
                  ? [
                      {
                        type: "tool-call",
                        toolCall: {
                          id: "calculator-1",
                          name: "calculator",
                          input: { expression: "2+3" },
                          thoughtSignature: null,
                        },
                      },
                      {
                        type: "tool-call",
                        toolCall: {
                          id: "card-1",
                          name: "pick_card",
                          input: { count: 3 },
                          thoughtSignature: null,
                        },
                      },
                    ]
                  : [{ type: "text", text: "Remembered your card." }],
            },
            source: null,
            usage: null,
            stopReason: "stop",
            responseId: null,
            errorMessage: null,
          };
          return response;
        },
      },
    },
  };
  try {
    const first = await run(() => activateChat(effection, options, input, journal));
    expect(first.state).toBe("parked");
    expect(trace).toEqual(["open", "closed"]);
    if (first.state !== "parked") {
      throw new Error("Expected card picker");
    }
    const request = first.request.request as Extract<ChatRequest, { kind: "elicit" }>;
    const context = request.context as { cards: Json[] };
    const offered = context.cards;
    journal.close();
    journal = new SqliteJournal(database, identity);
    journal.acceptRequest(
      first.request.id,
      success({ action: "accept", content: { picked: offered[0]! } }),
    );
    const second = await run(() => activateChat(effection, options, input, journal));
    expect(second.state).toBe("completed");
    expect(trace).toEqual(["open", "closed", "open", "closed"]);
    expect(draws).toBe(1);
    expect(samples).toBe(2);
  } finally {
    journal.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("refuses an unaccepted card draw after SQLite reopen without invoking the effect again", async () => {
  const directory = await mkdtemp(join(tmpdir(), "journal-unsafe-draw-"));
  const database = join(directory, "journal.sqlite");
  let journal = new SqliteJournal(database, identity);
  let draws = 0;
  const activate = () =>
    activateJournal(
      inProcess().prepare(pickCard, "cards").guest({ count: 3 }, "card-uncertain"),
      journal,
      {
        classify: (request) => (request.kind === "effect" ? request.retrySafety.mode : "park"),
        *handler(request) {
          if (request.kind !== "effect") {
            throw new Error("Expected card draw");
          }
          draws++;
          yield* toolEffects["pick_card.draw"]!(request.input);
          // Simulate dispatch succeeding but its result never reaching journal acceptance.
          throw new Error("Lost before acceptance");
        },
      },
    );
  try {
    await expect(run(activate)).rejects.toThrow("Lost before acceptance");
    expect(journal.read()).toMatchObject({
      entries: [],
      attempts: [{ retryMode: "unsafe", status: "started" }],
    });
    for (let recovery = 0; recovery < 2; recovery++) {
      journal.close();
      journal = new SqliteJournal(database, identity);
      await expect(run(activate)).rejects.toThrow("outcome_unknown");
      expect(draws).toBe(1);
      expect(journal.read()).toMatchObject({
        entries: [],
        attempts: [{ retryMode: "unsafe", status: "unknown" }],
      });
      expect(journal.read().attempts).toHaveLength(1);
    }
  } finally {
    journal.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("acquires and closes worker placement without entering its computation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "worker-unstarted-"));
  const started = join(directory, "started");
  const closed = join(directory, "closed");
  try {
    await run(function* () {
      const guest = yield* createWorkerGuest({
        workerUrl: new URL("../../fixtures/worker-guests/acquiring.mjs", import.meta.url),
        execArgv: ["--conditions=development"],
        input: { started, closed },
      });
      yield* guest.close();
      // Close waits for the worker's acknowledgement, so this is not a startup race.
      expect(existsSync(started)).toBe(false);
      expect(existsSync(closed)).toBe(false);
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("cancels a worker while its native Guest acquisition is suspended and joins disposal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "worker-acquire-"));
  const started = join(directory, "started");
  const closed = join(directory, "closed");
  let watcher: ReturnType<typeof watch> | undefined;
  const acquiring = new Promise<void>((resolve) => {
    watcher = watch(directory, (_event, name) => {
      if (name === "started") {
        resolve();
      }
    });
  });
  try {
    await run(function* () {
      const guest = yield* createWorkerGuest({
        workerUrl: new URL("../../fixtures/worker-guests/acquiring.mjs", import.meta.url),
        execArgv: ["--conditions=development"],
        input: { started, closed },
      });
      expect(existsSync(started)).toBe(false);
      const starting = yield* spawn(() => guest.start());
      yield* call(() => acquiring);
      yield* starting.halt();
      yield* guest.close();
      expect(readFileSync(closed, "utf8")).toBe("disposed");
    });
  } finally {
    watcher?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("keeps worker loss out of accepted tool results and recovers through another placement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tool-placement-loss-"));
  const database = join(directory, "journal.sqlite");
  let journal = new SqliteJournal(database, identity);
  let samples = 0;
  const options: ChatCapabilities<EffectionYield> = {
    tools: [calculator],
    effects: {},
    execution: local({
      worker: new URL("../../fixtures/worker-guests/crash.mjs", import.meta.url),
      execArgv: [],
    }),
    model: {
      model: {
        id: "scripted",
        name: "Scripted",
        api: "fixture",
        provider: "fixture",
        reasoning: false,
        input: ["text"],
        contextWindow: 4096,
        maxTokens: 100,
      },
      driver: {
        *stream() {
          samples++;
          const response: ModelResponse = {
            message: {
              role: "assistant",
              content:
                samples === 1
                  ? [
                      {
                        type: "tool-call",
                        toolCall: {
                          id: "calculate",
                          name: "calculator",
                          input: { expression: "2+3" },
                          thoughtSignature: null,
                        },
                      },
                    ]
                  : [{ type: "text", text: "Five." }],
            },
            source: null,
            usage: null,
            stopReason: "stop",
            responseId: null,
            errorMessage: null,
          };
          return response;
        },
      },
    },
  };
  try {
    await expect(run(() => activateChat(effection, options, input, journal))).rejects.toThrow(
      "Worker exited",
    );
    expect(journal.read()).toMatchObject({
      status: "running",
      entries: [{ request: { kind: "sample" } }],
    });
    expect(journal.read().entries).toHaveLength(1);
    journal.close();
    journal = new SqliteJournal(database, identity);
    options.execution = inProcess();
    expect((await run(() => activateChat(effection, options, input, journal))).state).toBe(
      "completed",
    );
    expect(samples).toBe(2);
    expect(journal.read().entries[1]).toMatchObject({
      request: { kind: "tool-result", callId: "calculate", isError: false, output: { result: 5 } },
    });
  } finally {
    journal.close();
    await rm(directory, { recursive: true, force: true });
  }
});
