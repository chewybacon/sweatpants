import { describe, expect, it } from "vitest";
import { run } from "effection";
import { assertJson } from "@sweatpants/foundation";
import {
  createDurableToolRegistry,
  createProgramDriverRegistry,
  ProgramDriverRegistryContext,
  stableProgramAttachmentId,
  type ProgramAttachment,
  type ProgramDriver,
} from "@sweatpants/durable-execution";
import {
  createDurableEffectRegistry,
  DurableEffectRegistryContext,
} from "@sweatpants/durable-effects/runtime";
import {
  createCapabilityKeyring,
  createDurableSchemaRegistry,
  createWorkflowProgramDriver,
} from "@sweatpants/journal-authority";
import {
  createAuthorityScenarioDriver,
  driveInstalledTestProgramTree,
  withProgramDriverTestScope,
  type AuthorityScenarioDriver,
} from "@sweatpants/journal-authority/testing";
import { createTisynTool, parseProgram } from "../tisyn.ts";
import { programs, tisynExposure } from "../agent.ts";
import { createToolInventoryEntry } from "@sweatpants/tool-runtime";
import { ask } from "../tools/ask.ts";
import { echo } from "../tools/echo.ts";
import { TisynEvaluationPort } from "../evaluation/port.ts";
import { createNodeEvaluationDriver } from "../evaluation/node.ts";

const workflow = `Let("before", Eval("echo", {"message":"before"}),
  Let("reply", Eval("ask", {"message":Concat("After ",Get(Ref("before"),"message"),", what next?")}),
    If(Eq(Get(Ref("reply"),"action"),"accept"),
      Eval("echo", {"message":Get(Get(Ref("reply"),"content"),"reply")}),
      Construct({"action":Get(Ref("reply"),"action")}))))`;

function fixture(source: string) {
  const enteredEchoes: unknown[] = [];
  // Observe entry into the real tool. No client, descriptor, or tool result is replaced.
  const observedEcho: typeof echo = {
    ...echo,
    *program(input, context) {
      enteredEchoes.push(input);
      return yield* echo.program(input, context);
    },
  };
  const runner = createTisynTool([observedEcho, ask]).build();
  const tools = [runner, observedEcho, ask];
  const registry = createDurableToolRegistry(tools);
  const active = new Set<ProgramAttachment>();
  const evaluations = new Set<string>();
  const attach = {
    sessionId: "tisyn-test",
    taskId: "turn-0/root",
    program: {
      id: runner.manifest.programId,
      version: runner.manifest.version,
      digest: runner.manifest.digest,
    },
    input: { program: source },
    route: { driverKind: "program" },
    executionEpoch: 1,
  };
  const authorityOptions = {
    journalId: "tisyn-spike",
    journalIncarnation: "test-1",
    keyring: createCapabilityKeyring("tisyn-tests", [
      { keyId: "test", secret: "tisyn-spike-test-secret-not-production" },
    ]),
    schemaRegistry: createDurableSchemaRegistry(
      tools.flatMap((tool) => [...tool.artifacts.catalog]),
    ),
  };
  function* start() {
    const authority = yield* createAuthorityScenarioDriver(authorityOptions);
    yield* authority.openTask({
      sessionId: attach.sessionId,
      taskId: attach.taskId,
      turnId: "turn-0",
      manifest: runner.manifest,
      input: attach.input,
      executionEpoch: 1,
      attachmentId: stableProgramAttachmentId(attach),
      audience: "program-host",
    });
    return authority;
  }
  function* advanceUntilBlocked(authority: AuthorityScenarioDriver) {
    // Each advancement uses a new driver. Parking must leave no live attachment.
    const concrete = createWorkflowProgramDriver(registry);
    const driver: ProgramDriver = {
      ...concrete,
      *attach(request) {
        const handle = yield* concrete.attach(request);
        active.add(handle);
        return handle;
      },
      *step(handle, command) {
        return yield* concrete.step(handle, command);
      },
      *shutdown(handle, reason) {
        try {
          yield* concrete.shutdown(handle, reason);
        } finally {
          active.delete(handle);
        }
      },
    };
    return yield* ProgramDriverRegistryContext.with(
      createProgramDriverRegistry([["program", driver]]),
      function* () {
        return yield* withProgramDriverTestScope(authority, function* () {
          yield* TisynEvaluationPort.installDriver(createNodeEvaluationDriver());
          yield* TisynEvaluationPort.api.around({
            *open(args, next) {
              const handle = yield* next(...args);
              evaluations.add(handle);
              return handle;
            },
            *close([handle], next) {
              yield* next(handle);
              evaluations.delete(handle);
            },
          });
          return yield* DurableEffectRegistryContext.with(
            createDurableEffectRegistry([]),
            function* () {
              return yield* driveInstalledTestProgramTree({ attach });
            },
          );
        });
      },
    );
  }
  function pendingReply(authority: AuthorityScenarioDriver) {
    const journal = authority.readJournal(attach.sessionId);
    const resolved = new Set(
      journal.flatMap(({ payload }) => (payload.type === "PullResolved" ? [payload.pullId] : [])),
    );
    const record = journal.find(
      ({ payload }) =>
        payload.type === "PullRequested" &&
        payload.descriptor.kind === "elicit" &&
        !resolved.has(payload.pullId),
    );
    if (!record || record.payload.type !== "PullRequested") {
      throw new Error("Expected typed ask elicitation");
    }
    return record.payload;
  }
  return {
    start,
    advanceUntilBlocked,
    pendingReply,
    enteredEchoes,
    active,
    evaluations,
    attach,
    authorityOptions,
  };
}

