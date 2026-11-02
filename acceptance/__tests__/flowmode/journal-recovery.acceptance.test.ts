// @vitest-environment node
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createKernelProgramBundle } from "@sweatpants/flowmode-backend";
import { luaIdentity } from "@sweatpants/flowmode-runtime-lua/kernel";
import {
  activateJournal,
  success,
  failure,
  type Identity,
  type Json,
  type RequestOccurrence,
} from "@sweatpants/primitive-journal";
import { SqliteJournal } from "@sweatpants/primitive-journal/sqlite";
import { createPrimitiveLuaWork, type KernelTrace } from "../../support/primitive-flowmode.ts";
import { run } from "effection";
import { describe, expect, it } from "vitest";
import {
  compileReview,
  flowmodeLanguages,
  flowmodeStack,
  linkReview,
} from "../../support/flowmode.ts";
import { openStorageRig, storageVariants } from "../../support/storage/index.ts";
import { useProgramRig } from "../../support/program.ts";

describe.each(flowmodeLanguages)("%s durable driver", (language) => {
  it.each(storageVariants)(
    "recovers approval and cleanup from the %s journal with fresh drivers",
    async (variant) => {
      const storage = await openStorageRig(variant);
      try {
        const connection = await storage.open();
        if (connection.storage.kind !== "custom") {
          throw new Error("Expected composed storage");
        }
        const store = connection.storage.executionStore;
        await run(function* () {
          // Arrange: developer source and caller become a pinned durable program.
          const stack = flowmodeStack(language);
          const definition = yield* compileReview(stack.developerCompiler);
          const options = yield* linkReview(stack, definition);
          const program = stack.createProgram(options);
          const first = yield* useProgramRig(store, program, { title: "Publish?" });
          yield* first.journal.advance({
            type: "execution.open-task",
            request: {
              ...first.attach,
              turnId: "turn",
              manifest: program.manifest,
              attachmentId: "unattached",
              audience: "acceptance",
            },
          });

          // Act: the shared driver persists the compiled tool's approval request.
          const approval = yield* first.advance();
          expect(approval.state).toBe("parked");
          if (approval.state !== "parked") {
            throw new Error("Expected approval park");
          }
          const records = yield* first.journal.readSession(first.attach.sessionId);
          expect(
            records
              .filter((entry) => entry.payload.type === "PullRequested")
              .map((entry) => entry.payload),
          ).toMatchObject([
            { descriptor: { kind: "elicit", key: "approval", message: "Publish?" } },
          ]);
          const capability = yield* first.journal.query({
            type: "pull.resolution-capability",
            sessionId: first.attach.sessionId,
            taskId: "root",
            pullId: approval.pullId,
          });
          const accepted = yield* first.journal.advance({
            type: "execution.resolve-pull",
            request: {
              capability,
              audience: "user:approval",
              outcome: { status: "ok", value: { action: "accept", content: { approved: true } } },
            },
          });
          expect(accepted.status).not.toBe("rejected");

          // Act: reconstruct program, authority and driver; cleanup must still run.
          const second = yield* useProgramRig(store, stack.createProgram(options), {
            title: "Publish?",
          });
          const cleanup = yield* second.advance();
          expect(cleanup.state).toBe("parked");
          if (cleanup.state !== "parked") {
            throw new Error("Expected cleanup park");
          }
          expect(cleanup.pullId).not.toBe(approval.pullId);
          const cleanupCapability = yield* second.journal.query({
            type: "pull.resolution-capability",
            sessionId: second.attach.sessionId,
            taskId: "root",
            pullId: cleanup.pullId,
          });
          const released = yield* second.journal.advance({
            type: "execution.resolve-pull",
            request: {
              capability: cleanupCapability,
              audience: "user:cleanup",
              outcome: { status: "ok", value: { action: "accept", content: { approved: true } } },
            },
          });
          expect(released.status).not.toBe("rejected");

          // Assert: another replacement completes without duplicating accepted pulls.
          const third = yield* useProgramRig(store, stack.createProgram(options), {
            title: "Publish?",
          });
          expect(yield* third.advance()).toEqual({ state: "completed", value: "approved" });
          const journal = yield* third.journal.readSession(third.attach.sessionId);
          expect(
            journal
              .filter((entry) => entry.payload.type === "PullRequested")
              .map((entry) => entry.payload),
          ).toMatchObject([
            { descriptor: { kind: "elicit", key: "approval" } },
            { descriptor: { kind: "elicit", key: "cleanup" } },
          ]);
        });
      } finally {
        await storage.close();
      }
    },
  );
});

