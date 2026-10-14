import { createSessionTool } from "../session.ts";
import variant from "@jitl/quickjs-wasmfile-release-sync";
import { memoizePromiseFactory, newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core";
import { createDurableTool } from "@sweatpants/agent-sdk";
import { Call, Get, type TisynExpr, type TisynFn } from "@tisyn/ir";
import { validateIr } from "@tisyn/validate";
import { validateAuthoredSchema } from "@sweatpants/foundation/parser";
import { z } from "zod";
import { createQuickJSEvaluationDriver } from "../evaluation/quickjs.ts";
import {
  createDecisionEffectRegistration,
  installDecisionProvider,
  type DecisionAnswer,
} from "@sweatpants/model-decision";
import { decisionBinding } from "../decisions.ts";
import { describe, expect, it } from "vitest";
import { run } from "effection";
import { assertJson, sha256, type Json } from "@sweatpants/foundation";
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
import { createTisynTool, parseProgram, type BoundTool } from "../tisyn.ts";
import { programs, workflowExposure } from "../agent.ts";
import { createToolInventoryEntry } from "@sweatpants/tool-runtime";
import { ask } from "../tools/ask.ts";
import { echo } from "../tools/echo.ts";
import { createEvaluation, TisynEvaluationPort } from "../evaluation/port.ts";
import { createNodeEvaluationDriver } from "../evaluation/node.ts";

const workflow = `Let("before", Eval("echo", {"message":"before"}),
  Let("reply", Eval("ask", {"message":Concat("After ",Get(Ref("before"),"message"),", what next?")}),
    If(Eq(Get(Ref("reply"),"action"),"accept"),
      Eval("echo", {"message":Get(Get(Ref("reply"),"content"),"reply")}),
      Construct({"action":Get(Ref("reply"),"action")}))))`;

function fixture(
  source: string,
  decision?: DecisionAnswer,
  options: {
    delegation?: boolean;
    runtime?: "node" | "quickjs";
    greeting?: "pure" | "human";
    childSource?: string;
  } = {},
) {
  const decisions: unknown[] = [];
  const enteredEchoes: unknown[] = [];
  // Observe entry into the real tool. No client, descriptor, or tool result is replaced.
  const observedEcho: typeof echo = {
    ...echo,
    *program(input, context) {
      enteredEchoes.push(input);
      return yield* echo.program(input, context);
    },
  };
  const greetingResult = z.union([
    z.object({ status: z.literal("ok"), text: z.string() }),
    z.object({ status: z.enum(["decline", "cancel"]) }),
  ]);
  const greetingMode = options.greeting;
  // Two host-selected interpretations of the same request/result contract.
  // Each interpretation has a distinct pinned identity; recovery keeps that choice.
  const greet = createDurableTool("greet")
    .description("Produce a greeting for a name.")
    .identity({ version: "0.0.1", digest: sha256(`greet-experiment-v1:${greetingMode}`) })
    .parameters(z.object({ name: z.string().max(256) }))
    .output(greetingResult)
    .execute(function* ({ name }, context) {
      if (greetingMode === "pure") {
        return { status: "ok" as const, text: `Hello, ${name}!` };
      }
      const reply = z
        .union([
          z.object({ action: z.literal("accept"), content: z.object({ reply: z.string() }) }),
          z.object({ action: z.enum(["decline", "cancel"]) }),
        ])
        .parse(
          yield* context.pull({
            kind: "invoke",
            child: {
              id: ask.manifest.programId,
              version: ask.manifest.version,
              digest: ask.manifest.digest,
              input: { message: `How should we greet ${name}?` },
            },
          }),
        );
      return reply.action === "accept"
        ? { status: "ok" as const, text: reply.content.reply }
        : { status: reply.action };
    });
  const childHandlers = greetingMode ? [observedEcho, ask, greet] : [observedEcho, ask];
  // Experimental interpreter only: no new public DSL or app tool is installed.
  // The child gets explicit inputs and a fresh evaluator; its effects use the
  // real pinned tool programs and journal, including intermediate results.
  const delegate: BoundTool = createDurableTool("delegate")
    .description("Execute a quoted function with explicit arguments in a durable child.")
    .identity({
      version: "0.0.1",
      digest: sha256(
        JSON.stringify({
          interpreter: "tisyn-delegation-experiment-v3",
          handlers: childHandlers.map((tool) => ({
            name: tool.name,
            digest: tool.manifest.digest,
          })),
        }),
      ),
    })
    .parameters(
      z.object({
        code: z.json(),
        args: z.array(z.json()).max(8),
        handlers: z
          .record(z.string(), z.json())
          .refine((value) => Object.keys(value).length <= 8)
          .default({}),
      }),
    )
    .execute(function* ({ code, args, handlers }, context) {
      function callable(value: Json, arity: number): TisynFn<unknown[], unknown> {
        const validated = validateIr(value);
        if (
          !validated.ok ||
          value === null ||
          typeof value !== "object" ||
          Array.isArray(value) ||
          value.tisyn !== "fn" ||
          !Array.isArray(value.params) ||
          value.params.length !== arity
        ) {
          throw new Error("Expected a valid quoted function with matching parameters");
        }
        return value as unknown as TisynFn<unknown[], unknown>;
      }
      const fn = callable(code, args.length);
      for (const [name, handler] of Object.entries(handlers)) {
        if (!childHandlers.some((tool) => tool.name === name)) {
          throw new Error("Handler must target an admitted effect");
        }
        callable(handler, 1);
      }
      // Get reads a literal wrapper. Even IR-shaped arguments remain inert data.
      const evaluation = yield* createEvaluation(
        Call(fn, ...args.map((value) => Get({ value }, "value"))) as TisynExpr,
      );
      let step = yield* evaluation.next();
      while (!step.done) {
        const descriptor = step.value;
        const tool = childHandlers.find((candidate) => candidate.name === descriptor.id);
        if (!tool) {
          throw new Error("Unsupported child effect");
        }
        const input = validateAuthoredSchema<Json>(tool.parameters, descriptor.data);
        if (input.status !== "ok") {
          throw new Error("Invalid handled effect input");
        }
        const handler = Object.hasOwn(handlers, descriptor.id)
          ? handlers[descriptor.id]
          : undefined;
        const value = yield* context.pull({
          kind: "invoke",
          child: {
            id: handler === undefined ? tool.manifest.programId : delegate.manifest.programId,
            version: handler === undefined ? tool.manifest.version : delegate.manifest.version,
            digest: handler === undefined ? tool.manifest.digest : delegate.manifest.digest,
            input:
              handler === undefined
                ? descriptor.data
                : {
                    code: handler,
                    args: [descriptor.data],
                    // Handlers run against the enclosing host bindings. The handled
                    // effect is not recursively intercepted by its own handler.
                    handlers: {},
                  },
          },
        });
        if (tool.output && validateAuthoredSchema<Json>(tool.output, value).status !== "ok") {
          throw new Error("Invalid handled effect output");
        }
        step = yield* evaluation.next(assertJson(value));
      }
      return step.value;
    });
  const bindings = options.delegation ? [...childHandlers, delegate] : childHandlers;
  if (options.delegation) {
    parseProgram(source, bindings);
  }
  const builder = createTisynTool(bindings);
  const runner =
    options.childSource === undefined
      ? (decision ? builder.decisions(decisionBinding) : builder).build()
      : createSessionTool([observedEcho, ask]);
  const tools = [runner, ...bindings];
  const registry = createDurableToolRegistry(tools);
  const active = new Set<ProgramAttachment>();
  const evaluations = new Set<string>();
  const openedEvaluations: string[] = [];
  const evaluatedPrograms = new Set<string>();
  const attach = {
    sessionId: "tisyn-test",
    taskId: "turn-0/root",
    program: {
      id: runner.manifest.programId,
      version: runner.manifest.version,
      digest: runner.manifest.digest,
    },
    input: assertJson(
      options.childSource === undefined
        ? { program: source }
        : { parent: source, child: options.childSource, sessionId: "researcher" },
    ),
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
          yield* TisynEvaluationPort.installDriver(
            options.runtime === "quickjs"
              ? createQuickJSEvaluationDriver(
                  memoizePromiseFactory(() => newQuickJSWASMModuleFromVariant(variant)),
                )
              : createNodeEvaluationDriver(),
          );
          if (decision) {
            yield* installDecisionProvider({
              *decide(input) {
                decisions.push(input);
                return { answer: decision, model: decisionBinding, usage: null };
              },
            });
          }
          yield* TisynEvaluationPort.api.around({
            *open(args, next) {
              const handle = yield* next(...args);
              evaluations.add(handle);
              openedEvaluations.push(handle);
              evaluatedPrograms.add(JSON.stringify(args[0]));
              return handle;
            },
            *close([handle], next) {
              yield* next(handle);
              evaluations.delete(handle);
            },
          });
          return yield* DurableEffectRegistryContext.with(
            createDurableEffectRegistry(decision ? [createDecisionEffectRegistration()] : []),
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
    decisions,
    active,
    evaluations,
    openedEvaluations,
    evaluatedPrograms,
    attach,
    authorityOptions,
  };
}

describe("Tisyn profile", () => {
  it("exposes Scheme authoring while retaining child interaction contracts", async () => {
    const entries = programs.map((tool) => createToolInventoryEntry(tool));
    const definitions = await run(() => workflowExposure.filter({ phase: "outer-chat", entries }));
    expect(definitions.map((definition) => definition.name)).toEqual(["scheme"]);
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

describe("durable model decisions", () => {
  const classification =
    'Classify({"input":"Please continue", "instructions":"Classify intent", "choices":{"continue":"Continue", "stop":"Stop"}})';
  it("replays an accepted decision across scope replacement and resumes only the chosen parked branch", async () => {
    const f = fixture(
      `Let("d", ${classification}, Switch(Get(Ref("d"),"choice"), {
      "continue": Let("a", Eval("ask", {"message":"Next item?"}), Eval("echo", {"message":Get(Get(Ref("a"),"content"),"reply")})),
      "stop": Eval("echo", {"message":"unselected"})
    }, Throw("unknown decision")))`,
      {
        type: "choice",
        choice: "continue",
        confidence: 0.8,
        probabilities: [
          { value: "continue", probability: 0.9 },
          { value: "stop", probability: 0.1 },
        ],
      },
    );
    const parked = await run(function* () {
      const authority = yield* f.start();
      expect(yield* f.advanceUntilBlocked(authority)).toMatchObject({
        state: "parked",
        reason: "elicit",
      });
      expect(f.decisions).toHaveLength(1);
      expect(f.enteredEchoes).toEqual([]);
      return { snapshot: authority.exportSnapshot(), pending: f.pendingReply(authority) };
    });
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
      expect(
        yield* authority.resolve({
          capability,
          audience: "user:reply",
          outcome: { status: "ok", value: { action: "accept", content: { reply: "resumed" } } },
        }),
      ).not.toMatchObject({ status: "rejected" });
      expect(yield* f.advanceUntilBlocked(authority)).toMatchObject({
        state: "completed",
        value: { message: "resumed" },
      });
      expect(f.decisions).toHaveLength(1);
      expect(f.enteredEchoes).toEqual([{ message: "resumed" }]);
      const pulls = authority
        .readJournal(f.attach.sessionId)
        .filter(
          ({ payload }) => payload.type === "PullRequested" && payload.descriptor.kind === "effect",
        );
      expect(pulls).toHaveLength(1);
      expect(pulls[0].payload).toMatchObject({
        descriptor: { name: "model.decision", input: { binding: decisionBinding } },
      });
      expect(f.active.size).toBe(0);
      expect(f.evaluations.size).toBe(0);
    });
  });
  it("returns refusals as values and runs the authored refusal branch", async () => {
    const f = fixture(
      `Let("d", ${classification}, If(Eq(Get(Ref("d"),"type"),"refusal"), Eval("echo",{"message":"refused"}), Throw("must not run")))`,
      { type: "refusal" },
    );
    await run(function* () {
      const authority = yield* f.start();
      expect(yield* f.advanceUntilBlocked(authority)).toMatchObject({
        state: "completed",
        value: { message: "refused" },
      });
      expect(f.decisions).toHaveLength(1);
    });
  });
});

describe.each(["node", "quickjs"] as const)("quoted child delegation in %s", (runtime) => {
  it("quotes without effects, invokes with explicit inputs, and resumes the parent", async () => {
    const f = fixture(
      `Seq(Eval("echo",{"message":"parent before"}),
      Let("reply",Eval("delegate",{
        "code":Q(Fn(["name"],Eval("echo",{"message":Concat("Hello, ",Ref("name"),"!")}))),
        "args":["world"]
      }),Concat("Parent received: ",Get(Ref("reply"),"message"))))`,
      undefined,
      { delegation: true, runtime },
    );
    await run(function* () {
      const authority = yield* f.start();
      expect(yield* f.advanceUntilBlocked(authority)).toMatchObject({
        state: "completed",
        value: "Parent received: Hello, world!",
      });
      expect(f.enteredEchoes).toEqual([{ message: "parent before" }, { message: "Hello, world!" }]);
      // The driver can reconstruct each program at intermediate pull boundaries.
      expect(f.evaluatedPrograms.size).toBe(2);
      expect(new Set(f.openedEvaluations).size).toBe(f.openedEvaluations.length);
      expect(f.evaluations.size).toBe(0);
      expect(f.active.size).toBe(0);
      const invokes = authority
        .readJournal(f.attach.sessionId)
        .flatMap(({ payload }) =>
          payload.type === "PullRequested" && payload.descriptor.kind === "invoke" ? [payload] : [],
        );
      expect(invokes).toHaveLength(3);
      expect(invokes[0].taskId).toBe(invokes[1].taskId);
      expect(invokes[2].taskId).not.toBe(invokes[1].taskId);
    });
  });

  it("restores a parked child from JSON and does not repeat its accepted greeting", async () => {
    const f = fixture(
      `Let("result",Eval("delegate",{"code":Q(Fn(["name"],
      LetMany([
        ["greeting",Eval("echo",{"message":Concat("Hello, ",Ref("name"),"!")})],
        ["reply",Eval("ask",{"message":"What should I say next?"})]
      ],If(Eq(Get(Ref("reply"),"action"),"accept"),
        Eval("echo",{"message":Get(Get(Ref("reply"),"content"),"reply")}),
        Get(Ref("reply"),"action"))))),"args":["world"]}),
        Construct({"parentReceived":Ref("result")}))`,
      undefined,
      { delegation: true, runtime },
    );
    const parked = await run(function* () {
      const authority = yield* f.start();
      expect(yield* f.advanceUntilBlocked(authority)).toMatchObject({
        state: "parked",
        reason: "elicit",
      });
      expect(f.enteredEchoes).toEqual([{ message: "Hello, world!" }]);
      expect(f.evaluations.size).toBe(0);
      expect(f.active.size).toBe(0);
      return {
        snapshot: authority.exportSnapshot(),
        pending: f.pendingReply(authority),
        accepted: authority.readJournal(f.attach.sessionId),
      };
    });
    // Both evaluators and the authority scope are gone. Only persisted JSON remains.
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
          outcome: {
            status: "ok",
            value: { action: "accept", content: { reply: "Welcome back!" } },
          },
        }),
      ).not.toMatchObject({ status: "rejected" });
      expect(yield* f.advanceUntilBlocked(authority)).toMatchObject({
        state: "completed",
        value: { parentReceived: { message: "Welcome back!" } },
      });
      expect(f.enteredEchoes).toEqual([{ message: "Hello, world!" }, { message: "Welcome back!" }]);
      expect(authority.readJournal(f.attach.sessionId).slice(0, parked.accepted.length)).toEqual(
        parked.accepted,
      );
      expect(f.openedEvaluations.length).toBeGreaterThanOrEqual(4);
      expect(new Set(f.openedEvaluations).size).toBe(f.openedEvaluations.length);
      expect(f.evaluations.size).toBe(0);
      expect(f.active.size).toBe(0);
    });
  });
});