describe("Tisyn profile", () => {
  it("exposes only Tisyn while retaining child interaction contracts", async () => {
    const entries = programs.map((tool) => createToolInventoryEntry(tool));
    const definitions = await run(() => tisynExposure.filter({ phase: "outer-chat", entries }));
    expect(definitions.map((definition) => definition.name)).toEqual(["tisyn"]);
    expect(entries.find((entry) => entry.definition.name === "ask")?.elicits?.reply).toBeDefined();
  });
  it("admits sequential bindings, branches, and real tool arguments", () => {
    expect(parseProgram(workflow, [echo, ask])).toBeTruthy();
  });
  it.each([
    ['Eval("all", {"exprs":[]})', "Unsupported"],
    ['If(false, Eval("shell", {"command":"anything"}), true)', "Unsupported"],
    ['Fn([],Eval("shell",{}))', "Unsupported"],
    ['Eval("if", Construct({"condition":true,"then":1}))', "requires data to be a Quote node"],
    ['Let("f",Fn([],Eval("all",{})),Call(Ref("f")))', "Unsupported"],
    ['Try(1,"e",Ref("e"))', "Unsupported"],
    ['Get({},"constructor")', "Prototype"],
    ["Seq(1,)", "Unexpected"],
    ["Seq(".repeat(50) + "1" + ")".repeat(50), "nesting"],
    ['"' + "x".repeat(12000) + '"', "characters"],
  ])("rejects prohibited or oversized program %#", (source, error) =>
    expect(() => parseProgram(source, [echo, ask])).toThrow(error),
  );
  it.each([
    'Let("f",Fn(["n"],If(Eq(Ref("n"),0),0,Call(Ref("f"),Sub(Ref("n"),1)))),Call(Ref("f"),3))',
    'While(false,[Eval("echo",{"message":"never"})])',
  ])("admits functions, recursion, and while: %s", (source) => {
    expect(parseProgram(source, [echo, ask])).toBeTruthy();
  });
  it("rejects duplicate bindings", () =>
    expect(() => createTisynTool([echo, echo]).build()).toThrow("Duplicate"));
});

