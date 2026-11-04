import { defineChatProgram, createChatToolBinding } from "@sweatpan.ts/chat-host";
import { createSqliteJournalStore } from "@sweatpan.ts/storage-sqlite";
import { createNodeSqliteConnection, v8Serializer } from "@sweatpan.ts/storage-sqlite/node";
import type { ChatLoopResult } from "@sweatpan.ts/chat";
import type { ModelResponse } from "@sweatpan.ts/providers";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { expect, it, onTestFinished } from "vitest";
import type { Operation, Work } from "@standard-durability/core";
import { defineEffect, type CapabilityRequest } from "@sweatpan.ts/core";
import type { ResolutionGrant } from "@sweatpan.ts/durable";
import { createProgramExecution } from "@sweatpan.ts/execution";
import {
  createEffectCapabilities,
  createHosting,
  installGuestRetention,
} from "@sweatpan.ts/hosting";
import {
  admitTool,
  createToolAcquisition,
  defineTool,
  installElicitHandlers,
  resolveToolExecution,
  type ToolInteraction,
} from "@sweatpan.ts/tools";
import {
  createHostedRecovery,
  createSqliteDatabaseRig,
  createProtocolRig,
} from "@sweatpan.ts/testing";
import type { Runtime } from "@sweatpan.ts/runtime";
import { forEachRuntime } from "../runtime/assembly.ts";
// Provisional build output: deterministic package-manifest bytes. The digest covers the
// entry point, contracts and declared dependency identities, but this fixture does not
// claim to serialize or independently reconstruct arbitrary JavaScript closures.
const logicalName = "review-document";
function artifactBytes(revision: string) {
  return JSON.stringify({
    format: "sweatpants-tool-fixture-v1",
    logical: logicalName,
    revision,
    entrypoint: `review-document:${revision}`,
    contract: `review-contract:${revision}`,
    evaluator: "scoped-iterator:v1",
    dependencies: [`review-schemas:${revision}`, "zod:fixture"],
  });
}
function reference(revision: string) {
  return `tool:sha256:${createHash("sha256").update(artifactBytes(revision)).digest("hex")}`;
}
const originalRef = reference("original");
const replacementRef = reference("replacement");
type Result = {
  revision: string;
  input: string;
  reviewed: string;
  approved: boolean;
};
// Tool author: a stable logical name, schemas and body; no authored digest or version suffix.
function authored(
  revision: "original" | "replacement",
  counts: Record<
    "original" | "replacement",
    {
      inputs: number;
      acquired: number;
      deliveries: number;
    }
  >,
) {
  const read = defineEffect({ key: "review.read", context: z.string(), response: z.string() });
  const approval = defineEffect({
    key: "review.approval",
    context: z.string(),
    response: z
      .string()
      .refine((value) => value === (revision === "original" ? "yes" : "confirm"))
      .transform(() => true),
  });
  const tool = defineTool(logicalName)
    .parameters(
      z.string().transform((value) => {
        counts[revision].inputs++;
        return revision === "original" ? value.trim().toLowerCase() : value.trim().toUpperCase();
      }),
    )
    .capabilities({ read })
    .elicits({ approval })
    .execute(function* (input, ctx): Operation<Result, CapabilityRequest> {
      const reviewed = yield* ctx.capabilities.read(input);
      if (!reviewed.ok) {
        throw new Error("Review unavailable");
      }
      const answer = yield* ctx.elicit("approval", `${revision}:${input}`);
      if (!answer.ok) {
        throw new Error("Approval unavailable");
      }
      return { revision, input, reviewed: reviewed.value, approved: answer.value };
    });
  return { tool, revision, program: reference(revision), bytes: artifactBytes(revision) };
}
function verifyArtifact<
  T extends {
    bytes: string;
    program: string;
  },