// Identical source under both handler configurations. The child has no knowledge
// of whether greet is computed locally or fulfilled through a human interaction.
const greetingProgram = `Let("result",Eval("delegate",{
  "code":Q(Fn(["name"],Eval("greet",{"name":Ref("name")}))),
  "args":["world"]
}),Construct({"parentReceived":Ref("result")}))`;

describe.each(["node", "quickjs"] as const)("composed greeting handlers in %s", (runtime) => {
  it("resolves the greeting through a pure handler without elicitation", async () => {
    const f = fixture(greetingProgram, undefined, { delegation: true, runtime, greeting: "pure" });
    await run(function* () {
      const authority = yield* f.start();
      expect(yield* f.advanceUntilBlocked(authority)).toMatchObject({
        state: "completed",
        value: { parentReceived: { status: "ok", text: "Hello, world!" } },
      });
      const pulls = authority
        .readJournal(f.attach.sessionId)
        .flatMap(({ payload }) => (payload.type === "PullRequested" ? [payload] : []));
      expect(pulls.filter(({ descriptor }) => descriptor.kind === "elicit")).toHaveLength(0);
      expect(pulls.filter(({ descriptor }) => descriptor.kind === "invoke")).toHaveLength(2);
      expect(f.evaluatedPrograms.size).toBe(2);
      expect(f.evaluations.size).toBe(0);
      expect(f.active.size).toBe(0);
    });
  });

  it.each(["accept", "decline", "cancel"] as const)(
    "restores the human handler and propagates %s through child and parent",
    async (action) => {
      const f = fixture(greetingProgram, undefined, {
        delegation: true,
        runtime,
        greeting: "human",
      });
      const parked = await run(function* () {
        const authority = yield* f.start();
        expect(yield* f.advanceUntilBlocked(authority)).toMatchObject({
          state: "parked",
          reason: "elicit",
        });
        const pending = f.pendingReply(authority);
        expect(pending.descriptor).toMatchObject({
          context: { prompt: "How should we greet world?" },
        });
        expect(f.evaluations.size).toBe(0);
        expect(f.active.size).toBe(0);
        return {
          snapshot: authority.exportSnapshot(),
          pending,
          accepted: authority.readJournal(f.attach.sessionId),
        };
      });
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
            outcome: {
              status: "ok",
              value:
                action === "accept" ? { action, content: { reply: "Howdy, world!" } } : { action },
            },
          }),
        ).not.toMatchObject({ status: "rejected" });
        expect(yield* f.advanceUntilBlocked(authority)).toMatchObject({
          state: "completed",
          value: {
            parentReceived:
              action === "accept" ? { status: "ok", text: "Howdy, world!" } : { status: action },
          },
        });
        const journal = authority.readJournal(f.attach.sessionId);
        expect(journal.slice(0, parked.accepted.length)).toEqual(parked.accepted);
        const pulls = journal.flatMap(({ payload }) =>
          payload.type === "PullRequested" ? [payload] : [],
        );
        expect(pulls.filter(({ descriptor }) => descriptor.kind === "elicit")).toHaveLength(1);
        const invokes = pulls.filter(({ descriptor }) => descriptor.kind === "invoke");
        expect(invokes).toHaveLength(3);
        // Parent -> quoted child -> greeting handler -> ask: three distinct callers.
        expect(new Set(invokes.map(({ taskId }) => taskId)).size).toBe(3);
        expect(f.evaluations.size).toBe(0);
        expect(f.active.size).toBe(0);
      });
    },
  );
});