describe("real Sweatpants journal and driver", () => {
  it("runs echo through a pinned durable child and records its result", async () => {
    const f = fixture('Eval("echo", {"message":"hello"})');
    await run(function* () {
      const authority = yield* f.start();
      expect(yield* f.advanceUntilBlocked(authority)).toMatchObject({
        state: "completed",
        value: { message: "hello" },
      });
      expect(f.enteredEchoes).toEqual([{ message: "hello" }]);
      expect(f.active.size).toBe(0);
      expect(f.evaluations.size).toBe(0);
      expect(
        authority
          .readJournal(f.attach.sessionId)
          .filter((record) => record.payload.type === "PullRequested")
          .map((record) => record.payload),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ descriptor: expect.objectContaining({ kind: "invoke" }) }),
          expect.objectContaining({
            descriptor: expect.objectContaining({ kind: "record", key: "echo" }),
          }),
        ]),
      );
    });
  });

  it.each(["accept", "decline", "cancel"] as const)(
    "parks, destroys scope, restores snapshot, and handles %s",
    async (action) => {
      const f = fixture(workflow);
      const parked = await run(function* () {
        const authority = yield* f.start();
        expect(yield* f.advanceUntilBlocked(authority)).toMatchObject({
          state: "parked",
          reason: "elicit",
        });
        expect(f.active.size).toBe(0);
        expect(f.evaluations.size).toBe(0);
        expect(f.enteredEchoes).toEqual([{ message: "before" }]);
        const pending = f.pendingReply(authority);
        expect(pending.descriptor).toMatchObject({
          key: "reply",
          context: { prompt: "After before, what next?" },
          response: ask.manifest.elicits.reply.response,
        });
        return {
          snapshot: authority.exportSnapshot(),
          pending,
          accepted: authority.readJournal(f.attach.sessionId),
        };
      });
      // The first root scope is gone. Rebuild authority + interpreter from persisted JSON only.
      await run(function* () {
        const authority = yield* createAuthorityScenarioDriver({
          ...f.authorityOptions,
          snapshot: JSON.parse(JSON.stringify(parked.snapshot)),
        });
        const capability = authority.resolutionCapability(
          f.attach.sessionId,
          parked.pending.taskId,
          parked.pending.pullId,
        );
        if (action === "accept") {
          expect(
            yield* authority.resolve({
              capability,
              audience: "user:reply",
              outcome: { status: "ok", value: { action: "accept", content: { reply: 123 } } },
            }),
          ).toMatchObject({ status: "rejected" });
        }
        const value = assertJson(
          action === "accept" ? { action, content: { reply: "after" } } : { action },
        );
        expect(
          yield* authority.resolve({
            capability,
            audience: "user:reply",
            outcome: { status: "ok", value },
          }),
        ).not.toMatchObject({ status: "rejected" });
        expect(yield* f.advanceUntilBlocked(authority)).toMatchObject({
          state: "completed",
          value: action === "accept" ? { message: "after" } : { action },
        });
        expect(f.enteredEchoes).toEqual(
          action === "accept"
            ? [{ message: "before" }, { message: "after" }]
            : [{ message: "before" }],
        );
        expect(f.active.size).toBe(0);
        expect(f.evaluations.size).toBe(0);
        expect(authority.readJournal(f.attach.sessionId).slice(0, parked.accepted.length)).toEqual(
          parked.accepted,
        );
      });
    },
  );

  it.each(["decline", "cancel"] as const)(
    "repeats inside one program, restores after six replies, and stops on %s",
    async (action) => {
      const source = `Let("loop",Fn(["acc"],
        Let("r",Eval("ask",{"message":"Input (decline to stop)"}),
          If(Eq(Get(Ref("r"),"action"),"accept"),
            Let("next",If(Eq(Ref("acc"),""),Get(Get(Ref("r"),"content"),"reply"),
              Concat(Ref("acc")," ",Get(Get(Ref("r"),"content"),"reply"))),
              Seq(Eval("echo",{"message":Ref("next")}),Call(Ref("loop"),Ref("next")))),
            Ref("acc")))),Call(Ref("loop"),""))`;
      const f = fixture(source);
      const words = ["one", "two", "three", "four", "five", "six"];
      const parked = await run(function* () {
        const authority = yield* f.start();
        expect(yield* f.advanceUntilBlocked(authority)).toMatchObject({ state: "parked" });
        for (const word of words) {
          const pending = f.pendingReply(authority);
          expect(
            yield* authority.resolve({
              capability: authority.resolutionCapability(
                f.attach.sessionId,
                pending.taskId,
                pending.pullId,
              ),
              audience: "user:reply",
              outcome: { status: "ok", value: { action: "accept", content: { reply: word } } },
            }),
          ).not.toMatchObject({ status: "rejected" });
          expect(yield* f.advanceUntilBlocked(authority)).toMatchObject({ state: "parked" });
          expect(f.active.size).toBe(0);
          expect(f.evaluations.size).toBe(0);
        }
        expect(f.enteredEchoes).toEqual(
          words.map((_, index) => ({ message: words.slice(0, index + 1).join(" ") })),
        );
        return { snapshot: authority.exportSnapshot(), pending: f.pendingReply(authority) };
      });
      // No evaluator survives this boundary. Replay uses the same accepted source and results.
      await run(function* () {
        const authority = yield* createAuthorityScenarioDriver({
          ...f.authorityOptions,
          snapshot: JSON.parse(JSON.stringify(parked.snapshot)),
        });
        expect(
          yield* authority.resolve({
            capability: authority.resolutionCapability(
              f.attach.sessionId,
              parked.pending.taskId,
              parked.pending.pullId,
            ),
            audience: "user:reply",
            outcome: { status: "ok", value: { action } },
          }),
        ).not.toMatchObject({ status: "rejected" });
        expect(yield* f.advanceUntilBlocked(authority)).toMatchObject({
          state: "completed",
          value: words.join(" "),
        });
        expect(f.enteredEchoes).toHaveLength(6);
        expect(f.active.size).toBe(0);
        expect(f.evaluations.size).toBe(0);
        const starts = authority
          .readJournal(f.attach.sessionId)
          .flatMap(({ payload }) =>
            payload.type === "DurableEmission" && payload.descriptor.eventType === "tool_started"
              ? [payload.descriptor.payload]
              : [],
          );
        expect(starts).toHaveLength(13);
        const callIds = starts.map((value) =>
          value !== null && typeof value === "object" && !Array.isArray(value)
            ? value.callId
            : undefined,
        );
        expect(callIds).toEqual(
          Array.from({ length: 13 }, (_, index) =>
            expect.stringMatching(new RegExp(`/tool-${index}$`)),
          ),
        );
        expect(new Set(callIds).size).toBe(13);
      });
    },
  );

  it.each([
    'Seq(Eval("echo", {"message":"must not happen"}), Eval("shell", {}))',
    'Eval("echo", {"message":123})',
    "Seq(1,)",
  ])("fails invalid programs without entering a child: %s", async (source) => {
    const f = fixture(source);
    await run(function* () {
      const authority = yield* f.start();
      const outcome = yield* f.advanceUntilBlocked(authority);
      expect(outcome.state).toBe("failed");
      expect(f.enteredEchoes).toEqual([]);
      expect(f.active.size).toBe(0);
      expect(f.evaluations.size).toBe(0);
    });
  });
});