>(program: string, artifact: T) {
  const actual = `tool:sha256:${createHash("sha256").update(artifact.bytes).digest("hex")}`;
  if (actual !== program || artifact.program !== program) {
    throw new Error("Pinned tool artifact digest mismatch");
  }
  return artifact;
}
forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  it(`${runtime.name}: deployment defaults never replace an execution's pinned tool or answer contract`, async () => {
    const database = createSqliteDatabaseRig();
    onTestFinished(() => database.close());
    const counts = {
      original: { inputs: 0, acquired: 0, deliveries: 0 },
      replacement: { inputs: 0, acquired: 0, deliveries: 0 },
    };
    const original = authored("original", counts);
    const replacement = authored("replacement", counts);
    expect(original.tool.id).toBe(replacement.tool.id);
    expect(original.program).not.toBe(replacement.program);
    // Deployment owner: defaults select NEW invocations; inventory retains exact old artifacts.
    let defaultRef = originalRef;
    const inventory = new Map([
      [originalRef, original],
      [replacementRef, replacement],
    ]);
    let loseReservation = false;
    function task<T>(work: Work<T, Y>) {
      const execution = runtime.start(work);
      void execution.result.catch(() => undefined);
      onTestFinished(() => execution.cancel());
      return execution.result;
    }
    function lookup(program: string) {
      const artifact = inventory.get(program);
      if (!artifact) {
        throw new Error("Pinned tool artifact unavailable");
      }
      return verifyArtifact(program, artifact);
    }
    function contract(program: string) {
      const artifact = lookup(program);
      if (artifact.program !== program) {
        throw new Error("Pinned tool contract mismatch");
      }
      return artifact;
    }
    function assemble() {
      const db = database.database;
      // Application-owned reservation repairs a stop between selecting a revision and admission.
      // No SQLite transaction is held across a yielding schema or journal operation.
      db.exec(
        "CREATE TABLE IF NOT EXISTS tool_invocations (id TEXT PRIMARY KEY, logical TEXT NOT NULL, program TEXT NOT NULL)",
      );
      function pinned(id: string) {
        const row = db.prepare("SELECT logical, program FROM tool_invocations WHERE id=?").get(id);
        if (!row || row.logical !== logicalName) {
          throw new Error("Unknown tool invocation");
        }
        return row.program as string;
      }
      function journal(id: string) {
        return createSqliteJournalStore<Result, CapabilityRequest, unknown, string, unknown, Y>({
          connection: createNodeSqliteConnection(db),
          id,
          program: pinned(id),
          equals: isDeepStrictEqual,
          serialization: {
            *resolve() {
              return v8Serializer;
            },
          },
        }).open();
      }
      return {
        journal,
        *submit(id: string, raw: string) {
          db.prepare("INSERT OR IGNORE INTO tool_invocations VALUES (?, ?, ?)").run(
            id,
            logicalName,
            defaultRef,
          );
          if (loseReservation) {
            loseReservation = false;
            throw new Error("Lost after revision reservation");
          }
          const program = pinned(id);
          const { tool } = contract(program);
          // Admission pins artifact identity, while the authored definition keeps its logical name.
          return yield* admitTool(
            runtime,
            { id: program, context: tool.context },
            journal(id),
            raw,
          );
        },
        *answer(id: string, grant: ResolutionGrant, raw: string) {
          const current = journal(id);
          const { tool } = contract(pinned(id));
          const effects = createEffectCapabilities(runtime, `answers:${id}`);
          const request = yield* current.interactions.request(grant);
          const outcome = yield* effects
            .grant(tool.elicits)
            .respond(request, { ok: true, value: raw });
          return yield* current.interactions.answer(grant, { ok: true, value: outcome });
        },
        *run(id: string) {
          const current = journal(id);
          const snapshot = yield* current.read();
          // Observing an already accepted terminal result does not require executable availability.
          if (snapshot.status === "completed") {
            return { state: "completed" as const, value: snapshot.value };
          }
          if (snapshot.status !== "running" || !snapshot.admission) {
            throw new Error("Tool is not admitted");
          }
          const program = snapshot.program;
          const effects = createEffectCapabilities(runtime, `effects:${id}`);
          const artifact = lookup(program);
          const { tool, revision } = artifact;
          const acquisition = createToolAcquisition(runtime, effects, tool, `acquire:${id}`);
          const execution = createProgramExecution({
            invocation: { program, input: snapshot.admission.input as string },
            *resolve(invocation) {
              return {
                program: artifact.program,
                *acquire() {
                  counts[revision].acquired++;
                  return yield* acquisition.operations.acquire(invocation.input);
                },
              };
            },
          });
          const recovery = createHostedRecovery(runtime, {
            name: `recovery:${id}`,
            program,
            matches: isDeepStrictEqual,
            acquire: execution.acquire,
          });
          const host = createHosting(runtime.composition, {
            name: `host:${id}`,
            journal: current,
            recovery: recovery.operations,
            attempts: current.attempts,
            interactions: current.interactions,
            handle: acquisition.handle,
          });
          yield* installGuestRetention(runtime.composition, host, recovery, current);
          yield* host.around({
            operations: acquisition.admission,
          });
          yield* installElicitHandlers(host, effects, tool);
          yield* effects.install(tool.capabilities.read, function* (input) {
            counts[revision].deliveries++;
            return { ok: true, value: `${revision} read ${input}` };
          });
          return yield* host.operations.run();
        },
      };
    }
    let app = assemble();
    await task(() => app.submit("old", " Report "));
    const old = await task(() => app.run("old"));
    expect(old.state).toBe("waiting");
    if (old.state !== "waiting") {
      throw new Error("Expected original approval");
    }
    expect(old.pending.request.input).toBe("original:report");
    // Also reserve a revision before admission, then lose that invocation's response.
    loseReservation = true;
    await expect(task(() => app.submit("reserved", " Report "))).rejects.toThrow(
      "revision reservation",
    );
    defaultRef = replacementRef;
    database.reopen();
    app = assemble();
    await task(() => app.submit("reserved", " Report "));
    expect((await task(app.journal("reserved").read)).program).toBe(originalRef);
    expect((await task(app.journal("reserved").read)).admission?.input).toBe("report");
    // Retried submission uses the original schema, even after changing the default.
    await task(() => app.submit("old", " Report "));
    await task(() => app.submit("new", " Report "));
    const next = await task(() => app.run("new"));
    if (next.state !== "waiting") {
      throw new Error("Expected replacement approval");
    }
    expect(next.pending.request.input).toBe("replacement:REPORT");
    const inputCounts = [counts.original.inputs, counts.replacement.inputs];
    expect((await task(app.journal("old").read)).program).toBe(originalRef);
    expect((await task(app.journal("new").read)).program).toBe(replacementRef);
    const beforeMissing = await task(app.journal("old").read);
    const beforeCounts = structuredClone(counts);
    inventory.delete(originalRef);
    await expect(task(() => app.run("old"))).rejects.toThrow("Pinned tool artifact unavailable");
    await expect(task(() => app.answer("old", old.grant, "yes"))).rejects.toThrow(
      "Pinned tool artifact unavailable",
    );
    expect(counts).toEqual(beforeCounts);
    expect(await task(app.journal("old").read)).toMatchObject({
      revision: beforeMissing.revision,
      program: beforeMissing.program,
      admission: beforeMissing.admission,
      pending: beforeMissing.status === "running" ? beforeMissing.pending : undefined,
    });
    // A resolver cannot substitute the current default under an old lookup key.
    inventory.set(originalRef, replacement);
    await expect(task(() => app.run("old"))).rejects.toThrow("artifact digest mismatch");
    await expect(task(() => app.answer("old", old.grant, "yes"))).rejects.toThrow(
      "artifact digest mismatch",
    );
    expect(counts).toEqual(beforeCounts);
    inventory.set(originalRef, original);
    database.reopen();
    app = assemble();
    expect(await task(() => app.run("old"))).toMatchObject({ state: "waiting", grant: old.grant });
    expect([counts.original.inputs, counts.replacement.inputs]).toEqual(inputCounts);
    expect(counts.original.deliveries).toBe(1);
    await expect(task(() => app.answer("old", old.grant, "confirm"))).rejects.toThrow();
    await expect(task(() => app.answer("new", next.grant, "yes"))).rejects.toThrow();
    await task(() => app.answer("old", old.grant, "yes"));
    await task(() => app.answer("new", next.grant, "confirm"));
    database.reopen();
    app = assemble();
    expect(await task(() => app.run("old"))).toEqual({
      state: "completed",
      value: {
        revision: "original",
        input: "report",
        reviewed: "original read report",
        approved: true,
      },
    });
    expect(await task(() => app.run("new"))).toEqual({
      state: "completed",
      value: {
        revision: "replacement",
        input: "REPORT",
        reviewed: "replacement read REPORT",
        approved: true,
      },
    });
    expect([counts.original.inputs, counts.replacement.inputs]).toEqual(inputCounts);
    expect([counts.original.deliveries, counts.replacement.deliveries]).toEqual([1, 1]);
    const terminalCounts = structuredClone(counts);
    inventory.clear();
    database.reopen();
    app = assemble();
    expect(await task(() => app.run("old"))).toMatchObject({
      state: "completed",
      value: { revision: "original" },
    });
    expect(await task(() => app.run("new"))).toMatchObject({
      state: "completed",
      value: { revision: "replacement" },
    });
    expect(counts).toEqual(terminalCounts);
  });
});
// Build-owned adapter experiment: create an executable declaration rather than mutate
// the author's frozen definition or leave its call builder targeting the logical ID.
function executable(artifact: ReturnType<typeof authored>) {
  const original = artifact.tool;
  const tool = defineTool(artifact.program)
    .parameters(original.context)
    .capabilities(original.capabilities)
    .elicits(original.elicits)
    .execute(original.body);
  return { ...artifact, logical: original.id, tool };
}
const chatInput = z.object({ prompt: z.string(), tool: z.string() });
const revisionChat = defineChatProgram({
  id: "tool-revision-chat-v1",
  history(input) {
    return [{ role: "user", content: chatInput.parse(input).prompt }];
  },
  toolResult(value) {
    return { content: JSON.stringify(value), isError: false };
  },
  result(completed) {
    return completed;
  },
});
function modelResponse(call: boolean): ModelResponse {
  return {
    message: {
      role: "assistant",
      content: call
        ? [
            {
              type: "tool-call",
              toolCall: {
                id: "review-call",
                name: "review_document",
                input: " Report ",
                thoughtSignature: null,
              },
            },
          ]
        : [{ type: "text", text: "Reviewed." }],
    },
    source: null,
    usage: null,
    stopReason: null,
    responseId: null,
    errorMessage: null,
  };
}
forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  it(`${runtime.name}: hosted chat pins executable tools while authors and models keep stable names`, async () => {
    const database = createSqliteDatabaseRig();
    onTestFinished(() => database.close());
    const counts = {
      original: { inputs: 0, acquired: 0, deliveries: 0 },
      replacement: { inputs: 0, acquired: 0, deliveries: 0 },
    };
    const original = executable(authored("original", counts));
    const replacement = executable(authored("replacement", counts));
    expect(original.logical).toBe(replacement.logical);
    expect(original.tool.id).toBe(originalRef);
    expect(replacement.tool.id).toBe(replacementRef);
    const inventory = new Map([
      [originalRef, original],
      [replacementRef, replacement],
    ]);
    let defaultRef = originalRef;
    const peer = createProtocolRig();
    const modelInputs: {
      id: string;
      history: unknown;
    }[] = [];
    function task<T>(work: Work<T, Y>) {
      const result = runtime.start(work);
      void result.result.catch(() => undefined);
      onTestFinished(() => result.cancel());
      return result.result;
    }
    function assemble() {
      const db = database.database;
      function journal(id: string) {
        return createSqliteJournalStore<
          ChatLoopResult,
          CapabilityRequest,
          unknown,
          string,
          unknown,
          Y
        >({
          connection: createNodeSqliteConnection(db),
          id,
          program: revisionChat.id,
          equals: isDeepStrictEqual,
          serialization: {
            *resolve() {
              return v8Serializer;
            },
          },
        }).open();
      }
      function exact(program: string) {
        const artifact = inventory.get(program);
        if (!artifact || artifact.tool.id !== program || artifact.logical !== logicalName) {
          throw new Error("Pinned chat tool artifact unavailable or mismatched");
        }
        return verifyArtifact(program, artifact);
      }
      function* bind(id: string) {
        const current = journal(id);
        const state = yield* current.read();
        const input = chatInput.parse(state.admission?.input);
        const artifact = exact(input.tool);
        const recovery = <R>(
          options: Parameters<
            typeof createHostedRecovery<R, CapabilityRequest, Y, unknown, string>
          >[1],
        ) =>
          createHostedRecovery<R, CapabilityRequest, Y, unknown, string>(runtime, {
            ...options,
            *acquire() {
              if (options.program === artifact.program) {
                counts[artifact.revision].acquired++;
              }
              return yield* options.acquire();
            },
          });
        const tool = createChatToolBinding(runtime, artifact.tool, {
          // Model-facing name and schema remain stable across these two executable revisions.
          definition: {
            name: "review_document",
            description: "Review a document",
            parameters: { type: "string" },
          },
          recovery,
          matches: isDeepStrictEqual,
          *configure({ effects }) {
            yield* effects.install(artifact.tool.capabilities.read, function* (value) {
              counts[artifact.revision].deliveries++;
              return { ok: true, value: `${artifact.revision} read ${value}` };
            });
          },
        });
        return revisionChat.bind(runtime, {
          journal: current,
          tools: [tool],
          recovery,
          matches: isDeepStrictEqual,
          sampling: {
            *sample(request) {
              expect(request.tools.map((entry) => entry.name)).toEqual(["review_document"]);
              modelInputs.push({ id, history: structuredClone(request.history) });
              const reply = yield* runtime.fromPromise((signal) =>
                peer.send({ id: `${id}:${request.round}`, token: "model" }, signal),
              );
              return {
                ok: true,
                value: {
                  model: { id: "planner", api: "scripted", provider: "scripted" },
                  response: modelResponse(z.enum(["call", "done"]).parse(reply.body) === "call"),
                },
              };
            },
          },
        });
      }
      return {
        journal,
        *submit(id: string) {
          const current = journal(id);
          const state = yield* current.read();
          // Trusted ingress selects the catalog, not a client-supplied artifact reference.
          const program = state.admission
            ? chatInput.parse(state.admission.input).tool
            : defaultRef;
          exact(program);
          yield* current.admit(revisionChat.id, { prompt: "Review my document", tool: program });
        },
        *run(id: string) {
          const state = yield* journal(id).read();
          if (state.status === "completed") {
            return { state: "completed" as const, value: state.value };
          }
          const chat = yield* bind(id);
          return yield* chat.run();
        },
        *questions(id: string) {
          const chat = yield* bind(id);
          const stream = yield* chat.interactions();
          const questions: ToolInteraction[] = [];
          while (true) {
            const item = yield* stream.next();
            if (item.done) {
              return questions;
            }
            questions.push(item.value);
          }
        },
        *answer(id: string, question: ToolInteraction, raw: string) {
          const chat = yield* bind(id);
          return yield* chat.answer(question, { ok: true, value: raw });
        },
        *resolve(id: string, execution: string) {
          const owner = journal(id);
          return yield* resolveToolExecution(
            {
              owner,
              programs: new Map(
                [...inventory].map(([program, artifact]) => [program, artifact.tool]),
              ),
              bind: (child, program) =>
                owner.openChildInteractions<CapabilityRequest, unknown, string>(child, program),
            },
            execution,
          );
        },
      };
    }
    let app = assemble();
    async function park(id: string) {
      const previous = peer.requests.length;
      const running = task(() => app.run(id));
      await Promise.race([peer.waitForRequests(previous + 1), running]);
      peer.reply(`${id}:0`, { status: 200, body: "call" });
      expect(await running).toMatchObject({ state: "child", reason: "waiting" });
      const questions = await task(() => app.questions(id));
      expect(questions).toHaveLength(1);
      return questions[0]!;
    }
    await task(() => app.submit("old-chat"));
    const old = await park("old-chat");
    expect(old).toMatchObject({ program: originalRef, input: "original:report" });
    // Pin before any model response or child creation, then change the deployed default.
    await task(() => app.submit("admitted-before-change"));
    defaultRef = replacementRef;
    database.reopen();
    app = assemble();
    await task(() => app.submit("old-chat"));
    await task(() => app.submit("new-chat"));
    const newer = await park("new-chat");
    expect(newer).toMatchObject({ program: replacementRef, input: "replacement:REPORT" });
    const delayed = await park("admitted-before-change");
    expect(delayed).toMatchObject({ program: originalRef, input: "original:report" });
    const before = structuredClone(counts);
    const missingPeerCount = peer.requests.length;
    const originalBytes = original.bytes;
    original.bytes = `${original.bytes}\ncorrupted`;
    await expect(task(() => app.run("old-chat"))).rejects.toThrow("artifact digest mismatch");
    await expect(task(() => app.questions("old-chat"))).rejects.toThrow("artifact digest mismatch");
    await expect(task(() => app.answer("old-chat", old, "yes"))).rejects.toThrow(
      "artifact digest mismatch",
    );
    original.bytes = originalBytes;
    expect(counts).toEqual(before);
    expect(peer.requests).toHaveLength(missingPeerCount);
    inventory.delete(originalRef);
    await expect(task(() => app.run("old-chat"))).rejects.toThrow("Pinned chat tool");
    await expect(task(() => app.questions("old-chat"))).rejects.toThrow("Pinned chat tool");
    await expect(task(() => app.answer("old-chat", old, "yes"))).rejects.toThrow(
      "Pinned chat tool",
    );
    await expect(task(() => app.resolve("old-chat", old.execution))).rejects.toThrow(
      "Pinned tool is unavailable",
    );
    inventory.set(originalRef, replacement);
    await expect(task(() => app.run("old-chat"))).rejects.toThrow("mismatched");
    await expect(task(() => app.resolve("old-chat", old.execution))).rejects.toThrow(
      "Pinned tool is unavailable",
    );
    expect(counts).toEqual(before);
    expect(peer.requests).toHaveLength(missingPeerCount);
    inventory.set(originalRef, original);
    database.reopen();
    app = assemble();
    expect(await task(() => app.questions("old-chat"))).toMatchObject([
      { program: originalRef, grant: old.grant },
    ]);
    const resolved = await task(() => app.resolve("old-chat", old.execution));
    expect(resolved.tool).toBe(original.tool);
    await expect(task(() => app.answer("new-chat", old, "yes"))).rejects.toThrow();
    await expect(task(() => app.answer("old-chat", old, "confirm"))).rejects.toThrow();
    await expect(task(() => app.answer("new-chat", newer, "yes"))).rejects.toThrow();
    expect(counts).toEqual(before); // Discovery, resolution and ingress do not acquire Guests or parse tool input.
    await task(() => app.answer("old-chat", old, "yes"));
    await task(() => app.answer("new-chat", newer, "confirm"));
    await task(() => app.answer("admitted-before-change", delayed, "yes"));
    database.reopen();
    app = assemble();
    for (const [id, revision, input] of [
      ["old-chat", "original", "report"],
      ["new-chat", "replacement", "REPORT"],
      ["admitted-before-change", "original", "report"],
    ] as const) {
      const previous = peer.requests.length;
      const running = task(() => app.run(id));
      await Promise.race([peer.waitForRequests(previous + 1), running]);
      const history = z.array(z.unknown()).parse(modelInputs.at(-1)!.history);
      const result = history.find(
        (
          entry,
        ): entry is {
          role: string;
          content: string;
          toolCallId: string;
        } =>
          typeof entry === "object" && entry !== null && "role" in entry && entry.role === "tool",
      );
      expect(result?.toolCallId).toBe("review-call");
      expect(JSON.parse(result!.content)).toEqual({
        revision,
        input,
        reviewed: `${revision} read ${input}`,
        approved: true,
      });
      peer.reply(`${id}:1`, { status: 200, body: "done" });
      expect(await running).toMatchObject({ state: "completed" });
    }
    expect([counts.original.inputs, counts.replacement.inputs]).toEqual([2, 1]);
    expect([counts.original.deliveries, counts.replacement.deliveries]).toEqual([2, 1]);
    const terminal = structuredClone(counts);
    database.reopen();
    app = assemble();
    expect(await task(() => app.answer("old-chat", old, "yes"))).toMatchObject({ duplicate: true });
    expect((await task(() => app.resolve("old-chat", old.execution))).tool.id).toBe(originalRef);
    expect(await task(() => app.questions("old-chat"))).toEqual([]);
    inventory.clear();
    expect(await task(() => app.run("old-chat"))).toMatchObject({ state: "completed" });
    expect(counts).toEqual(terminal);
    expect(peer.requests).toHaveLength(6);
  });
});