const authoredGreeting = (handler: string) => `Let("result",Eval("delegate",{
  "code":Q(Fn(["name"],Eval("greet",{"name":Ref("name")}))),
  "args":["world"],
  "handlers":{"greet":Q(${handler})}
}),Construct({"parentReceived":Ref("result")}))`;

const pureGreetingHandler = `Fn(["request"],Construct({
  "status":"ok","text":Concat("Authored hello, ",Get(Ref("request"),"name"),"!")
}))`;
const humanGreetingHandler = `Fn(["request"],Let("reply",Eval("ask",{
  "message":Concat("Write a greeting for ",Get(Ref("request"),"name"))
}),If(Eq(Get(Ref("reply"),"action"),"accept"),
  Construct({"status":"ok","text":Get(Get(Ref("reply"),"content"),"reply")}),
  Construct({"status":Get(Ref("reply"),"action")}))))`;

describe.each(["node", "quickjs"] as const)("Tisyn-authored handlers in %s", (runtime) => {
  it("runs the supplied handler and keeps the host binding outside its scope", async () => {
    const source = `Let("handled",${authoredGreeting(pureGreetingHandler)},
      Construct({"handled":Ref("handled"),"outside":Eval("greet",{"name":"world"})}))`;
    const f = fixture(source, undefined, { delegation: true, runtime, greeting: "pure" });
    await run(function* () {
      const authority = yield* f.start();
      expect(yield* f.advanceUntilBlocked(authority)).toMatchObject({
        state: "completed",
        value: {
          handled: { parentReceived: { status: "ok", text: "Authored hello, world!" } },
          outside: { status: "ok", text: "Hello, world!" },
        },
      });
      expect(f.evaluatedPrograms.size).toBe(3);
      expect(f.active.size).toBe(0);
      expect(f.evaluations.size).toBe(0);
    });
  });

  it.each(["accept", "decline", "cancel"] as const)(
    "recovers a parked authored handler on %s",
    async (action) => {
      const f = fixture(authoredGreeting(humanGreetingHandler), undefined, {
        delegation: true,
        runtime,
        greeting: "pure",
      });
      const parked = await run(function* () {
        const authority = yield* f.start();
        expect(yield* f.advanceUntilBlocked(authority)).toMatchObject({
          state: "parked",
          reason: "elicit",
        });
        const pending = f.pendingReply(authority);
        expect(pending.descriptor).toMatchObject({
          context: { prompt: "Write a greeting for world" },
        });
        expect(f.active.size).toBe(0);
        expect(f.evaluations.size).toBe(0);
        return {
          snapshot: authority.exportSnapshot(),
          pending,
          accepted: authority.readJournal(f.attach.sessionId),
        };
      });
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
            outcome: {
              status: "ok",
              value:
                action === "accept" ? { action, content: { reply: "Ahoy, world!" } } : { action },
            },
          }),
        ).not.toMatchObject({ status: "rejected" });
        expect(yield* f.advanceUntilBlocked(authority)).toMatchObject({
          state: "completed",
          value: {
            parentReceived:
              action === "accept" ? { status: "ok", text: "Ahoy, world!" } : { status: action },
          },
        });
        const journal = authority.readJournal(f.attach.sessionId);
        expect(journal.slice(0, parked.accepted.length)).toEqual(parked.accepted);
        const pulls = journal.flatMap(({ payload }) =>
          payload.type === "PullRequested" ? [payload] : [],
        );
        expect(pulls.filter(({ descriptor }) => descriptor.kind === "elicit")).toHaveLength(1);
        expect(pulls.filter(({ descriptor }) => descriptor.kind === "invoke")).toHaveLength(3);
        expect(f.evaluatedPrograms.size).toBe(3);
        expect(f.active.size).toBe(0);
        expect(f.evaluations.size).toBe(0);
      });
    },
  );

  it("lets a handler call its host implementation without intercepting itself", async () => {
    const f = fixture(authoredGreeting('Fn(["request"],Eval("greet",Ref("request")))'), undefined, {
      delegation: true,
      runtime,
      greeting: "pure",
    });
    await run(function* () {
      const authority = yield* f.start();
      expect(yield* f.advanceUntilBlocked(authority)).toMatchObject({
        state: "completed",
        value: {
          parentReceived: { status: "ok", text: "Hello, world!" },
        },
      });
      expect(f.active.size).toBe(0);
      expect(f.evaluations.size).toBe(0);
    });
  });
  it.each([
    'Fn([], "bad arity")',
    'Fn(["request"], "bad output")',
    'Fn(["request"], Ref("parentOnly"))',
  ])("fails an invalid handler without running later parent effects: %s", async (handler) => {
    const source = `Let("parentOnly","private",Seq(${authoredGreeting(handler)},Eval("echo",{"message":"must not run"})))`;
    const f = fixture(source, undefined, { delegation: true, runtime, greeting: "pure" });
    await run(function* () {
      const authority = yield* f.start();
      expect(yield* f.advanceUntilBlocked(authority)).toMatchObject({ state: "failed" });
      expect(f.enteredEchoes).toEqual([]);
      expect(f.active.size).toBe(0);
      expect(f.evaluations.size).toBe(0);
    });
  });

  it("passes IR-shaped JSON as an inert explicit argument", async () => {
    const f = fixture(
      `Eval("delegate",{
      "code":Q(Fn(["data"],Ref("data"))),
      "args":[Q(Eval("echo",{"message":"data only"}))]
    })`,
      undefined,
      { delegation: true, runtime },
    );
    await run(function* () {
      const authority = yield* f.start();
      expect(yield* f.advanceUntilBlocked(authority)).toMatchObject({
        state: "completed",
        value: {
          tisyn: "eval",
          id: "echo",
          data: { message: "data only" },
        },
      });
      expect(f.enteredEchoes).toEqual([]);
      expect(f.active.size).toBe(0);
      expect(f.evaluations.size).toBe(0);
    });
  });
});

