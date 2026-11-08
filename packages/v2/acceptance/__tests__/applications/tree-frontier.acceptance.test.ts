import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { expect, it, onTestFinished } from "vitest";
import { z } from "zod";
import type { Operation, Outcome, Work } from "@standard-durability/core";
import type { JournalReader, OwnedJournal, ResolutionGrant } from "@sweatpan.ts/durable";
import { createLuaEvaluator, luaWasmUrl } from "@sweatpan.ts/codemode-runtime-lua";
import { createMemoryJournalStore } from "@sweatpan.ts/storage-memory";
import { createScopedGuest } from "@sweatpan.ts/execution";
import {
  childHostingResult,
  joinChildHostingResults,
  createHosting,
  createJournalTreeStream,
  type HostedResult,
  type JournalPresentationState,
} from "@sweatpan.ts/hosting";
import type { Runtime } from "@sweatpan.ts/runtime";
import {
  createHostedRecovery,
  createLatch,
  createProtocolRig,
  createSqliteJournalRig,
} from "@sweatpan.ts/testing";
import { forEachRuntime } from "../runtime/assembly.ts";

// Assertion helpers deliberately require a successful phase before reading its payload.
function reportOf<T>(edge: {
  drive: { status: "reported"; report: T } | { status: "unconfirmed"; error: string };
}): T {
  if (edge.drive.status !== "reported") {
    throw new Error(`Drive unconfirmed: ${edge.drive.error}`);
  }
  return edge.drive.report;
}
function frontierOf<T>(edge: {
  discovery: { status: "observed"; frontier: T } | { status: "unavailable"; error: string };
}): T {
  if (edge.discovery.status !== "observed") {
    throw new Error(`Discovery unavailable: ${edge.discovery.error}`);
  }
  return edge.discovery.frontier;
}

// Application-handled decline initiates compensation; independent child cancellation
// would cancel siblings under the current owned-group policy.
const source = `
local input = ...
local mode = type(input) == "table" and input.mode or input
if mode == "approval" then
  workflow.effect("approve", { kind = "approve" })
  return "approved"
end
return workflow.scope(function()
  if mode == "file" then
    return workflow.effect("read", { kind = "read", path = input.path })
  end
  return "declined"
end, function(completion)
  local released = workflow.effect("release", { kind = "release" })
  if released == "denied" then
    local decision = workflow.effect("repair", { kind = "repair" })
    assert(decision.action == "confirmed-released")
  else
    assert(released == "released")
  end
end)
`;
let module: Promise<WebAssembly.Module> | undefined;
const loadModule = () =>
  (module ??= readFile(luaWasmUrl).then((bytes) => WebAssembly.compile(bytes)));
// Pinned application declarations shared by projection and ingress. Lua request
// decoding does not infer contracts from code; these declarations are its protocol.
const interactions = {
  read: {
    context: z.object({ kind: z.literal("read"), path: z.string() }),
    response: z.string(),
    title: "Read file",
    audience: "participant",
    programs: ["frontier-file"],
  },
  approve: {
    context: z.object({ kind: z.literal("approve") }),
    response: z.literal("approved"),
    title: "Approve this step",
    audience: "participant",
    programs: ["frontier-approval"],
  },
  repair: {
    context: z.object({ kind: z.literal("repair") }),
    response: z
      .object({ action: z.literal("confirmed-released"), evidence: z.string().min(1) })
      .strict(),
    title: "Confirm resource release",
    audience: "operator",
    programs: ["frontier-compensation", "frontier-compensation-other", "frontier-file"],
  },
} as const;
type InteractionKind = keyof typeof interactions;
type Answer<K extends InteractionKind> = z.input<(typeof interactions)[K]["response"]>;
type Target<K extends InteractionKind = InteractionKind> = {
  execution: string;
  contract: K;
  grant: ResolutionGrant;
};
const answerTarget = z
  .object({
    execution: z.string(),
    contract: z.enum(["approve", "repair", "read"]),
    grant: z.object({ requestId: z.string(), resolutionId: z.string() }).strict(),
  })
  .strict();
const requestSchema = z.union([
  interactions.read.context,
  interactions.approve.context,
  interactions.repair.context,
  z.object({ kind: z.enum(["group", "release"]) }),
]);
type Request = z.infer<typeof requestSchema>;
type Mode = "root" | "group" | "approval" | "compensation" | "compensation-other" | "file";