it("recovers compiled approval and cleanup with primitive Lua + SQLite", async () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const artifacts = join(root, ".artifacts/primitive-journal");
  mkdirSync(artifacts, { recursive: true });
  const directory = mkdtempSync(join(artifacts, "lua-pending-"));
  const path = join(directory, "journal.sqlite");
  const traces: KernelTrace[] = [];
  const phases: unknown[] = [];
  const prepared = await run(function* () {
    const stack = flowmodeStack("lua");
    const definition = yield* compileReview(stack.developerCompiler);
    const options = yield* linkReview(stack, definition);
    const bundle = createKernelProgramBundle(
      options.implementation,
      luaIdentity,
      options.contract,
      options.bindings,
    );
    return { options, bundle };
  });
  const { options, bundle } = prepared;
  const identity: Identity = {
    executionId: "primitive-lua-review",
    program: {
      id: bundle.manifest.programId,
      version: bundle.manifest.version,
      digest: bundle.manifest.digest,
    },
    input: { title: "Publish?" },
  };
  function state(journal: SqliteJournal) {
    return structuredClone({ snapshot: journal.read(), requests: journal.readRequests() });
  }
  function observe(phase: string, journal: SqliteJournal) {
    const saved = state(journal);
    phases.push({ phase, ...saved });
    return saved;
  }
  function reopen<T>(use: (journal: SqliteJournal) => T): T {
    const journal = new SqliteJournal(path, identity);
    try {
      return use(journal);
    } finally {
      journal.close();
    }
  }
  async function activate(phase: string) {
    const journal = new SqliteJournal(path, identity);
    const trace: KernelTrace = { phase, events: [] };
    traces.push(trace);
    try {
      const result = await run(function* () {
        return yield* activateJournal(
          createPrimitiveLuaWork(bundle, identity, options.bindOperation, trace),
          journal,
        );
      });
      return { result, saved: observe(phase, journal) };
    } finally {
      journal.close();
    }
  }
  function parked(result: Awaited<ReturnType<typeof activate>>["result"]): RequestOccurrence {
    expect(result.state).toBe("parked");
    if (result.state !== "parked") {
      throw new Error("Expected durable parked request");
    }
    return result.request;
  }
  const answer = success({ action: "accept", content: { approved: true } });
  try {
    const first = await activate("approval");
    const approval = parked(first.result);
    expect(approval).toMatchObject({
      sequence: 0,
      status: "pending",
      request: {
        descriptor: { kind: "elicit", key: "approval", message: "Publish?" },
      },
    });
    expect(first.saved).toEqual({
      snapshot: { identity, entries: [], attempts: [], status: "running" },
      requests: [approval],
    });

    const repeated = await activate("approval-reopened");
    expect(repeated.result).toEqual(first.result);
    expect(repeated.saved).toEqual(first.saved);
    expect(traces).toHaveLength(2);
    reopen((journal) => {
      expect(() => journal.begin(0, approval.request, "repeatable")).toThrow(/excludes/);
      expect(state(journal)).toEqual(first.saved);
      expect(() => journal.accept(0, approval.request, answer)).toThrow(/started attempt/);
      expect(state(journal)).toEqual(first.saved);
      expect(() => journal.park(0, { changed: true })).toThrow(/mismatch/);
      expect(state(journal)).toEqual(first.saved);
      expect(() => journal.complete(0, "premature")).toThrow(/Unresolved request/);
      expect(state(journal)).toEqual(first.saved);
      expect(() => journal.acceptRequest(approval.id, success(Number.NaN))).toThrow(/finite JSON/);
      expect(observe("invalid-ingress-rejected", journal)).toEqual(first.saved);
    });
    const acceptedApproval = reopen((journal) => {
      expect(state(journal)).toEqual(first.saved);
      const entry = journal.acceptRequest(approval.id, answer);
      expect(entry).toEqual({ sequence: 0, request: approval.request, outcome: answer });
      const accepted = observe("approval-accepted", journal);
      expect(accepted).toEqual({
        snapshot: {
          identity,
          entries: [entry],
          attempts: [],
          status: "running",
        },
        requests: [{ ...approval, status: "accepted" }],
      });
      expect(journal.acceptRequest(approval.id, answer)).toEqual(entry);
      expect(state(journal)).toEqual(accepted);
      expect(() => journal.acceptRequest(approval.id, failure("conflicting answer"))).toThrow(
        /Conflicting/,
      );
      expect(state(journal)).toEqual(accepted);
      expect(() => journal.acceptRequest("unknown-request", answer)).toThrow(/Unknown/);
      expect(state(journal)).toEqual(accepted);
      return entry;
    });
    expect(traces).toHaveLength(2);

    const second = await activate("cleanup");
    const cleanup = parked(second.result);
    expect(cleanup.id).not.toBe(approval.id);
    expect(cleanup).toMatchObject({
      sequence: 1,
      status: "pending",
      request: {
        descriptor: { kind: "elicit", key: "cleanup", message: "Release reservation?" },
      },
    });
    expect(second.saved).toEqual({
      snapshot: {
        identity,
        entries: [acceptedApproval],
        attempts: [],
        status: "running",
      },
      requests: [{ ...approval, status: "accepted" }, cleanup],
    });
    const cleanupRepeated = await activate("cleanup-reopened");
    expect(cleanupRepeated.result).toEqual(second.result);
    expect(cleanupRepeated.saved).toEqual(second.saved);
    reopen((journal) => {
      expect(journal.acceptRequest(approval.id, answer)).toEqual(acceptedApproval);
      expect(observe("old-approval-retried", journal)).toEqual(second.saved);
    });
    expect(traces).toHaveLength(4);
    const acceptedCleanup = reopen((journal) => {
      const entry = journal.acceptRequest(cleanup.id, answer);
      expect(entry).toEqual({ sequence: 1, request: cleanup.request, outcome: answer });
      expect(observe("cleanup-accepted", journal)).toEqual({
        snapshot: {
          identity,
          entries: [acceptedApproval, entry],
          attempts: [],
          status: "running",
        },
        requests: [
          { ...approval, status: "accepted" },
          { ...cleanup, status: "accepted" },
        ],
      });
      return entry;
    });
    expect(traces).toHaveLength(4);
    const third = await activate("completed");
    expect(third.result).toEqual({ state: "completed", value: "approved" });
    expect(third.saved).toEqual({
      snapshot: {
        identity,
        entries: [acceptedApproval, acceptedCleanup],
        attempts: [],
        status: "completed",
        value: "approved",
      },
      requests: [
        { ...approval, status: "accepted" },
        { ...cleanup, status: "accepted" },
      ],
    });
    const completedReplay = await activate("completed-reopened");
    expect(completedReplay.result).toEqual(third.result);
    expect(completedReplay.saved).toEqual(third.saved);
    reopen((journal) => {
      expect(journal.acceptRequest(approval.id, answer)).toEqual(acceptedApproval);
      expect(journal.acceptRequest(cleanup.id, answer)).toEqual(acceptedCleanup);
      expect(observe("completed-answers-retried", journal)).toEqual(third.saved);
    });

    const boundaryKeys = [
      ["Publish?"],
      ["Publish?"],
      ["Publish?", "Release reservation?"],
      ["Publish?", "Release reservation?"],
      ["Publish?", "Release reservation?", "completed"],
      ["Publish?", "Release reservation?", "completed"],
    ];
    expect(traces.map(({ phase }) => phase)).toEqual([
      "approval",
      "approval-reopened",
      "cleanup",
      "cleanup-reopened",
      "completed",
      "completed-reopened",
    ]);
    const activationIds: string[] = [];
    for (const [index, trace] of traces.entries()) {
      // Decode the recorded JSON only for assertions; it never drives the guest.
      const events = trace.events as {
        event: string;
        boundary?: { kind: string; suspensionId?: string; request?: { input: Json } };
        suspensionId?: string;
        reply?: Json;
      }[];
      const boundaries = events
        .filter((event) => event.event === "boundary")
        .map((event) => event.boundary!);
      expect(
        boundaries.map((boundary) =>
          boundary.kind === "suspended"
            ? (boundary.request!.input as { message: string }).message
            : boundary.kind,
        ),
      ).toEqual(boundaryKeys[index]);
      const resumeCount = index < 2 ? 0 : index < 4 ? 1 : 2;
      expect(events.map((event) => event.event)).toEqual([
        "allocate",
        "start",
        "boundary",
        ...Array.from({ length: resumeCount }, () => ["resume", "boundary"]).flat(),
        "dispose",
        "close",
      ]);
      const resumes = events.filter((event) => event.event === "resume");
      expect(resumes).toEqual(
        boundaries.slice(0, resumeCount).map((boundary) => ({
          event: "resume",
          suspensionId: boundary.suspensionId,
          reply: { kind: "value", value: answer.ok ? answer.value : null },
        })),
      );
      const nativeId = boundaries[0].suspensionId!;
      activationIds.push(nativeId.slice(0, nativeId.lastIndexOf(":")));
      expect([approval.id, cleanup.id]).not.toContain(nativeId);
    }
    expect(new Set(activationIds).size).toBe(6);
  } finally {
    writeFileSync(
      join(directory, "evidence.json"),
      JSON.stringify({ identity, bundle, phases, traces }, null, 2),
    );
  }
});