const sessionChild = `Let("first",Eval("session.receive",{}),
  Let("budget",Eval("session.askParent",{"message":"What budget should I use?"}),
    Let("receipt",Eval("echo",{"message":Concat(Get(Ref("first"),"message")," with ",Ref("budget"))}),
      Let("second",Eval("session.turnResult",{"findings":Get(Ref("receipt"),"message")}),
        Let("closing",Eval("session.turnResult",{
          "comparison":Get(Ref("second"),"message"),
          "history":Arr(Get(Ref("first"),"message"),Get(Ref("second"),"message")),
          "budget":Ref("budget")
        }),If(Eq(Get(Ref("closing"),"type"),"close"),
          Construct({"turns":2,"budget":Ref("budget")}),Throw("Expected close")))))))`;
const sessionParent = `Let("question",Eval("session.send",{"sessionId":"researcher","turnId":1,"message":"Investigate A"}),
  Let("human",Eval("ask",{"message":Get(Get(Ref("question"),"question"),"message")}),
    Let("first",Eval("session.answer",{
      "sessionId":"researcher","turnId":1,"requestId":Get(Ref("question"),"requestId"),
      "answer":Get(Get(Ref("human"),"content"),"reply")
    }),Let("second",Eval("session.send",{"sessionId":"researcher","turnId":2,"message":"Compare B"}),
      Let("closed",Eval("session.close",{"sessionId":"researcher"}),
        Construct({"first":Ref("first"),"second":Ref("second"),"closed":Ref("closed")}))))))`;