for (const storage of ["memory", "sqlite"] as const) {
  forEachRuntime(<Y>(runtime: Runtime<Y>) => {
    type Journal = OwnedJournal<string, Request, unknown, string, unknown, Y>;
    type Node = {
      execution: string;
      program: string;
      parent?: string;
      state: JournalPresentationState<unknown, unknown>;
    };
    function start<T>(work: Work<T, Y>) {
      const task = runtime.start(work);
      void task.result.catch(() => undefined);
      onTestFinished(() => task.cancel());
      return task;
    }
    function scenario(independentCleanup = false, files = false) {
      const options = { program: "frontier-root", equals: isDeepStrictEqual };
      const store =
        storage === "sqlite"
          ? createSqliteJournalRig<string, Request, unknown, string, unknown, Y>(options)
          : (() => {
              const memory = createMemoryJournalStore<string, Request, unknown, string>(options);
              return { ...memory, reopen: () => memory.open(), close() {} };
            })();
      onTestFinished(() => store.close());
      const peer = createProtocolRig();
      const approvalReady = createLatch<void>();
      const repairReady = createLatch<void>();
      let acquisitions = 0;
      let parent = store.open();
      // Deployment metadata available to observation; acceptance keeps its original contracts.
      const discoveryContracts = new Set<InteractionKind>(["read", "approve", "repair"]);
      // Assertion-only paths for auditing known journals after reopen; never used by ingress.
      const auditPaths = new Map<string, readonly string[]>([[parent.id, []]]);
      function* bind(journal: Journal, mode: "root" | "group", requestId: string) {
        const modes: Mode[] =
          mode === "root"
            ? files
              ? ["file", "file", "file"]
              : independentCleanup
                ? ["group", "compensation", "compensation-other"]
                : ["group", "compensation"]
            : ["approval"];
        const children = yield* journal.ensureChildren<string, Request, unknown, string>(
          requestId,
          {
            children: modes.map((mode, index) => ({
              program: `frontier-${mode}`,
              input: mode === "file" ? { mode, path: ["/a.txt", "/b.txt", "/c.txt"][index] } : mode,
            })),
            outcome: (values) => ({ ok: true, value: values.join(",") }),
          },
        );
        for (const child of children) {
          const path = auditPaths.get(journal.id);
          if (!path) {
            throw new Error("Missing audit path");
          }
          auditPaths.set(child.journal.id, [...path, child.journal.id]);
        }
        return children.map((child, index) => ({
          journal: child.journal,
          mode: modes[index]!,
          input: child.link.input,
        }));
      }
      function* drive(
        journal: Journal,
        mode: Mode,
        yieldCleanup: boolean,
        maxIterations = Number.POSITIVE_INFINITY,
        boundInput: unknown = mode,
      ): Operation<HostedResult<string, Request>, Y> {
        const leaf = mode !== "root" && mode !== "group";
        const lua = createLuaEvaluator(runtime, {
          source,
          input: boundInput,
          loadModule,
          decodeRequest: (value) => z.object({ request: requestSchema }).parse(value).request,
          decodeResult: (value) => z.string().parse(value),
        });
        const recovery = createHostedRecovery<string, Request, Y, unknown, string>(runtime, {
          name: `frontier-${journal.id}`,
          program: `frontier-${mode}`,
          matches: isDeepStrictEqual,
          *acquire() {
            acquisitions++;
            if (leaf) {
              return yield* lua.acquire();
            }
            return createScopedGuest(function* () {
              const value: unknown = yield { kind: "group" };
              return z.string().parse(value);
            });
          },
        });
        const host = createHosting(runtime.composition, {
          name: `host-${journal.id}`,
          journal,
          recovery: recovery.operations,
          attempts: journal.attempts,
          interactions: journal.interactions,
          *handle(request: Request): Operation<Outcome<unknown, string>, Y> {
            const reply = yield* runtime.fromPromise((signal) =>
              peer.send(
                {
                  id:
                    mode === "file"
                      ? `${request.kind}:${journal.id}`
                      : mode === "compensation-other"
                        ? `${request.kind}-other`
                        : request.kind,
                  token: journal.id,
                },
                signal,
              ),
            );
            return { ok: true, value: reply.body };
          },
        });
        let iterations = 0;
        let steps = 0;
        yield* host.around({
          *continuation() {
            if (steps++ >= maxIterations) {
              return { action: "yield", reason: "edge budget" };
            }
            if (yieldCleanup && mode === "compensation" && iterations++ > 0) {
              return { action: "yield", reason: "one cleanup step" };
            }
            return { action: "continue" };
          },
          *deliveryMode([request]) {
            return request.kind === "approve" ||
              request.kind === "repair" ||
              request.kind === "read"
              ? "wait"
              : "execute";
          },
          *child([pending]) {
            if (mode !== "root" && mode !== "group") {
              return undefined;
            }
            const children = yield* bind(journal, mode, pending.id);
            return {
              id: pending.id,
              *run() {
                const reports = yield* runtime.all(
                  children.map(
                    (child) =>
                      function* () {
                        return childHostingResult(
                          yield* drive(
                            child.journal,
                            child.mode,
                            yieldCleanup,
                            maxIterations,
                            child.input,
                          ),
                        );
                      },
                  ),
                );
                return joinChildHostingResults(reports);
              },
            };
          },
        });
        const report = yield* host.operations.run();
        if (mode === "approval") {
          approvalReady.resolve();
        }
        if (mode === "compensation" && report.state === "waiting") {
          repairReady.resolve();
        }
        return report;
      }
      // A finite application observation. Each node carries its own revision; this
      // deliberately promises no atomic tree snapshot and performs no advancement.
      function* observeWork() {
        const intent = yield* store.activations.read();
        const nodes: Node[] = [];
        const snapshot = yield* parent.read();
        expect(yield* parent.readChildren("unknown-boundary")).toEqual([]);
        if (snapshot.status === "running" && snapshot.pending && snapshot.children) {
          expect(yield* parent.readChildren(snapshot.pending.id)).toEqual(snapshot.children);
        }
        const history = yield* snapshot.history.read(0, snapshot.history.end.position || 1);
        for (const entry of history) {
          for (const link of yield* parent.readChildren(entry.receipt)) {
            expect(link.parentId).toBe(parent.id);
            expect(link.requestId).toBe(entry.receipt);
            const child = yield* parent.openChild(link.childId);
            expect((yield* child.read()).program).toBe(link.program);
          }
        }
        const stream = yield* createJournalTreeStream(runtime.composition, parent);
        while (true) {
          const item = yield* stream.next();
          if (item.done) {
            break;
          }
          const node = item.value;
          nodes.push({
            execution: node.execution,
            program: node.program,
            parent: node.parent?.execution,
            state: node.state,
          });
        }
        expect(yield* store.activations.read()).toEqual(intent);
        return nodes;
      }
      function observe() {
        return start(observeWork).result;
      }
      function* accept(targetInput: unknown, input: unknown, role: "participant" | "operator") {
        const target = answerTarget.parse(targetInput);
        const opened = yield* parent.openDescendantInteractions(target.execution);
        const ingress = opened.journal.interactions;
        const request = requestSchema.parse(yield* ingress.request(target.grant));
        if (request.kind !== target.contract) {
          throw new Error("Interaction contract mismatch");
        }
        const contract = interactions[target.contract];
        if (!(contract.programs as readonly string[]).includes(opened.link.program)) {
          throw new Error("Program does not declare this interaction");
        }
        if (contract.audience === "operator" && role !== "operator") {
          throw new Error("Operator authorization required");
        }
        contract.context.parse(request);
        const value = contract.response.parse(input);
        // The journal rechecks authority atomically; this earlier read grants no lease.
        return yield* ingress.answer(target.grant, { ok: true, value });
      }
      function submit(targetInput: unknown, input: unknown, role: "participant" | "operator") {
        return start(() => accept(targetInput, input, role)).result;
      }
      function project(nodes: Node[], role: "participant" | "operator") {
        return nodes.flatMap((node) => {
          const state = node.state;
          if (
            state.status !== "running" ||
            state.interaction?.state !== "waiting" ||
            !state.pending
          ) {
            return [];
          }
          const kind = requestSchema.parse(state.pending.request).kind;
          if (kind !== "approve" && kind !== "repair" && kind !== "read") {
            throw new Error("Unknown participant contract");
          }
          if (!discoveryContracts.has(kind)) {
            throw new Error("Discovery contract unavailable");
          }
          const contract = interactions[kind];
          if (!(contract.programs as readonly string[]).includes(node.program)) {
            throw new Error("Unknown interaction program");
          }
          if (contract.audience === "operator" && role !== "operator") {
            return [];
          }
          return [
            {
              execution: node.execution,
              contract: kind,
              grant: state.interaction.grant,
              revision: state.revision,
              scope: state.pending.scope,
              cancellation: state.cancellation,
              cancellationRequested: state.cancellationRequested,
              title: contract.title,
              context: contract.context.parse(state.pending.request),
              responseSchema: z.toJSONSchema(contract.response),
            },
          ];
        });
      }
      return {
        advance(
          request: {
            answers: readonly { target: unknown; value: unknown }[];
            maxIterationsPerHost: number;
          },
          role: "participant" | "operator",
        ) {
          return start(function* () {
            if (
              !Number.isSafeInteger(request.maxIterationsPerHost) ||
              request.maxIterationsPerHost < 0
            ) {
              throw new Error("Invalid edge budget");
            }
            const answers = [];
            for (const [index, answer] of request.answers.entries()) {
              const result = yield* runtime.composition.catchError(
                function* () {
                  const accepted = yield* accept(answer.target, answer.value, role);
                  return {
                    index,
                    status: "accepted" as const,
                    duplicate: accepted.duplicate,
                    receipt: accepted.entry.receipt,
                  };
                },
                function* (error) {
                  // An exception does not prove storage rolled back. Retrying the
                  // identical grant/value may reconcile an unconfirmed acceptance.
                  return { index, status: "unconfirmed" as const, error: String(error) };
                },
              );
              answers.push(result);
            }
            const driving = yield* runtime.composition.catchError(
              function* () {
                const report = yield* drive(parent, "root", false, request.maxIterationsPerHost);
                return { status: "reported" as const, report };
              },
              function* (error) {
                return { status: "unconfirmed" as const, error: String(error) };
              },
            );
            // Observation is attempted even after a drive error. It is a separate snapshot,
            // not proof that advancement succeeded or that accepted answers rolled back.
            const discovery = yield* runtime.composition.catchError(
              function* () {
                return {
                  status: "observed" as const,
                  frontier: project(yield* observeWork(), role),
                };
              },
              function* (error) {
                return { status: "unavailable" as const, error: String(error) };
              },
            );
            return { answers, drive: driving, discovery };
          });
        },
        audit() {
          return start(function* () {
            const nodes = [];
            for (const [id, path] of auditPaths) {
              let reader: JournalReader<unknown, unknown, unknown, unknown, unknown, Y> = parent;
              for (const childId of path) {
                reader = yield* reader.openChild(childId);
              }
              const state = yield* reader.read();
              nodes.push({
                id,
                revision: state.revision,
                status: state.status,
                frontier: state.frontier,
                entries: yield* state.history.read(0, Math.max(1, state.history.end.position)),
              });
            }
            return { nodes, intent: yield* store.activations.read() };
          }).result;
        },
        submit,
        discoveryContracts,
        respond<K extends InteractionKind>(
          target: Target<K>,
          input: Answer<NoInfer<K>>,
          role: "participant" | "operator",
        ) {
          return submit(target, input, role);
        },
        frontier(role: "participant" | "operator") {
          return start(function* () {
            return project(yield* observeWork(), role);
          }).result;
        },
        peer,
        approvalReady,
        repairReady,
        observe,
        get acquisitions() {
          return acquisitions;
        },
        run: (yieldCleanup = false) => start(() => drive(parent, "root", yieldCleanup)),
        reopen() {
          store.reopen();
          parent = store.open();
        },
        answer(node: Node, grant: ResolutionGrant) {
          if (node.state.status !== "running" || !node.state.pending) {
            throw new Error("No interaction");
          }
          const kind = requestSchema.parse(node.state.pending.request).kind;
          if (kind !== "approve" && kind !== "repair" && kind !== "read") {
            throw new Error("Not a participant request");
          }
          return submit(
            { execution: node.execution, contract: kind, grant },
            kind === "approve"
              ? "approved"
              : { action: "confirmed-released", evidence: "operator-record-1" },
            "operator",
          );
        },
        cancel() {
          return start(function* () {
            const snapshot = yield* parent.read();
            if (snapshot.status !== "running" || !snapshot.pending) {
              throw new Error("No pending tree");
            }
            yield* parent.cancellation.request(snapshot.pending.id, "cancel tree");
          }).result;
        },
        reader: (): JournalReader<unknown, unknown, unknown, unknown, unknown, Y> => parent,
        open: (id: string) => start(() => parent.openChild(id)).result,
        async begin(yieldCleanup = false) {
          const task = this.run(yieldCleanup);
          await Promise.race([
            Promise.all([peer.waitForRequests(independentCleanup ? 2 : 1), approvalReady.promise]),
            task.result,
          ]);
          return task;
        },
      };
    }
    function interaction(nodes: Node[], kind: "approve" | "repair") {
      const node = nodes.find(
        (node) =>
          node.state.status === "running" &&
          node.state.pending !== undefined &&
          requestSchema.parse(node.state.pending?.request).kind === kind,
      );
      if (!node || node.state.status !== "running" || node.state.interaction?.state !== "waiting") {
        throw new Error(`Missing ${kind}`);
      }
      return { node, grant: node.state.interaction.grant };
    }
    it(`${runtime.name}/${storage}: tree stream reads each node once in owned order without reading history`, async () => {
      const s = scenario();
      const task = await s.begin();
      s.peer.reply("release", { status: 200, body: "denied" });
      await task.result;
      s.reopen();
      const acquired = s.acquisitions;
      const reads: string[] = [];
      const opens: string[] = [];
      let historyReads = 0;
      type Reader = JournalReader<unknown, unknown, unknown, unknown, unknown, Y>;
      // Instrument the public storage capability while delegating to the real store.
      function tracked(reader: Reader): Reader {
        return {
          id: reader.id,
          readChildren: reader.readChildren,
          *read() {
            reads.push(reader.id);
            const snapshot = yield* reader.read();
            return {
              ...snapshot,
              history: {
                ...snapshot.history,
                *read(from, limit) {
                  historyReads++;
                  return yield* snapshot.history.read(from, limit);
                },
                *at(position) {
                  historyReads++;
                  return yield* snapshot.history.at(position);
                },
              },
            };
          },
          *openChild(id) {
            opens.push(id);
            const child = yield* reader.openChild(id);
            expect(Object.keys(child).sort()).toEqual(["id", "openChild", "read", "readChildren"]);
            return tracked(child);
          },
        };
      }
      const before = await s.audit();
      const nodes = await start(function* () {
        const source = createJournalTreeStream(runtime.composition, tracked(s.reader()));
        const subscription = yield* source;
        expect(reads).toEqual([]);
        const nodes = [];
        while (true) {
          const item = yield* subscription.next();
          if (item.done) {
            break;
          }
          nodes.push(item.value);
        }
        expect(yield* subscription.next()).toEqual({ done: true, value: undefined });
        return nodes;
      }).result;
      expect(nodes.map((node) => node.program)).toEqual([
        "frontier-root",
        "frontier-group",
        "frontier-approval",
        "frontier-compensation",
      ]);
      expect(reads).toEqual(nodes.map((node) => node.execution));
      expect(opens).toEqual(reads.slice(1));
      expect(historyReads).toBe(0);
      expect(nodes[0]!.parent).toBeUndefined();
      expect(nodes[2]!.parent?.execution).toBe(nodes[1]!.execution);
      expect(nodes[3]!.parent?.execution).toBe(nodes[0]!.execution);
      expect(s.acquisitions).toBe(acquired);
      expect(await s.audit()).toEqual(before);
    });
    it(`${runtime.name}/${storage}: stopping a tree stream releases its owner without opening unvisited children`, async () => {
      const s = scenario();
      const task = await s.begin();
      s.peer.reply("release", { status: 200, body: "denied" });
      await task.result;
      const reader = s.reader();
      let opens = 0;
      const escaped = await start(function* () {
        const subscription = yield* createJournalTreeStream(runtime.composition, {
          id: reader.id,
          readChildren: reader.readChildren,
          read: reader.read,
          *openChild(id) {
            opens++;
            return yield* reader.openChild(id);
          },
        });
        const root = yield* subscription.next();
        expect(root.done).toBe(false);
        return subscription;
      }).result;
      expect(opens).toBe(0);
      await expect(start(() => escaped.next()).result).rejects.toThrow("scope exited");
      expect(opens).toBe(0);
      expect(await s.frontier("operator")).toHaveLength(2);
    });
    it(`${runtime.name}/${storage}: tree observations retain separate snapshots and fail explicitly on denied navigation`, async () => {
      const s = scenario();
      const task = await s.begin();
      s.peer.reply("release", { status: 200, body: "denied" });
      await task.result;
      await start(function* () {
        const subscription = yield* createJournalTreeStream(runtime.composition, s.reader());
        const root = yield* subscription.next();
        if (root.done || root.value.state.status !== "running") {
          throw new Error("Expected running root");
        }
        expect(root.value.state.cancellationRequested).toBeUndefined();
        yield* runtime.fromPromise(() => s.cancel());
        const group = yield* subscription.next();
        if (group.done || group.value.state.status !== "running") {
          throw new Error("Expected running group");
        }
        expect(group.value.state.cancellationRequested).toMatchObject({ reason: "cancel tree" });
        expect(root.value.state.cancellationRequested).toBeUndefined();
      }).result;
      const reader = s.reader();
      let attempts = 0;
      await start(function* () {
        const subscription = yield* createJournalTreeStream(runtime.composition, {
          id: reader.id,
          readChildren: reader.readChildren,
          read: reader.read,
          *openChild() {
            attempts++;
            throw new Error("Observation access denied");
          },
        });
        expect((yield* subscription.next()).done).toBe(false);
        for (let index = 0; index < 2; index++) {
          yield* runtime.composition.catchError(
            function* () {
              yield* subscription.next();
              throw new Error("Expected failed traversal");
            },
            function* (error) {
              expect(String(error)).toContain("Observation access denied");
            },
          );
        }
        expect(attempts).toBe(1);
      }).result;
    });
    it.each(["approve", "repair"] as const)(
      `${runtime.name}/${storage}: reopened tree exposes body and cleanup waits; answering %s preserves its sibling`,
      async (first) => {
        const s = scenario();
        const task = await s.begin();
        const during = await s.observe();
        expect(interaction(during, "approve").node.state).toMatchObject({
          pending: { scope: { phase: "body" } },
        });
        expect(
          during.find(
            (node) =>
              node.state.status === "running" && node.state.pending?.scope?.phase === "cleanup",
          ),
        ).toBeDefined();
        s.peer.reply("release", { status: 200, body: "denied" });
        expect(await task.result).toMatchObject({ state: "child", reason: "waiting" });
        const acquired = s.acquisitions;
        s.reopen();
        const nodes = await s.observe();
        expect(nodes).toHaveLength(4);
        expect(s.acquisitions).toBe(acquired);
        const ordinary = interaction(nodes, "approve");
        const repair = interaction(nodes, "repair");
        expect(repair.node.state).toMatchObject({ pending: { scope: { phase: "cleanup" } } });
        // A grandchild cannot be opened directly from the root, nor can a root or unknown ID.
        await expect(s.open(ordinary.node.execution)).rejects.toThrow("direct owned child");
        await expect(s.open(nodes[0]!.execution)).rejects.toThrow("direct owned child");
        await expect(s.open("absent")).rejects.toThrow("direct owned child");
        const group = await s.open(ordinary.node.parent!);
        await expect(start(() => group.openChild(repair.node.execution)).result).rejects.toThrow(
          "direct owned child",
        );
        const chosen = first === "approve" ? ordinary : repair;
        const remaining = first === "approve" ? repair : ordinary;
        await s.answer(chosen.node, chosen.grant);
        expect(await s.run().result).toMatchObject({ state: "child", reason: "waiting" });
        s.reopen();
        expect(
          interaction(await s.observe(), first === "approve" ? "repair" : "approve").grant,
        ).toEqual(remaining.grant);
        await s.answer(remaining.node, remaining.grant);
        expect(await s.run().result).toEqual({ state: "completed", value: "approved,declined" });
        s.reopen();
        const historical = await s.open(ordinary.node.parent!);
        const leaf = await start(() => historical.openChild(ordinary.node.execution)).result;
        expect((await start(() => leaf.read()).result).status).toBe("completed");
        expect(s.peer.requests).toHaveLength(1);
      },
    );
    it.each(["released", "denied", "unknown"] as const)(
      `${runtime.name}/${storage}: one edge envelope resolves three reads and drives their cleanup (%s)`,
      async (cleanup) => {
        const s = scenario(false, true);
        const initial = await s.advance({ answers: [], maxIterationsPerHost: 16 }, "operator")
          .result;
        expect(frontierOf(initial)).toHaveLength(3);
        expect(frontierOf(initial).map((item) => item.context)).toEqual([
          { kind: "read", path: "/a.txt" },
          { kind: "read", path: "/b.txt" },
          { kind: "read", path: "/c.txt" },
        ]);
        expect(frontierOf(initial).every((item) => item.contract === "read")).toBe(true);
        const answers = frontierOf(initial).map((item, index) => ({
          target: { execution: item.execution, contract: item.contract, grant: item.grant },
          value: `file-${index}`,
        }));
        s.reopen();
        const task = s.advance({ answers, maxIterationsPerHost: 16 }, "operator");
        await Promise.race([s.peer.waitForRequests(3), task.result]);
        // All cleanup deliveries start before the edge returns. No client drive or
        // read between file answers, nor between their owned finally scopes.
        const requests = s.peer.requests;
        expect(requests).toHaveLength(3);
        for (const request of requests.slice(0, 2)) {
          s.peer.reply(request.id, { status: 200, body: "released" });
        }
        if (cleanup === "unknown") {
          s.peer.fail(requests[2]!.id, new Error("Unknown cleanup delivery"));
        } else {
          s.peer.reply(requests[2]!.id, { status: 200, body: cleanup });
        }
        const result = await task.result;
        expect(result.answers.map((answer) => answer.status)).toEqual([
          "accepted",
          "accepted",
          "accepted",
        ]);
        if (cleanup === "released") {
          expect(reportOf(result)).toEqual({ state: "completed", value: "file-0,file-1,file-2" });
          expect(frontierOf(result)).toEqual([]);
        } else if (cleanup === "denied") {
          expect(reportOf(result)).toMatchObject({ state: "child", reason: "waiting" });
          expect(frontierOf(result)).toHaveLength(1);
          const repair = frontierOf(result)[0]!;
          expect(repair).toMatchObject({ contract: "repair", scope: { phase: "cleanup" } });
          s.reopen();
          const repaired = await s.advance(
            {
              answers: [
                {
                  target: {
                    execution: repair.execution,
                    contract: repair.contract,
                    grant: repair.grant,
                  },
                  value: { action: "confirmed-released", evidence: "release-record-9" },
                },
              ],
              maxIterationsPerHost: 16,
            },
            "operator",
          ).result;
          expect(reportOf(repaired)).toEqual({ state: "completed", value: "file-0,file-1,file-2" });
          expect(frontierOf(repaired)).toEqual([]);
        } else {
          expect(result.drive).toMatchObject({
            status: "unconfirmed",
            error: expect.stringContaining("Unknown cleanup delivery"),
          });
          expect(result.discovery.status).toBe("observed");
          s.reopen();
          const resumed = await s.advance({ answers: [], maxIterationsPerHost: 16 }, "operator")
            .result;
          expect(reportOf(resumed)).toMatchObject({ state: "child", reason: "occupied" });
        }
        expect(s.peer.requests).toHaveLength(3);
      },
    );
    it(`${runtime.name}/${storage}: discovery failure preserves accepted answers and a yielded drive report`, async () => {
      const s = scenario(false, true);
      const initial = await s.advance({ answers: [], maxIterationsPerHost: 16 }, "operator").result;
      const first = frontierOf(initial)[0]!;
      const envelope = {
        answers: [
          {
            target: { execution: first.execution, contract: first.contract, grant: first.grant },
            value: "file-0",
          },
        ],
        maxIterationsPerHost: 0,
      };
      const acquired = s.acquisitions;
      s.discoveryContracts.delete("read"); // simulate missing deployment metadata, not a storage mock
      const result = await s.advance(envelope, "operator").result;
      expect(result.answers).toEqual([
        { index: 0, status: "accepted", duplicate: false, receipt: first.grant.requestId },
      ]);
      expect(reportOf(result)).toMatchObject({ state: "yielded" });
      expect(result.discovery).toMatchObject({
        status: "unavailable",
        error: expect.stringContaining("Discovery contract unavailable"),
      });
      expect("frontier" in result.discovery).toBe(false);
      expect(s.acquisitions).toBe(acquired);
      expect(s.peer.requests).toHaveLength(0);
      s.discoveryContracts.add("read");
      s.reopen();
      const accepted = await s.audit();
      const retry = await s.advance(envelope, "operator").result;
      expect(retry.answers).toEqual([
        { index: 0, status: "accepted", duplicate: true, receipt: first.grant.requestId },
      ]);
      expect(reportOf(retry)).toMatchObject({ state: "yielded" });
      expect(frontierOf(retry)).toHaveLength(2);
      expect(await s.audit()).toEqual(accepted);
      expect(s.acquisitions).toBe(acquired);
      expect(s.peer.requests).toHaveLength(0);
    });
    it(`${runtime.name}/${storage}: a lost terminal edge response can be retried without reopening file work`, async () => {
      const s = scenario(false, true);
      const initial = await s.advance({ answers: [], maxIterationsPerHost: 16 }, "operator").result;
      const answers = frontierOf(initial).map((item, index) => ({
        target: { execution: item.execution, contract: item.contract, grant: item.grant },
        value: `file-${index}`,
      }));
      const envelope = { answers, maxIterationsPerHost: 16 };
      const task = s.advance(envelope, "operator");
      await Promise.race([s.peer.waitForRequests(3), task.result]);
      for (const request of s.peer.requests) {
        s.peer.reply(request.id, { status: 200, body: "released" });
      }
      // Server settles; the transport drops the entire result before client delivery.
      await expect(
        task.result.then(() => {
          throw new Error("Response lost");
        }),
      ).rejects.toThrow("Response lost");
      s.reopen();
      const before = await s.audit();
      const acquired = s.acquisitions;
      const retry = await s.advance(envelope, "operator").result;
      expect(retry.answers).toEqual(
        answers.map((answer, index) => ({
          index,
          status: "accepted",
          duplicate: true,
          receipt: answer.target.grant.requestId,
        })),
      );
      expect(reportOf(retry)).toEqual({ state: "completed", value: "file-0,file-1,file-2" });
      expect(frontierOf(retry)).toEqual([]);
      const conflict = await s.advance(
        {
          ...envelope,
          answers: [
            { ...answers[0]!, value: "conflicting contents" },
            answers[1]!,
            answers[2]!,
            { ...answers[0]!, target: { ...answers[0]!.target, execution: "foreign-tree" } },
          ],
        },
        "operator",
      ).result;
      expect(conflict.answers.map((answer) => answer.status)).toEqual([
        "unconfirmed",
        "accepted",
        "accepted",
        "unconfirmed",
      ]);
      expect(reportOf(conflict)).toEqual(reportOf(retry));
      expect(s.acquisitions).toBe(acquired);
      expect(s.peer.requests).toHaveLength(3);
      expect(await s.audit()).toEqual(before);
    });
    it.each([false, true])(
      `${runtime.name}/${storage}: historical nested answers retain authority after terminal settlement (cancelled: %s)`,
      async (cancelled) => {
        const s = scenario();
        const task = await s.begin();
        s.peer.reply("release", { status: 200, body: "denied" });
        await task.result;
        const frontier = await s.frontier("operator");
        const answers = frontier.map((item) => ({
          target: { execution: item.execution, contract: item.contract, grant: item.grant },
          value:
            item.contract === "approve"
              ? "approved"
              : { action: "confirmed-released", evidence: "retained-evidence" },
        }));
        if (cancelled) {
          await s.cancel();
        }
        const envelope = { answers, maxIterationsPerHost: 16 };
        const settled = await s.advance(envelope, "operator").result;
        expect(reportOf(settled).state).toBe(cancelled ? "cancelled" : "completed");
        s.reopen();
        const before = await s.audit();
        const acquired = s.acquisitions;
        const retry = await s.advance(envelope, "operator").result;
        for (const [index, answer] of answers.entries()) {
          if (cancelled && answer.target.contract === "approve") {
            expect(retry.answers[index]).toMatchObject({
              status: "unconfirmed",
              error: expect.stringContaining("revoked"),
            });
          } else {
            expect(retry.answers[index]).toMatchObject({
              status: "accepted",
              duplicate: true,
              receipt: answer.target.grant.requestId,
            });
          }
        }
        expect(reportOf(retry)).toEqual(reportOf(settled));
        expect(frontierOf(retry)).toEqual([]);
        const repair = answers.find((answer) => answer.target.contract === "repair")!;
        const unauthorized = await s.advance({ ...envelope, answers: [repair] }, "participant")
          .result;
        expect(unauthorized.answers[0]).toMatchObject({
          status: "unconfirmed",
          error: expect.stringContaining("authorization"),
        });
        const conflict = await s.advance(
          {
            ...envelope,
            answers: [
              { ...repair, value: { action: "confirmed-released", evidence: "changed evidence" } },
            ],
          },
          "operator",
        ).result;
        expect(conflict.answers[0]).toMatchObject({ status: "unconfirmed" });
        expect(reportOf(conflict)).toEqual(reportOf(settled));
        expect(await s.audit()).toEqual(before);
        expect(s.acquisitions).toBe(acquired);
        expect(s.peer.requests).toHaveLength(1);
      },
    );
    it(`${runtime.name}/${storage}: edge batches report partial acceptance and reconcile duplicates before advancement`, async () => {
      const s = scenario(false, true);
      const initial = await s.advance({ answers: [], maxIterationsPerHost: 16 }, "operator").result;
      const answers = frontierOf(initial).map((item, index) => ({
        target: { execution: item.execution, contract: item.contract, grant: item.grant },
        value: `file-${index}`,
      }));
      const acquired = s.acquisitions;
      const partial = await s.advance(
        {
          answers: [
            answers[0]!,
            { ...answers[1]!, value: 5 },
            {
              ...answers[2]!,
              target: {
                ...answers[2]!.target,
                grant: { ...answers[2]!.target.grant, resolutionId: "stale" },
              },
            },
          ],
          maxIterationsPerHost: 0,
        },
        "operator",
      ).result;
      expect(partial.answers.map((answer) => answer.status)).toEqual([
        "accepted",
        "unconfirmed",
        "unconfirmed",
      ]);
      expect(frontierOf(partial).map((item) => item.grant)).toEqual(
        frontierOf(initial)
          .slice(1)
          .map((item) => item.grant),
      );
      expect(reportOf(partial)).toEqual({ state: "yielded", reason: "edge budget" });
      expect(s.acquisitions).toBe(acquired);
      expect(s.peer.requests).toEqual([]);
      s.reopen();
      // Retrying accepted input is safe; invalid/stale entries did not erase siblings.
      const retried = await s.advance({ answers, maxIterationsPerHost: 0 }, "operator").result;
      expect(retried.answers).toMatchObject([
        { status: "accepted", duplicate: true },
        { status: "accepted", duplicate: false },
        { status: "accepted", duplicate: false },
      ]);
      expect(frontierOf(retried)).toEqual([]);
      s.reopen();
      const resumed = s.advance({ answers: [], maxIterationsPerHost: 16 }, "operator");
      await Promise.race([s.peer.waitForRequests(3), resumed.result]);
      for (const request of s.peer.requests) {
        s.peer.reply(request.id, { status: 200, body: "released" });
      }
      expect(reportOf(await resumed.result)).toEqual({
        state: "completed",
        value: "file-0,file-1,file-2",
      });
    });
    it(`${runtime.name}/${storage}: typed frontier renders and routes independent approval and repair answers`, async () => {
      const s = scenario();
      const task = await s.begin();
      s.peer.reply("release", { status: 200, body: "denied" });
      await task.result;
      s.reopen();
      const acquired = s.acquisitions;
      const visible = await s.frontier("operator");
      const approval = visible.find((item) => item.contract === "approve")!;
      const repair = visible.find((item) => item.contract === "repair")!;
      expect(visible).toHaveLength(2);
      expect(s.acquisitions).toBe(acquired);
      // Serializable render inputs, with no Guest or runtime schema object in the envelope.
      expect(JSON.parse(JSON.stringify(visible))).toMatchObject([
        {
          title: "Approve this step",
          responseSchema: { type: "string", const: "approved" },
          scope: { phase: "body" },
        },
        {
          title: "Confirm resource release",
          responseSchema: { type: "object", required: ["action", "evidence"] },
          scope: { phase: "cleanup" },
        },
      ]);
      expect((await s.frontier("participant")).map((item) => item.contract)).toEqual(["approve"]);
      const target = {
        execution: repair.execution,
        contract: "repair" as const,
        grant: repair.grant,
      };
      await expect(
        s.submit(target, { action: "confirmed-released", evidence: "" }, "operator"),
      ).rejects.toThrow();
      await expect(
        s.submit(target, { action: "confirmed-released", evidence: "record" }, "participant"),
      ).rejects.toThrow("authorization");
      await expect(
        s.submit({ ...target, contract: "approve" }, "approved", "operator"),
      ).rejects.toThrow("contract mismatch");
      await expect(
        s.submit({ ...target, execution: approval.execution }, "approved", "operator"),
      ).rejects.toThrow();
      await expect(
        s.submit({ ...target, execution: "foreign-tree" }, {}, "operator"),
      ).rejects.toThrow("outside");
      expect((await s.frontier("operator")).map((item) => item.grant)).toEqual(
        visible.map((item) => item.grant),
      );
      const input = {
        action: "confirmed-released" as const,
        evidence: "external-release-record-7",
      };
      expect((await s.respond(target, input, "operator")).duplicate).toBe(false);
      s.reopen();
      expect((await s.respond(target, input, "operator")).duplicate).toBe(true);
      await expect(
        s.respond(target, { ...input, evidence: "different evidence" }, "operator"),
      ).rejects.toThrow();
      expect(await s.run().result).toMatchObject({ state: "child", reason: "waiting" });
      const remaining = await s.frontier("operator");
      expect(remaining).toHaveLength(1);
      expect(remaining[0]!.grant).toEqual(approval.grant);
      await s.respond(
        { execution: approval.execution, contract: "approve", grant: approval.grant },
        "approved",
        "participant",
      );
      expect(await s.run().result).toMatchObject({ state: "completed" });
      expect(await s.frontier("operator")).toEqual([]);
      expect(s.peer.requests).toHaveLength(1);
      const wrongType = () => {
        // @ts-expect-error Repair answers require evidence, not an approval value.
        return s.respond(target, "approved", "operator");
      };
      void wrongType;
    });
    it.each(["released", "denied", "unknown"] as const)(
      `${runtime.name}/${storage}: independent cleanup progresses while another waits for repair (%s)`,
      async (outcome) => {
        const s = scenario(true);
        const task = await s.begin();
        s.peer.reply("release", { status: 200, body: "denied" });
        await Promise.race([s.repairReady.promise, task.result]);
        const before = await s.observe();
        const repair = interaction(before, "repair");
        const otherId = s.peer.requests.find((request) => request.id === "release-other")!.token;
        expect(before.find((node) => node.execution === otherId)?.state).toMatchObject({
          status: "running",
          pending: { scope: { phase: "cleanup" } },
        });
        await s.cancel();
        if (outcome === "unknown") {
          s.peer.fail("release-other", new Error("uncertain independent release"));
          await expect(task.result).rejects.toThrow("uncertain independent release");
        } else {
          s.peer.reply("release-other", { status: 200, body: outcome });
          await task.result;
        }
        s.reopen();
        expect(await s.run().result).toMatchObject({
          state: "child",
          reason: outcome === "unknown" ? "occupied" : "waiting",
        });
        const acquired = s.acquisitions;
        s.reopen();
        const nodes = await s.observe();
        expect(s.acquisitions).toBe(acquired);
        expect(interaction(nodes, "repair").grant).toEqual(repair.grant);
        const other = nodes.find((node) => node.execution === otherId)!;
        if (outcome === "released") {
          // This branch finished its own cleanup without waiting for sibling repair.
          expect(other.state).toMatchObject({ status: "cancelled" });
        } else {
          expect(other.state).toMatchObject({
            status: "running",
            pending: { scope: { phase: "cleanup" } },
          });
        }
        await s.answer(repair.node, repair.grant);
        const report = await s.run().result;
        if (outcome === "denied") {
          expect(report).toMatchObject({ state: "child", reason: "waiting" });
          if (other.state.status !== "running" || other.state.interaction?.state !== "waiting") {
            throw new Error("Expected independent repair authority");
          }
          const remaining = interaction(await s.observe(), "repair");
          expect(remaining.node.execution).toBe(otherId);
          expect(remaining.grant).toEqual(other.state.interaction.grant);
          await s.answer(remaining.node, remaining.grant);
          expect(await s.run().result).toMatchObject({ state: "cancelled" });
        } else if (outcome === "unknown") {
          expect(report).toMatchObject({ state: "child", reason: "occupied" });
          expect((await s.observe())[0]!.state.status).toBe("running");
        } else {
          expect(report).toMatchObject({ state: "cancelled" });
        }
        expect(s.peer.requests.map((request) => request.id).sort()).toEqual([
          "release",
          "release-other",
        ]);
      },
    );
    it(`${runtime.name}/${storage}: occupied cleanup does not hide a sibling interaction`, async () => {
      const s = scenario();
      const task = await s.begin();
      s.peer.fail("release", new Error("unknown release outcome"));
      await expect(task.result).rejects.toThrow("unknown release outcome");
      s.reopen();
      expect(await s.run().result).toMatchObject({ state: "child", reason: "occupied" });
      const acquired = s.acquisitions;
      s.reopen();
      const nodes = await s.observe();
      expect(interaction(nodes, "approve")).toBeDefined();
      expect(
        nodes.some(
          (node) =>
            node.state.status === "running" &&
            node.state.interaction?.state === "waiting" &&
            requestSchema.parse(node.state.pending?.request).kind === "repair",
        ),
      ).toBe(false);
      expect(s.acquisitions).toBe(acquired);
      expect(s.peer.requests).toHaveLength(1);
    });
    it(`${runtime.name}/${storage}: yielding cleanup requires advancement before its repair appears`, async () => {
      const s = scenario();
      const task = await s.begin(true);
      s.peer.reply("release", { status: 200, body: "denied" });
      expect(await task.result).toEqual({ state: "yielded", reason: "one cleanup step" });
      s.reopen();
      const acquired = s.acquisitions;
      const yieldedView = await s.observe();
      expect(interaction(yieldedView, "approve")).toBeDefined();
      expect(() => interaction(yieldedView, "repair")).toThrow("Missing repair");
      expect(s.acquisitions).toBe(acquired);
      expect(await s.run().result).toMatchObject({ state: "child", reason: "waiting" });
      expect(interaction(await s.observe(), "repair")).toBeDefined();
      expect(s.peer.requests).toHaveLength(1);
    });
    it(`${runtime.name}/${storage}: tree cancellation revokes the body wait but preserves protected repair authority`, async () => {
      const s = scenario();
      const task = await s.begin();
      s.peer.reply("release", { status: 200, body: "denied" });
      await task.result;
      const nodes = await s.observe();
      const ordinary = interaction(nodes, "approve");
      const repair = interaction(nodes, "repair");
      await s.cancel();
      s.reopen();
      expect(interaction(await s.observe(), "repair").grant).toEqual(repair.grant);
      expect(await s.frontier("operator")).toMatchObject([
        {
          contract: "repair",
          grant: repair.grant,
          scope: { phase: "cleanup" },
          cancellation: { reason: "cancel tree" },
        },
      ]);
      await expect(s.answer(ordinary.node, ordinary.grant)).rejects.toThrow("revoked");
      expect(await s.run().result).toMatchObject({ state: "child", reason: "waiting" });
      await s.answer(repair.node, repair.grant);
      expect(await s.run().result).toMatchObject({ state: "cancelled", reason: "cancel tree" });
      expect(s.peer.requests).toHaveLength(1);
    });
  });
}
