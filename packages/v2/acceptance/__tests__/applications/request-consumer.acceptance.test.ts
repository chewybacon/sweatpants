import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { expect, it, onTestFinished } from "vitest";
import type { Operation, Outcome } from "@standard-durability/core";
import { createActivationIntents } from "@sweatpan.ts/durable";
import { createActivationReconciler } from "@sweatpan.ts/deployment";
import { createScopedGuest } from "@sweatpan.ts/execution";
import {
  createHosting,
  createJournalPresentation,
  type PresentationCursor,
} from "@sweatpan.ts/hosting";
import { createToolAdmission } from "@sweatpan.ts/tools";
import {
  createHostedRecovery,
  createLatch,
  createProtocolRig,
  createSqliteJournalRig,
} from "@sweatpan.ts/testing";
import type { Runtime } from "@sweatpan.ts/runtime";
import { forEachRuntime } from "../runtime/assembly.ts";

const cursor = z.object({
  execution: z.string(),
  position: z.number().int().nonnegative(),
  receipt: z.string().nullable(),
});
const commandSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("submit"),
    input: z.string(),
    budget: z.number().int().nonnegative().default(10),
  }),
  z.object({ kind: z.literal("resume"), budget: z.number().int().nonnegative().default(10) }),
  z.object({
    kind: z.literal("answer"),
    grant: z.object({ requestId: z.string(), resolutionId: z.string() }),
    answer: z.enum(["yes", "no"]),
  }),
  z.object({ kind: z.literal("observe"), after: cursor.optional(), end: cursor.optional() }),
]);
type Command = z.input<typeof commandSchema>;
// Application wire envelope: no raw Host result, pending request, or terminal value.
interface Page {
  execution: string;
  revision: number;
  state: string;
  report: string | null;
  entries: { sequence: number; receipt: string; value?: string; omitted?: "oversized" }[];
  after: PresentationCursor;
  end: PresentationCursor;
  more: boolean;
  interaction?: { requestId: string; resolutionId: string };
}

forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  function application() {
    const store = createSqliteJournalRig<string, string, string, string, unknown, Y>({
      program: "request:v1",
      equals: isDeepStrictEqual,
    });
    onTestFinished(() => store.close());
    const peer = createProtocolRig();
    let acquisitions = 0;
    let loseAnswerResponse = false;
    let cleanup: (() => Operation<void, Y>) | undefined;
    // Application wire projection, deliberately separate from accepted journal presentation.
    const projection = runtime.composition.createApi("response-projection", {
      *entries(page: Page): Operation<Page["entries"], Y> {
        return page.entries;
      },
    });
    function* installBoundedProjection() {
      yield* projection.around({
        *entries([page], next) {
          const entries = yield* next(page);
          if (new TextEncoder().encode(JSON.stringify({ ...page, entries })).byteLength <= 2048) {
            return entries;
          }
          return entries.map(({ sequence, receipt }) => ({
            sequence,
            receipt,
            omitted: "oversized" as const,
          }));
        },
      });
    }
    async function request(
      body: unknown,
      signal = new AbortController().signal,
      installProjection: () => Operation<void, Y> = installBoundedProjection,
    ): Promise<Response> {
      const incoming = new Request("http://local.test/execution", {
        method: "POST",
        body: JSON.stringify(body),
        signal,
      });
      const task = runtime.start(() =>
        runtime.withSignal(incoming.signal, function* () {
          yield* installProjection();
          const raw = yield* runtime.fromPromise(() => incoming.json());
          const parsed = commandSchema.parse(raw);
          const journal = store.open();
          const intents = createActivationIntents(
            runtime.composition,
            "request-intents",
            store.activations,
          );
          const admission = createToolAdmission(
            runtime,
            "request-admission",
            { id: "request:v1", context: z.string().trim().min(1) },
            journal,
          );
          let report: string | null = null;
          if (parsed.kind !== "observe") {
            if (parsed.kind === "submit") {
              yield* admission.operations.admit(parsed.input);
            }
            if (parsed.kind === "resume") {
              yield* intents.operations.request();
            }
            if (parsed.kind === "answer") {
              // This known application's answer schema is checked above. Production ingress
              // must additionally authorize the execution and supplied resolution authority.
              yield* journal.interactions.answer(parsed.grant, { ok: true, value: parsed.answer });
              if (loseAnswerResponse) {
                throw new Error("Response lost after answer acceptance");
              }
            }
            const admitted = yield* journal.read();
            if (!admitted.admission) {
              throw new Error("Not admitted");
            }
            const input = z.string().parse(admitted.admission.input);
            let settled = 0;
            const recovery = createHostedRecovery(runtime, {
              name: "request-recovery",
              program: "request:v1",
              matches: isDeepStrictEqual,
              *acquire() {
                acquisitions++;
                return createScopedGuest(function* () {
                  const sample: unknown = yield `sample:${input}`;
                  const answer: unknown = yield "approval";
                  return `${String(sample)}:${String(answer)}`;
                });
              },
            });
            const host = createHosting(runtime.composition, {
              name: "request-host",
              journal,
              recovery: recovery.operations,
              attempts: journal.attempts,
              interactions: journal.interactions,
              *handle(prompt: string): Operation<Outcome<string, string>, Y> {
                if (cleanup) {
                  yield* runtime.composition.ensure(cleanup);
                }
                const reply = yield* runtime.fromPromise((abort) =>
                  peer.send({ id: "sample", token: prompt }, abort),
                );
                return { ok: true, value: reply.body };
              },
            });
            yield* host.around({
              *continuation() {
                return settled >= (parsed.kind === "answer" ? 10 : parsed.budget)
                  ? { action: "yield", reason: "request budget" }
                  : { action: "continue" };
              },
              *deliveryMode([value]) {
                return value === "approval" ? "wait" : "execute";
              },
            });
            yield* host.attempts.around({
              *settle(args, next) {
                const result = yield* next(...args);
                settled++;
                return result;
              },
            });
            const reconciler = createActivationReconciler(
              runtime.composition,
              "request-reconciler",
              { intents, run: host.operations.run },
            );
            const result = yield* reconciler.operations.reconcile();
            report =
              result.state === "idle"
                ? "idle"
                : result.result.state === "occupied"
                  ? "attempt-held-may-be-active"
                  : result.result.state;
          }
          // Capture a finite accepted endpoint independently of later presentation reads.
          const snapshot = yield* journal.read();
          const end =
            parsed.kind === "observe" && parsed.end
              ? parsed.end
              : { execution: journal.id, ...snapshot.history.end };
          const after =
            parsed.kind === "observe" && parsed.after
              ? parsed.after
              : { execution: journal.id, position: 0, receipt: null };
          if (
            end.execution !== journal.id ||
            end.position > snapshot.history.end.position ||
            after.position > end.position
          ) {
            throw new Error("Invalid endpoint");
          }
          const anchor =
            end.position === 0 ? null : (yield* snapshot.history.at(end.position - 1))?.receipt;
          if (anchor !== end.receipt) {
            throw new Error("Invalid endpoint receipt");
          }
          const presentation = createJournalPresentation(
            runtime.composition,
            "request-presentation",
            journal,
          );
          const page = yield* presentation.operations.read(after, 1);
          const entries = page.entries.filter((entry) => entry.sequence < end.position);
          const next = entries.length ? page.after : after;
          const response: Page = {
            execution: journal.id,
            revision: page.state.revision,
            state: page.state.status,
            report,
            entries: entries.map((entry) => ({
              sequence: entry.sequence,
              receipt: entry.receipt,
              value: entry.outcome.ok ? entry.outcome.value : "failed",
            })),
            after: next,
            end,
            more: next.position < end.position,
            interaction:
              page.state.status === "running" && page.state.interaction?.state === "waiting"
                ? page.state.interaction.grant
                : undefined,
          };
          // Encoding and the hard cap remain transport invariants even with another policy.
          const projected = yield* projection.operations.entries(response);
          const encoded = JSON.stringify({ ...response, entries: projected });
          if (new TextEncoder().encode(encoded).byteLength > 2048) {
            throw new Error("Response too large");
          }
          return encoded;
        }),
      );
      void task.result.catch(() => undefined);
      onTestFinished(() => task.cancel());
      // All native work and cleanup have ended before a finite body is returned.
      return new Response(await task.result, { headers: { "Content-Type": "application/json" } });
    }
    return {
      store,
      peer,
      request,
      projection,
      get acquisitions() {
        return acquisitions;
      },
      set loseAnswerResponse(value: boolean) {
        loseAnswerResponse = value;
      },
      set cleanup(value: (() => Operation<void, Y>) | undefined) {
        cleanup = value;
      },
    };
  }
  async function page(response: Promise<Response>): Promise<Page> {
    return (await response).json() as Promise<Page>;
  }

  it(`${runtime.name}: finite request commands and Observe recover bounded accepted pages without response-read demand`, async () => {
    const app = application();
    const submitting = app.request({
      kind: "submit",
      input: "  question  ",
      budget: 1,
    } satisfies Command);
    await app.peer.waitForRequests(1);
    expect(app.peer.requests[0]!.token).toBe("sample:question");
    app.peer.reply("sample", { status: 200, body: "accepted sample" });
    const response = await submitting; // Body has not been read; the effect is already accepted.
    const initial = (await response.json()) as Page;
    expect(initial.report).toBe("yielded");
    expect(initial.entries).toHaveLength(1);
    const waiting = await page(app.request({ kind: "resume" }));
    expect(waiting.report).toBe("waiting");
    expect(waiting.interaction).toBeDefined();
    app.store.reopen();
    const visits = app.acquisitions;
    const observed = await page(app.request({ kind: "observe" }));
    expect(observed.interaction).toEqual(waiting.interaction);
    expect(app.acquisitions).toBe(visits);
    await expect(
      app.request({ kind: "answer", grant: waiting.interaction, answer: "invalid" }),
    ).rejects.toBeDefined();
    app.loseAnswerResponse = true;
    await expect(
      app.request({ kind: "answer", grant: waiting.interaction, answer: "yes" }),
    ).rejects.toThrow("Response lost");
    app.store.reopen();
    app.loseAnswerResponse = false;
    const completed = await page(app.request({ kind: "resume" }));
    expect(completed.report).toBe("completed");
    expect(completed.entries).toHaveLength(1);
    expect(completed.more).toBe(true);
    // Concurrent ingress extended history, but the first endpoint cannot grow with it.
    const old = await page(
      app.request({ kind: "observe", after: initial.after, end: initial.end }),
    );
    expect(old.entries).toEqual([]);
    expect(old.more).toBe(false);
    const suffix = await page(
      app.request({ kind: "observe", after: completed.after, end: completed.end }),
    );
    expect(suffix.entries.map((entry) => entry.value)).toEqual(["yes"]);
    expect(suffix.more).toBe(false);
    expect(app.peer.requests).toHaveLength(1);
    await expect(
      app.request({ kind: "observe", end: { ...completed.end, receipt: "wrong" } }),
    ).rejects.toThrow("Invalid endpoint receipt");
    const drained = await page(app.request({ kind: "resume" }));
    expect(drained.report).toBe("completed");
    const idle = await page(app.request({ kind: "submit", input: "question" })); // Duplicate admission writes no new intent.
    expect(idle.report).toBe("idle");
    expect(idle.state).toBe("completed");
  });

  it(`${runtime.name}: request abort joins cleanup, and Resume reports an occupied attempt without retry`, async () => {
    const app = application();
    const cleaning = createLatch<void>();
    const release = createLatch<void>();
    app.cleanup = function* () {
      cleaning.resolve();
      yield* runtime.fromPromise(() => release.promise);
    };
    onTestFinished(() => release.resolve());
    const abort = new AbortController();
    const task = app.request({ kind: "submit", input: "question" }, abort.signal);
    let finished = false;
    void task.then(
      () => {
        finished = true;
      },
      () => {
        finished = true;
      },
    );
    await app.peer.waitForRequests(1);
    const concurrent = await page(app.request({ kind: "resume" }));
    expect(concurrent.report).toBe("attempt-held-may-be-active");
    abort.abort(new Error("Client disconnected"));
    await cleaning.promise;
    expect(finished).toBe(false);
    release.resolve();
    await expect(task).rejects.toBeDefined();
    app.store.reopen();
    expect((await page(app.request({ kind: "resume" }))).report).toBe("attempt-held-may-be-active");
    expect(app.peer.requests).toHaveLength(1);
  });

  it(`${runtime.name}: pre-aborted ingress writes nothing and oversized projection does not lose accepted data`, async () => {
    const app = application();
    const abort = new AbortController();
    abort.abort();
    await expect(
      app.request({ kind: "submit", input: "question" }, abort.signal),
    ).rejects.toBeDefined();
    expect(app.acquisitions).toBe(0);
    const read = runtime.start(() => app.store.open().read());
    expect((await read.result).admission).toBeUndefined();
    const zero = await page(app.request({ kind: "submit", input: "question", budget: 0 }));
    expect(zero.report).toBe("yielded");
    expect(app.acquisitions).toBe(0);
    const task = app.request({ kind: "resume" });
    void task.catch(() => undefined);
    await app.peer.waitForRequests(1);
    app.peer.reply("sample", { status: 200, body: "x".repeat(4096) });
    const response = await task;
    const encoded = await response.text();
    expect(new TextEncoder().encode(encoded).byteLength).toBeLessThanOrEqual(2048);
    const waiting = JSON.parse(encoded) as Page;
    expect(waiting.entries[0]?.omitted).toBe("oversized");
    expect(waiting.after.position).toBe(1);
    expect(waiting.interaction).toBeDefined();
    app.store.reopen();
    const retained = await runtime.start(function* () {
      const snapshot = yield* app.store.open().read();
      return { end: snapshot.history.end, entry: yield* snapshot.history.at(0) };
    }).result;
    expect(retained.end.position).toBe(1);
    expect(retained.entry?.outcome).toEqual({ ok: true, value: "x".repeat(4096) });
    const observed = await page(app.request({ kind: "observe" }));
    expect(observed.entries[0]?.omitted).toBe("oversized");
    expect(observed.interaction).toEqual(waiting.interaction);
    // A different scoped policy may summarize; the next request restores the default.
    const summarized = await page(
      app.request({ kind: "observe" }, undefined, function* () {
        yield* app.projection.around({
          *entries([input], next) {
            const entries = yield* next(input);
            return entries.map(({ sequence, receipt }) => ({
              sequence,
              receipt,
              value: "summary",
            }));
          },
        });
      }),
    );
    expect(summarized.entries[0]?.value).toBe("summary");
    expect(summarized.after).toEqual(observed.after);
    expect(summarized.interaction).toEqual(observed.interaction);
    await expect(app.request({ kind: "observe" }, undefined, function* () {})).rejects.toThrow(
      "Response too large",
    );
    expect((await page(app.request({ kind: "observe" }))).entries[0]?.omitted).toBe("oversized");
    await page(app.request({ kind: "answer", grant: observed.interaction, answer: "yes" }));
    const suffix = await page(app.request({ kind: "observe", after: observed.after }));
    expect(suffix.entries.map((entry) => entry.value)).toEqual(["yes"]);
    expect(suffix.more).toBe(false);
    expect(app.peer.requests).toHaveLength(1);
  });
});