describe.each(["node", "quickjs"] as const)("two-turn rendezvous in %s", (runtime) => {
  it("restores a pending parent question, retains child history, and closes after two turns", async () => {
    const f = fixture(sessionParent, undefined, { runtime, childSource: sessionChild });
    const parked = await run(function* () {
      const authority = yield* f.start();
      expect(yield* f.advanceUntilBlocked(authority)).toMatchObject({
        state: "parked",
        reason: "elicit",
      });
      const pending = f.pendingReply(authority);
      expect(pending.descriptor).toMatchObject({
        context: { prompt: "What budget should I use?" },
      });
      expect(f.enteredEchoes).toEqual([]);
      expect(f.active.size).toBe(0);
      expect(f.evaluations.size).toBe(0);
      return {
        snapshot: authority.exportSnapshot(),
        pending,
        accepted: authority.readJournal(f.attach.sessionId),
      };
    });
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
          outcome: { status: "ok", value: { action: "accept", content: { reply: "$500" } } },
        }),
      ).not.toMatchObject({ status: "rejected" });
      expect(yield* f.advanceUntilBlocked(authority)).toMatchObject({
        state: "completed",
        value: {
          first: {
            kind: "turnResult",
            sessionId: "researcher",
            turnId: 1,
            result: { findings: "Investigate A with $500" },
          },
          second: {
            kind: "turnResult",
            sessionId: "researcher",
            turnId: 2,
            result: {
              comparison: "Compare B",
              history: ["Investigate A", "Compare B"],
              budget: "$500",
            },
          },
          closed: { kind: "closed", sessionId: "researcher", result: { turns: 2, budget: "$500" } },
        },
      });
      expect(f.enteredEchoes).toEqual([{ message: "Investigate A with $500" }]);
      const journal = authority.readJournal(f.attach.sessionId);
      expect(journal.slice(0, parked.accepted.length)).toEqual(parked.accepted);
      const pulls = journal.flatMap(({ payload }) =>
        payload.type === "PullRequested" ? [payload] : [],
      );
      expect(pulls.filter(({ descriptor }) => descriptor.kind === "elicit")).toHaveLength(1);
      expect(
        pulls.filter(
          ({ descriptor }) =>
            descriptor.kind === "record" && descriptor.key.startsWith("session.exchange."),
        ),
      ).toHaveLength(4);
      expect(f.evaluatedPrograms.size).toBe(2);
      expect(f.active.size).toBe(0);
      expect(f.evaluations.size).toBe(0);
    });
  });
  it.each([
    ['Eval("session.send",{"sessionId":"researcher","turnId":2,"message":"too soon"})'],
    [
      'Eval("session.answer",{"sessionId":"researcher","turnId":1,"requestId":"wrong","answer":"$500"})',
    ],
    [
      'Eval("session.answer",{"sessionId":"another","turnId":1,"requestId":"1/question-1","answer":"$500"})',
    ],
    [
      'Eval("session.answer",{"sessionId":"researcher","turnId":2,"requestId":"1/question-1","answer":"$500"})',
    ],
    ['Eval("session.close",{"sessionId":"researcher"})'],
  ])("rejects an invalid command while the child waits: %s", async (command) => {
    const source = `Seq(Eval("session.send",{"sessionId":"researcher","turnId":1,"message":"Investigate A"}),${command},Eval("echo",{"message":"must not run"}))`;
    const f = fixture(source, undefined, { runtime, childSource: sessionChild });
    await run(function* () {
      const authority = yield* f.start();
      expect(yield* f.advanceUntilBlocked(authority)).toMatchObject({ state: "failed" });
      expect(f.enteredEchoes).toEqual([]);
      expect(f.active.size).toBe(0);
      expect(f.evaluations.size).toBe(0);
    });
  });

  it("rejects a parent returning while its child remains open", async () => {
    const f = fixture(
      'Eval("session.send",{"sessionId":"researcher","turnId":1,"message":"Investigate A"})',
      undefined,
      { runtime, childSource: sessionChild },
    );
    await run(function* () {
      const authority = yield* f.start();
      expect(yield* f.advanceUntilBlocked(authority)).toMatchObject({ state: "failed" });
      expect(f.active.size).toBe(0);
      expect(f.evaluations.size).toBe(0);
    });
  });
  it.each(["decline", "cancel"] as const)(
    "cancels the child after a restored human %s",
    async (action) => {
      const parent = `Let("question",Eval("session.send",{"sessionId":"researcher","turnId":1,"message":"Investigate A"}),
      Let("reply",Eval("ask",{"message":"Continue?"}),
        Let("stopped",Eval("session.cancel",{"sessionId":"researcher"}),
          Construct({"action":Get(Ref("reply"),"action"),"child":Ref("stopped")}))))`;
      const f = fixture(parent, undefined, { runtime, childSource: sessionChild });
      const parked = await run(function* () {
        const authority = yield* f.start();
        expect(yield* f.advanceUntilBlocked(authority)).toMatchObject({ state: "parked" });
        return { snapshot: authority.exportSnapshot(), pending: f.pendingReply(authority) };
      });
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
          value: { action, child: { kind: "cancelled", sessionId: "researcher" } },
        });
        expect(f.enteredEchoes).toEqual([]);
        expect(f.active.size).toBe(0);
        expect(f.evaluations.size).toBe(0);
      });
    },
  );

  it("rejects prohibited child operations before any parent effects", async () => {
    const f = fixture('Eval("echo",{"message":"must not run"})', undefined, {
      runtime,
      childSource: 'Seq(Eval("session.receive",{}),If(false,Eval("shell",{}),true))',
    });
    await run(function* () {
      const authority = yield* f.start();
      expect(yield* f.advanceUntilBlocked(authority)).toMatchObject({ state: "failed" });
      expect(f.enteredEchoes).toEqual([]);
      expect(f.openedEvaluations).toEqual([]);
    });
  });
});
